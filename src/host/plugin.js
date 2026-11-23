import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Store } from './state.js'
import {
  addMember,
  createRoom,
  dissolveRoom,
  getMember,
  getRoom,
  markRead,
  postMessage,
  removeMember,
  updateMember,
  updateRoom,
} from './rooms.js'
import { createBotRunner } from './turn.js'
import { createSpeaker } from './speak.js'
import { createGate, LEVELS } from './guard.js'
import { createLanBridge } from './lan-bridge.js'
import { markApplied } from './code.js'
import { isWhaleColor, freeWhale } from './palette.js'
import { pageMessages, project } from './project.js'

export { project } from './project.js'

/**
 * 一个新 agent 该是哪种颜色：挑过的照挑的存，没挑就从「这台机器还没人用的」里拿一个。
 *
 * 为什么不是「第几个 agent 就第几种」：每个人都是自己机器上的第一个 agent，
 * 按序号铺的话别人的 agent 和我的会是同一种颜色 —— 屋里看过去全是一个色。
 */
function nextBotColor(state, wanted) {
  if (isWhaleColor(wanted)) return wanted
  const taken = new Set()
  if (isWhaleColor(state.self?.color)) taken.add(state.self.color)
  for (const bot of state.bots ?? []) if (isWhaleColor(bot.color)) taken.add(bot.color)
  return freeWhale(taken)
}

export const name = 'dsh-chatroom'

/**
 * 只写「没有它这个插件就没有意义」的服务：
 *   connection   —— 客户端与 Host 之间唯一被鉴权的通道（/api 载体）
 *   profileContext —— 房间状态该落在哪个 profile 目录下
 * 其余的（agents / sessions / sessionPersistence / agentDefaultModel）用 ctx.get
 * 惰性取：缺一个不该让整个插件起不来，只是那部分能力暂时用不了。
 */
export const inject = ['connection', 'profileContext']

const MAX_BODY_BYTES = 9 * 1024 * 1024
const PUBLIC_CODE = /^[a-z][a-z0-9_]{0,79}$/

const log = (...args) => console.warn('[dsh-chatroom]', ...args)

function publicError(error, signal) {
  const code = typeof error?.code === 'string' && PUBLIC_CODE.test(error.code)
    ? error.code
    : signal?.aborted
      ? 'cancelled'
      : 'internal_error'
  return { code, message: error?.message ? String(error.message).slice(0, 400) : '操作未完成。' }
}

/** 从别的机器同步过来的房间：规则、成员、解散都得在那台机器上改。 */
function assertLocal(room, action) {
  if (!room?.remote) return room
  throw Object.assign(new Error(`这间屋子在 ${room.remote.machine || room.remote.host} 上，${action}要在那台机器上做。`), {
    code: 'remote_room',
  })
}

/**
 * 界面往回翻历史。
 *
 * 本机房间直接读自己的库；镜像房间（加入方的屋子）本机只存着宿主发过来的那 200 条，
 * 再往前的东西只有宿主有，所以要连着 LAN 问它要 —— 但**用这条链接自己的凭据**，
 * 而且宿主那边只认 peer 绑定的那个房间，请求里说的 roomId 只能用来做本地定位。
 */
async function messagesPage({ store, lan, payload }) {
  const room = store.state.rooms.find((row) => row.id === String(payload?.roomId ?? ''))
  if (!room) throw Object.assign(new Error('找不到这间屋子。'), { code: 'room_not_found' })
  if (!room.remote) return pageMessages(room, payload)
  if (!lan) throw Object.assign(new Error('LAN 不可用'), { code: 'lan_unavailable' })
  return lan.page({ roomId: room.id, beforeSeq: payload?.beforeSeq, limit: payload?.limit })
}

export async function dispatch({ store, speaker, gate = null, lan = null, command }) {
  const action = String(command?.action ?? '')
  const input = command?.input && typeof command.input === 'object' ? command.input : {}
  const state = store.state
  const roomOf = (roomId) => getRoom(state, roomId)

  switch (action) {
    case 'room.create': {
      store.commit((draft) => createRoom(draft, { name: input.name, topic: input.topic }))
      break
    }
    case 'room.update': {
      assertLocal(roomOf(input.roomId), '改规则')
      store.commit((draft) =>
        updateRoom(draft, { roomId: input.roomId, name: input.name, topic: input.topic, rules: input.rules }),
      )
      break
    }
    case 'room.dissolve': {
      assertLocal(roomOf(input.roomId), '解散')
      store.commit((draft) => dissolveRoom(draft, { roomId: input.roomId }))
      // 屋子都没了，还在跑的那一轮不用再等下去：模型/远程那边能停就停，
      // 省掉一段没人会看见的等待，也不会在它收尾时把 agent 标成「上次失败」。
      speaker?.stop(input.roomId)
      break
    }
    case 'room.activate': {
      const room = getRoom(state, input.roomId)
      if (!room) throw Object.assign(new Error('room_not_found'), { code: 'room_not_found' })
      store.commit((draft) => {
        draft.activeRoomId = room.id
      })
      break
    }
    case 'bot.create': {
      /**
       * 建一个 agent，但不绑定房间。
       *
       * 为什么需要它：加入别人的屋子时，能带进屋的只有**加入前就已经存在**的 agent。
       * 新装的机器上一个都没有，人只能先在自己屋里建一个再退出来加入 —— 这一步没人猜得到。
       * 所以面板上给一个「我的 agent」，建完就报给宿主（这台机器如果正在别人的屋里）。
       * 顺手能带房间：在本地房间里点新建，本来就期待它马上出现在屋里。
       */
      const bot = {
        id: `bot_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        name: String(input.name ?? '').trim().slice(0, 60) || '新 agent',
        role: String(input.role ?? '').trim().slice(0, 200),
        // 没挑就用「这台机器上还没人用的」那种：建三个 agent 都是同一个颜色，
        // 这个选择就白做了。挑过的照挑的存。
        color: nextBotColor(store.state, input.color),
        // 是不是人自己点的：点过的不许在进屋时被换成别的（见 lan-host 的 roomColor）。
        colorPicked: isWhaleColor(input.color),
        sessionId: randomUUID(),
        cwd: null,
        createdAt: new Date().toISOString(),
        lastError: null,
        lastSpokeAt: null,
      }
      store.commit((draft) => {
        draft.bots.push(bot)
        if (!input.roomId) return
        const room = getRoom(draft, input.roomId)
        // 镜像房间的成员在宿主那边：这里补不进去，交给 announceAgents 报上去。
        if (!room || room.remote) return
        addMember(draft, {
          roomId: room.id,
          member: { id: `m_${bot.id}`, kind: 'bot', name: bot.name, role: bot.role, botId: bot.id, sessionId: bot.sessionId },
        })
      })
      if (lan && (state.links ?? []).length) await lan.announceAgents()
      break
    }
    case 'member.createBot': {
      assertLocal(roomOf(input.roomId), '加 agent')
      store.commit((draft) => {
        const bot = {
          id: `bot_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: String(input.name ?? '').trim().slice(0, 60) || '新 agent',
          role: String(input.role ?? '').trim().slice(0, 200),
          color: nextBotColor(draft, input.color),
          colorPicked: isWhaleColor(input.color),
          sessionId: randomUUID(),
          cwd: null,
          createdAt: new Date().toISOString(),
          lastError: null,
          lastSpokeAt: null,
        }
        draft.bots.push(bot)
        addMember(draft, {
          roomId: input.roomId,
          member: { id: `m_${bot.id}`, kind: 'bot', name: bot.name, role: bot.role, botId: bot.id, sessionId: bot.sessionId },
        })
      })
      break
    }
    case 'member.addBot': {
      assertLocal(roomOf(input.roomId), '加 agent')
      store.commit((draft) => {
        const bot = draft.bots.find((row) => row.id === input.botId)
        if (!bot) throw Object.assign(new Error('bot_not_found'), { code: 'bot_not_found' })
        addMember(draft, {
          roomId: input.roomId,
          member: { id: `m_${bot.id}`, kind: 'bot', name: bot.name, role: bot.role, botId: bot.id, sessionId: bot.sessionId },
        })
      })
      break
    }
    case 'member.addHuman': {
      assertLocal(roomOf(input.roomId), '加人')
      store.commit((draft) => {
        addMember(draft, {
          roomId: input.roomId,
          member: {
            id: input.id ?? `h_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
            kind: 'human',
            name: input.name,
            role: input.role,
            origin: input.origin,
            reach: input.origin?.kind === 'lan' ? 'lan' : 'here',
          },
        })
      })
      break
    }
    case 'member.update': {
      assertLocal(roomOf(input.roomId), '改成员')
      store.commit((draft) =>
        updateMember(draft, { roomId: input.roomId, memberId: input.memberId, patch: input.patch }),
      )
      break
    }
    case 'member.remove': {
      assertLocal(roomOf(input.roomId), '移出成员')
      store.commit((draft) => removeMember(draft, { roomId: input.roomId, memberId: input.memberId }))
      break
    }
    case 'msg.send': {
      const target = roomOf(input.roomId)
      if (target?.remote) {
        // 镜像房间的消息必须落回宿主，否则两台机器各有一份「我说过的话」。
        if (!lan) throw Object.assign(new Error('LAN 不可用'), { code: 'lan_unavailable' })
        await lan.send({
          roomId: target.id,
          text: input.text,
          mentions: input.mentions,
          replyTo: input.replyTo,
          opKey: input.opKey,
        })
        break
      }
      let posted = null
      store.commit((draft) => {
        posted = postMessage(draft, {
          roomId: input.roomId,
          authorId: draft.self.id,
          text: input.text,
          mentions: input.mentions,
          replyTo: input.replyTo,
          origin: { kind: 'local' },
          opKey: input.opKey,
        })
      })
      if (posted) speaker.afterHumanMessage({ roomId: input.roomId, messageId: posted.id })
      break
    }
    case 'msg.retry': {
      const retryRoom = assertLocal(roomOf(input.roomId), '重试')
      const message = retryRoom.messages.find((row) => row.seq === input.seq)
      if (!message) throw Object.assign(new Error('message_not_found'), { code: 'message_not_found' })
      if (message.authorKind !== 'bot') throw Object.assign(new Error('只能让 agent 重说'), { code: 'not_agent_message' })
      speaker.retryBot({ roomId: input.roomId, memberId: message.authorId })
      break
    }
    case 'round.run': {
      assertLocal(roomOf(input.roomId), '发起全员发言')
      speaker.runRound({ roomId: input.roomId })
      break
    }
    case 'round.stop': {
      speaker.stop(input.roomId)
      break
    }
    case 'auth.set': {
      /**
       * 本机授权三档：只读 / 授权后执行 / 完全授权。
       *
       * 只影响这台机器：别的机器派过来的回合要不要执行，是每台机器自己的事。
       * 所以它不跟着房间投影走，也不许在镜像房间那边替宿主改（那是另一台机器的安全设置）。
       */
      if (!gate) throw Object.assign(new Error('授权服务不可用'), { code: 'gate_unavailable' })
      const level = String(input.level ?? '')
      if (!LEVELS.includes(level)) throw Object.assign(new Error('未知的授权档位'), { code: 'bad_level' })
      gate.setLevel(level)
      break
    }
    case 'auth.answer': {
      if (!gate) throw Object.assign(new Error('授权服务不可用'), { code: 'gate_unavailable' })
      const decided = gate.answer({ id: input.id, allow: Boolean(input.allow) })
      // 已经超时或被另一处点掉：不是错误，界面上那张卡本来就该自己消失。
      if (!decided) throw Object.assign(new Error('这条请求已经结束了'), { code: 'approval_expired' })
      break
    }
    case 'read.mark': {
      const target = roomOf(input.roomId)
      if (target?.remote) {
        if (!lan) throw Object.assign(new Error('LAN 不可用'), { code: 'lan_unavailable' })
        await lan.read({ roomId: target.id, seq: Number(input.seq) })
        break
      }
      store.commit((draft) => markRead(draft, { roomId: input.roomId, memberId: draft.self.id, seq: input.seq }))
      break
    }
    case 'lan.join': {
      if (!lan) throw Object.assign(new Error('LAN 不可用'), { code: 'lan_unavailable' })
      await lan.join({ host: input.host, port: input.port, code: input.code, machine: input.machine })
      break
    }
    case 'lan.leave': {
      if (!lan) throw Object.assign(new Error('LAN 不可用'), { code: 'lan_unavailable' })
      await lan.leave(input.linkId)
      break
    }
    case 'self.rename': {
      store.commit((draft) => {
        const label = String(input.name ?? '').trim().slice(0, 60)
        if (!label) throw Object.assign(new Error('名字不能为空'), { code: 'name_required' })
        draft.self.name = label
        for (const room of draft.rooms) {
          if (room.remote) continue
          const member = getMember(room, draft.self.id)
          if (member) member.name = label
        }
      })
      // 镜像房间里「我」这个名字在宿主那边：改完得告诉它，否则对面看到的还是旧名字。
      // 这里只报名字：颜色只在他点过的时候才报，否则会把宿主定的「屋里不撞色」冲掉。
      if (lan && (state.links ?? []).length) await lan.rename(state.self.name)
      break
    }
    case 'self.color': {
      /**
       * 换我这只虎鲸的颜色。
       *
       * 为什么单独一个动作、而不是塞进 self.rename：改名是「失焦就提交」的输入框，
       * 点色块是另一个动作。混在一起，点一下颜色也会跑一次改名 —— 那么两个动作
       * 都得等对方回一个包，点第二下就卡在第一次上。
       *
       * 颜色只在本机与自己的成员上生效，不随房间规则走：换屋子不该换颜色。
       */
      store.commit((draft) => {
        if (!isWhaleColor(input.color)) throw Object.assign(new Error('颜色不在可选范围内'), { code: 'bad_color' })
        draft.self.color = input.color
        draft.self.colorPicked = true
        for (const room of draft.rooms) {
          if (room.remote) continue
          const member = getMember(room, draft.self.id)
          if (member) member.color = input.color
        }
      })
      if (lan && (state.links ?? []).length) await lan.rename(state.self.name, state.self.color)
      break
    }
    case 'bot.update': {
      store.commit((draft) => {
        const bot = draft.bots.find((row) => row.id === input.botId)
        if (!bot) throw Object.assign(new Error('bot_not_found'), { code: 'bot_not_found' })
        if (input.name !== undefined) bot.name = String(input.name).trim().slice(0, 60) || bot.name
        if (input.role !== undefined) bot.role = String(input.role).trim().slice(0, 200)
        if (input.color !== undefined && isWhaleColor(input.color)) {
          bot.color = input.color
          bot.colorPicked = true
        }
        for (const room of draft.rooms) {
          if (room.remote) continue
          const member = room.members.find((row) => row.botId === bot.id)
          if (member) {
            member.name = bot.name
            member.role = bot.role
            // 只搬一个合法的色：bot 上没色时（旧存档、直接塞进 state 的种子数据）
            // 把 undefined 搬进成员里，界面就会退回默认色 —— 一次改名把整屋颜色弄白。
            if (isWhaleColor(bot.color)) member.color = bot.color
          }
        }
      })
      // 名字/职责改了也要让宿主那边跟着变，否则对面看到的还是旧名字。
      if (lan && (state.links ?? []).length) await lan.announceAgents()
      break
    }
    case 'bot.remove': {
      /**
       * 删掉一个 agent（连同它在本地房间里的成员身份）。
       *
       * 只在「我的 agent」里给入口：成员列的「移出房间」只是把它从这一间屋子挪走，
       * agent 本身还在，别的屋子还用得上。删掉之后如果这台机器正在别人的屋里，
       * 也得让宿主知道 —— 否则对面会一直留着一个不回话的成员。
       */
      store.commit((draft) => {
        const bot = draft.bots.find((row) => row.id === input.botId)
        if (!bot) throw Object.assign(new Error('bot_not_found'), { code: 'bot_not_found' })
        draft.bots = draft.bots.filter((row) => row.id !== bot.id)
        for (const room of draft.rooms) {
          if (room.remote) continue
          for (const member of room.members.filter((row) => row.botId === bot.id)) {
            removeMember(draft, { roomId: room.id, memberId: member.id })
          }
        }
      })
      if (lan && (state.links ?? []).length) await lan.announceAgents()
      break
    }
    default:
      throw Object.assign(new Error(`未知操作：${action}`), { code: 'unknown_action' })
  }

  return lan ? lan.view() : project(store.state)
}

function waitForChange(store, since, signal, timeoutMs = 25_000) {
  if (store.state.revision !== since) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    const unsubscribe = store.subscribe(finish)
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

async function readEnvelope(request) {
  const declared = Number(request.headers.get('content-length'))
  if (declared > MAX_BODY_BYTES) return new Response('request too large', { status: 413 })
  const reader = request.body?.getReader()
  if (!reader) return new Response('body is not JSON', { status: 400 })
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        return new Response('request too large', { status: 413 })
      }
      chunks.push(value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    // 信封形状由 @deepseek-ai/dsh-client-connection 定义：
    // {type:'client-request', rpcId:string, method:string, payload:unknown}。
    // 这里只做形状校验而不 import 那个包 —— 装了插件的机器上不一定能解析到 DSH 内部包，
    // 插件必须自带这套校验才装得进任何 profile。
    const valid =
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'client-request' &&
      typeof parsed.rpcId === 'string' &&
      typeof parsed.method === 'string'
    return valid ? parsed : new Response('invalid request envelope', { status: 400 })
  } catch {
    return new Response('body is not JSON', { status: 400 })
  } finally {
    reader.releaseLock()
  }
}

export function apply(ctx) {
  return ctx.effect(async () => {
    const profile = ctx.profileContext ?? ctx.get?.('profileContext')
    const dir = join(profile.dir, 'dsh-chatroom')
    const store = await Store.open(dir)
    const runner = createBotRunner(ctx, { log })
    // store.notify()：待授权队列只在内存里，界面靠 revision 变化被叫醒（见 state.js）。
    const gate = createGate({ store, notify: () => store.notify(), log })
    // 先有 bridge 才有「远程成员的回合该怎么派出去」；speaker 反过来要交给 bridge，
    // 这样宿主收到局域网消息时走的还是同一个调度器（三条规则的预算只有一份）。
    const lan = createLanBridge({ store, runner, gate, log })
    const speaker = createSpeaker({ store, runner, gate, dispatchRemote: lan.enqueue, log })
    lan.setSpeaker(speaker)
    const disposers = []
    let closed = false

    const serviceFor = (key) => {
      const service = ctx.get?.(key) ?? ctx[key]
      if (!service) throw Object.assign(new Error('connection_unavailable'), { code: 'connection_unavailable' })
      return service
    }

    async function handle(endpoint, request) {
      if (request.method !== 'POST') return new Response('not found', { status: 404 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim()?.toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      const message = await readEnvelope(request)
      if (message instanceof Response) return message
      const method = `dsh.chatroom/${endpoint}`
      let result
      try {
        if (message.method !== method) throw Object.assign(new Error('invalid_endpoint'), { code: 'invalid_endpoint' })
        if (closed) throw Object.assign(new Error('disabled'), { code: 'disabled' })
        request.signal?.throwIfAborted?.()
        const payload = message.payload ?? {}
        if (endpoint === 'snapshot') {
          result = { ok: true, value: lan.view() }
        } else if (endpoint === 'messages') {
          result = { ok: true, value: await messagesPage({ store, lan, payload }) }
        } else if (endpoint === 'command') {
          result = { ok: true, value: await dispatch({ store, speaker, gate, lan, command: payload }) }
        } else if (endpoint === 'watch') {
          await waitForChange(store, Number(payload.since ?? -1), request.signal)
          result = { ok: true, value: lan.view() }
        } else {
          throw Object.assign(new Error('invalid_endpoint'), { code: 'invalid_endpoint' })
        }
      } catch (error) {
        const normalized = publicError(error, request.signal)
        result = { ok: false, error: normalized }
      }
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
    }

    try {
      for (const endpoint of ['snapshot', 'command', 'messages', 'watch']) {
        const connection = serviceFor('connection')
        disposers.push(
          connection.fetch.register({
            path: `/api/dsh.chatroom/${endpoint}`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => handle(endpoint, request),
          }),
        )
      }
      await store.flush()
      // LAN 监听起不来（端口被占）不该让整个插件失败：本机房间照常能用，
      // 只是「加入 / 邀请」栏会显示具体原因。
      await lan.start()
      // 这一份实例从此刻起在跑：探针要拿这个时间去比磁盘，别用模块自己的求值时间
      // （热重载只重新求值改过的文件，没改的模块时间会一直停在老地方）。
      markApplied()
      return async () => {
        closed = true
        // 还在等本机点按钮的那几条，随插件一起作废：留着只会让回合收不干净。
        gate.dispose()
        await lan.dispose()
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            await dispose()
          } catch (error) {
            log('dispose failed', error)
          }
        }
        await store.close()
      }
    } catch (error) {
      gate.dispose()
      await lan.dispose()
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose()
        } catch {
          /* 已经失败的路上不再制造第二个错误 */
        }
      }
      await store.close()
      throw error
    }
  })
}
