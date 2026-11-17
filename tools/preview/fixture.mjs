import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/host/state.js'
import { dispatch } from '../../src/host/plugin.js'
import { createLanBridge } from '../../src/host/lan-bridge.js'
import { createSpeaker } from '../../src/host/speak.js'
import { createBotRunner } from '../../src/host/turn.js'
import { addMember, createRoom, markRead, postMessage } from '../../src/host/rooms.js'

/**
 * 截图用的 Host 替身。
 *
 * 它不重写业务逻辑：状态机（rooms.js）、投影与命令分发（project.js / plugin.js）、
 * 发言规则（speak.js）、LAN 宿主与加入者（lan-host.js / lan-guest.js）都是线上那一份，
 * 只有三样是替身 ——
 *   1. profile 目录换成临时目录，不碰用户真实房间；
 *   2. agents / sessions 换成假模型，截图不必真调 LLM（真模型验收在真宿主里另做）；
 *   3. 路由层用 node:http 而不是 DSH 的 connection.fetch。
 *
 * 两台机器就在同一个进程里各起一个 Store，互相走真实的局域网 HTTP 协议 ——
 * 所以截图里的「LAN 进来的成员」不是画上去的，是真加入进来的。
 */

const log = (...args) => console.warn('[chatroom-preview]', ...args)

// 端口交给系统挑：截图不该跟本机正在跑的宿主抢 4399。
process.env.DSH_CHATROOM_PORT = '0'

function fakeCtx(dir, { reply } = {}) {
  const agents = new Map()
  const events = new Map()
  const replyFor =
    typeof reply === 'function'
      ? reply
      : () => (typeof reply === 'string' ? reply : '我看了现金流，数字对得上。')

  function agentFor(sessionId) {
    const session = { id: sessionId, seq: 0, header: {} }
    return {
      session,
      status: 'idle',
      followup(message) {
        const prompt = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        const list = events.get(sessionId) ?? []
        list.push({
          seq: list.length + 1,
          type: 'assistant/message',
          data: {
            interrupted: false,
            message: {
              id: `a${list.length + 1}`,
              role: 'assistant',
              content: [{ type: 'text', text: String(replyFor(prompt)) }],
            },
          },
        })
        events.set(sessionId, list)
        session.seq = list.length
      },
      whenIdle: async () => {},
    }
  }

  const services = {
    agents: {
      get: (id) => agents.get(id),
      create: async ({ sessionId }) => {
        const agent = agentFor(sessionId)
        agents.set(sessionId, agent)
        return { agent }
      },
      resume: async () => {
        throw Object.assign(new Error('no persisted session'), { code: 'session_not_found' })
      },
      roots: () => [],
    },
    sessions: { flush: async () => {} },
    sessionPersistence: {
      open: async (sessionId) => ({
        read: async () => ({ events: events.get(sessionId) ?? [] }),
        close: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'preview', model: 'preview-chat' }) },
    workingDirectory: { defaultDirectory: dir },
  }

  return { profileContext: { name: 'preview', dir }, get: (key) => services[key], effect: (fn) => fn() }
}

const now = () => new Date().toISOString()

/**
 * 把消息时间钉成固定几档。
 *
 * 界面上每条消息都带 HH:MM，用真实时间的话每次重新截图都会得到一张像素不同的 PNG ——
 * docs/ 里那七张图永远全红，真正的改动反而看不出来。截图只看版式与内容，时间钉死即可。
 */
const PIN_BASE = Date.parse('2026-11-17T01:30:00.000Z')

export function pinTimes(store) {
  store.commit((draft) => {
    for (const room of draft.rooms) {
      room.messages.forEach((message, index) => {
        message.at = new Date(PIN_BASE + index * 60_000).toISOString()
      })
    }
  })
}

function seedHost(store) {
  return store.commit((draft) => {
    draft.self.name = '林岸'
    const room = createRoom(draft, {
      name: 'Q4 复盘 · 现金流',
      topic: '把应付账期和退货率对一遍，产出下一版预算',
    })
    // 房间码是随机生成的，界面上会显示（邀请那屏就有）——钉死，截图才可复现。
    room.code = 'K7M2QD'
    const other = createRoom(draft, { name: '选品会', topic: '下周上新的三个款' })
    other.code = 'X4RT9B'
    draft.activeRoomId = room.id

    const cash = {
      id: 'bot_cashflow',
      name: '账期 agent',
      role: '盯应付账期与现金流缺口',
      sessionId: 'sess-cashflow',
      cwd: null,
      createdAt: now(),
      lastError: null,
      lastSpokeAt: null,
    }
    const returns = {
      id: 'bot_returns',
      name: '退货 agent',
      role: '拆退货率与热销款损耗',
      sessionId: 'sess-returns',
      cwd: null,
      createdAt: now(),
      lastError: null,
      lastSpokeAt: null,
    }
    draft.bots.push(cash, returns)

    addMember(draft, {
      roomId: room.id,
      member: { id: 'm_bot_cashflow', kind: 'bot', name: cash.name, role: cash.role, botId: cash.id, sessionId: cash.sessionId },
    })
    addMember(draft, {
      roomId: room.id,
      member: { id: 'm_bot_returns', kind: 'bot', name: returns.name, role: returns.role, botId: returns.id, sessionId: returns.sessionId },
    })

    const say = (authorId, text) => postMessage(draft, { roomId: room.id, authorId, text })
    say(draft.self.id, '这版预算我按 45 天账期算的，@账期 agent 先看缺口。')
    say('m_bot_cashflow', '45 天账期下，10 月缺口约 82 万，集中在第二周。把两笔大额应付款挪到 11/03，缺口降到 31 万。')
    say('m_bot_returns', '退货率这版按 6.2% 算的。按现在节奏，Q4 退货成本会多 19 万。')
    say(draft.self.id, '那就先把尾货清仓价挂出来，预算按 7.1% 重算一版。')
    // 留一条未读：截图里才有徽标与提醒可看。
    markRead(draft, { roomId: room.id, memberId: draft.self.id, seq: room.nextSeq - 2 })
    return room
  })
}

async function bootSide({ dir, reply, port }) {
  const store = await Store.open(dir)
  const ctx = fakeCtx(dir, { reply })
  const runner = createBotRunner(ctx, { log })
  const lan = createLanBridge({ store, runner, log, machine: '林岸的 MacBook' })
  const speaker = createSpeaker({ store, runner, log, dispatchRemote: lan.enqueue })
  lan.setSpeaker(speaker)
  await lan.start(port)
  return {
    store,
    lan,
    speaker,
    snapshot: () => lan.view(),
    command: (payload) => dispatch({ store, speaker, lan, command: payload }),
    dispose: () => lan.dispose(),
  }
}

/** 宿主：本机房间 + 两个本地 agent，然后等另一台机器加入。 */
export async function bootFixture({ port } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-preview-'))
  // 假模型可以被点名挂一次：「agent 没回上来」那一屏要的是真实失败路径，
  // 不是给页面塞一条假消息。挂完自动恢复，重试才有的可重。
  const model = { failNext: false }
  const side = await bootSide({
    dir,
    port,
    reply: () => {
      if (model.failNext) {
        model.failNext = false
        throw Object.assign(new Error('模型这一轮挂了'), { code: 'model_failed' })
      }
      return '45 天账期下缺口 82 万，集中在第二周；把两笔大额应付款挪到 11/03 能降到 31 万。'
    },
  })
  const room = seedHost(side.store)
  pinTimes(side.store)
  return {
    ...side,
    dir,
    roomId: room.id,
    code: room.code,
    lanPort: side.lan.status().port,
    /** 截「消息提醒」用：真的往屋里放一条 agent 消息，让长轮询把它推给界面。 */
    nudge() {
      const text = '11/03 那两笔挪款我写进合同条款了，缺口才算真的降到 31 万。'
      side.store.commit((draft) => {
        const target = draft.rooms.find((row) => row.id === draft.activeRoomId) ?? draft.rooms[0]
        // 反复跑截图脚本时不要越堆越多：上一次的同一条提醒先撤掉。
        target.messages = target.messages.filter((message) => message.text !== text)
        postMessage(draft, { roomId: target.id, authorId: 'm_bot_cashflow', text })
      })
      pinTimes(side.store)
      return side.snapshot()
    },
    /**
     * 截「重试」用：让本机的「账期 agent」真失败一轮。
     * 单独开一间屋子演这张图：失败那一屏不该把主线房间的历史带脏，
     * 后面「三台机器同屋 / 解散」还要用那间屋子的干净状态。
     * 走的是和人一模一样的路径 —— 人发一句 @ 它的话，它的回合就挂了，
     * 占位消息由 speak.js 自己落下，界面上的「重试」再把这一轮单独重跑。
     */
    async failOnce() {
      const created = await side.command({
        action: 'room.create',
        input: { name: '对账会', topic: '把缺口口径对一遍' },
      })
      const target = created.rooms.find((row) => row.name === '对账会')
      if (!target) throw new Error('没能开出「对账会」这间屋子')
      side.store.commit((draft) => {
        const fresh = draft.rooms.find((row) => row.id === target.id)
        if (fresh) fresh.code = 'R3W8YN'
      })
      await side.command({
        action: 'member.createBot',
        input: { roomId: target.id, name: '账期 agent', role: '盯应付账期与现金流缺口' },
      })
      model.failNext = true
      await side.command({
        action: 'msg.send',
        input: { roomId: target.id, text: '@账期 agent 缺口按哪天的账期算的？' },
      })
      for (let i = 0; i < 60; i += 1) {
        const fresh = side.snapshot().rooms.find((row) => row.id === target.id)
        if (fresh && fresh.messages.some((message) => message.status === 'error')) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      pinTimes(side.store)
      return side.snapshot()
    },
  }
}

/**
 * 加入者：另一台机器。它先有自己的房间与 agent，再按房间码加入宿主的屋子。
 * 之后两边都在线 —— 截图里的远程成员、跨机派发都来自这条真实链路。
 */
export async function bootGuest({
  host = '127.0.0.1',
  port,
  code,
  name = '周荻',
  botName = '尾货 agent',
  machine = '周荻的 MacBook',
  role = '拆尾货与退货结构',
  reply = '尾货占退货的 62%，三款夏装清仓能把 Q4 退货成本压回 15 万以内。',
}) {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-guest-'))
  const side = await bootSide({ dir, reply })
  await side.command({ action: 'self.rename', input: { name } })
  const local = await side.command({ action: 'room.create', input: { name: '我自己的屋子' } })
  // 同宿主那边：房间码也钉死，加入方视角的截图才不会每次都不一样。
  side.store.commit((draft) => {
    const own = draft.rooms.find((row) => row.id === local.rooms[0].id)
    if (own) own.code = 'M8NP3C'
  })
  await side.command({
    action: 'member.createBot',
    input: { roomId: local.rooms[0].id, name: botName, role },
  })
  await side.command({
    action: 'lan.join',
    input: { host, port, code, machine },
  })
  return { ...side, dir }
}

/** 把两台机器之间这场对话补完：加入方说一句、宿主 @ 加入方的 agent，它回一句。 */
export async function warmUp(host, guest) {
  const view = guest.snapshot()
  const mirror = view.rooms.find((room) => room.remote)
  if (!mirror) throw new Error('加入方没有镜像房间')
  await guest.command({
    action: 'msg.send',
    input: { roomId: mirror.id, text: '我这边先把退货率放上来：上周华东仓冒到 7.1%。' },
  })
  await host.command({
    action: 'msg.send',
    input: { roomId: host.roomId, text: '@尾货 agent 7.1% 里尾货占多少？' },
  })
  // 一轮跨机派发：宿主 → 加入方跑自己的 agent → 回传落库。等它落定再截图。
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const room = host.store.state.rooms.find((row) => row.id === host.roomId)
    if (room.messages.some((message) => message.authorName === '尾货 agent')) break
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  // 两边都补完再钉时间：镜像房间的 at 是宿主的投影，钉完再截才稳定。
  pinTimes(host.store)
  pinTimes(guest.store)
  return { mirror }
}

/**
 * 第三台机器进屋。
 *
 * 两台机器时「本机 / 远程」两分就够了；三台才需要界面证明它分得清**是哪一台**远程。
 * 所以这张截图里第三台机器是真人加入的：真握手、真发言、真派发。
 */
export async function joinThirdMachine(
  host,
  { name = '陈默', botName = '库存 agent', machine = '陈默的 ThinkPad', role = '盯尾货库存与清仓节奏' } = {},
) {
  const third = await bootGuest({
    port: host.lanPort,
    code: host.code,
    name,
    botName,
    machine,
    role,
    reply: '1.2 万件里 7 千件能在 11/11 前清掉，剩下的转明年春季，退货成本压回 15 万。',
  })
  const mirror = third.snapshot().rooms.find((room) => room.remote)
  if (!mirror) throw new Error('第三台机器没有镜像房间')
  await third.command({
    action: 'msg.send',
    input: { roomId: mirror.id, text: '我这边把尾货库存过了一遍：三个款合计 1.2 万件。' },
  })
  await host.command({
    action: 'msg.send',
    input: { roomId: host.roomId, text: '@库存 agent 有多少能赶上 11/11 清？' },
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const room = host.store.state.rooms.find((row) => row.id === host.roomId)
    if (room.messages.some((message) => message.authorName === botName)) break
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  pinTimes(host.store)
  pinTimes(third.store)
  return third
}
