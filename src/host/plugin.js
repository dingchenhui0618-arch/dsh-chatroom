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
  unreadOf,
  updateMember,
  updateRoom,
} from './rooms.js'
import { createBotRunner } from './turn.js'
import { createSpeaker } from './speak.js'

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

const PROJECTION_MESSAGES = 200

/**
 * 给客户端的投影：只给面板需要的字段，消息截到最近 200 条。
 * 导出是给 QA 渲染工具用的：它要在没有 DSH 外壳的情况下复用同一份投影与分发。
 */
export function project(state) {
  return {
    revision: state.revision,
    self: { id: state.self.id, name: state.self.name },
    activeRoomId: state.activeRoomId,
    bots: state.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      sessionId: bot.sessionId,
      lastError: bot.lastError ?? null,
      lastSpokeAt: bot.lastSpokeAt ?? null,
    })),
    rooms: state.rooms.map((room) => ({
      id: room.id,
      code: room.code,
      name: room.name,
      topic: room.topic,
      createdAt: room.createdAt,
      ownerId: room.ownerId,
      rules: { ...room.rules },
      activity: room.activity ?? null,
      nextSeq: room.nextSeq,
      unread: unreadOf(room, state.self.id),
      members: room.members,
      messages: room.messages.slice(-PROJECTION_MESSAGES),
      truncated: room.messages.length > PROJECTION_MESSAGES,
    })),
  }
}

export function dispatch({ store, speaker, command }) {
  const action = String(command?.action ?? '')
  const input = command?.input && typeof command.input === 'object' ? command.input : {}
  const state = store.state

  switch (action) {
    case 'room.create': {
      store.commit((draft) => createRoom(draft, { name: input.name, topic: input.topic }))
      break
    }
    case 'room.update': {
      store.commit((draft) =>
        updateRoom(draft, { roomId: input.roomId, name: input.name, topic: input.topic, rules: input.rules }),
      )
      break
    }
    case 'room.dissolve': {
      store.commit((draft) => dissolveRoom(draft, { roomId: input.roomId }))
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
    case 'member.createBot': {
      store.commit((draft) => {
        const bot = {
          id: `bot_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: String(input.name ?? '').trim().slice(0, 60) || '新 agent',
          role: String(input.role ?? '').trim().slice(0, 200),
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
      store.commit((draft) =>
        updateMember(draft, { roomId: input.roomId, memberId: input.memberId, patch: input.patch }),
      )
      break
    }
    case 'member.remove': {
      store.commit((draft) => removeMember(draft, { roomId: input.roomId, memberId: input.memberId }))
      break
    }
    case 'msg.send': {
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
      const room = getRoom(state, input.roomId)
      const message = room?.messages.find((row) => row.seq === input.seq)
      if (!room || !message) throw Object.assign(new Error('message_not_found'), { code: 'message_not_found' })
      if (message.authorKind !== 'bot') throw Object.assign(new Error('只能让 agent 重说'), { code: 'not_agent_message' })
      speaker.retryBot({ roomId: input.roomId, memberId: message.authorId })
      break
    }
    case 'round.run': {
      speaker.runRound({ roomId: input.roomId })
      break
    }
    case 'round.stop': {
      speaker.stop(input.roomId)
      break
    }
    case 'read.mark': {
      store.commit((draft) => markRead(draft, { roomId: input.roomId, memberId: draft.self.id, seq: input.seq }))
      break
    }
    case 'self.rename': {
      store.commit((draft) => {
        const label = String(input.name ?? '').trim().slice(0, 60)
        if (!label) throw Object.assign(new Error('名字不能为空'), { code: 'name_required' })
        draft.self.name = label
        for (const room of draft.rooms) {
          const member = getMember(room, draft.self.id)
          if (member) member.name = label
        }
      })
      break
    }
    case 'bot.update': {
      store.commit((draft) => {
        const bot = draft.bots.find((row) => row.id === input.botId)
        if (!bot) throw Object.assign(new Error('bot_not_found'), { code: 'bot_not_found' })
        if (input.name !== undefined) bot.name = String(input.name).trim().slice(0, 60) || bot.name
        if (input.role !== undefined) bot.role = String(input.role).trim().slice(0, 200)
        for (const room of draft.rooms) {
          const member = room.members.find((row) => row.botId === bot.id)
          if (member) {
            member.name = bot.name
            member.role = bot.role
          }
        }
      })
      break
    }
    default:
      throw Object.assign(new Error(`未知操作：${action}`), { code: 'unknown_action' })
  }

  return project(store.state)
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
    const speaker = createSpeaker({ store, runner, log })
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
          result = { ok: true, value: project(store.state) }
        } else if (endpoint === 'command') {
          result = { ok: true, value: dispatch({ store, speaker, command: payload }) }
        } else if (endpoint === 'watch') {
          await waitForChange(store, Number(payload.since ?? -1), request.signal)
          result = { ok: true, value: project(store.state) }
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
      for (const endpoint of ['snapshot', 'command', 'watch']) {
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
      return async () => {
        closed = true
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
