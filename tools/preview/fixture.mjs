import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/host/state.js'
import { dispatch, project } from '../../src/host/plugin.js'
import { createSpeaker } from '../../src/host/speak.js'
import { createBotRunner } from '../../src/host/turn.js'
import { addMember, createRoom, markRead, postMessage, updateMember } from '../../src/host/rooms.js'

/**
 * 截图用的 Host 替身。
 *
 * 它不重写业务逻辑：状态机（rooms.js）、投影与命令分发（plugin.js）、发言规则
 * （speak.js）都是线上那一份，只有三样是替身 ——
 *   1. profile 目录换成临时目录，不碰用户真实房间；
 *   2. agents / sessions 换成假模型，截图不必真调 LLM（真模型验收在真宿主里另做）；
 *   3. 路由层用 node:http 而不是 DSH 的 connection.fetch。
 *
 * 目的只有一个：在没有 DSH 外壳的浏览器里，让真实的 lib/client.js 拿到真实形状的
 * snapshot，从而截到「真渲染」，而不是手画 mockup。
 */

const log = (...args) => console.warn('[chatroom-preview]', ...args)

function fakeCtx(dir) {
  const agents = new Map()
  const events = new Map()

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
        const text = /退货/.test(prompt)
          ? '7.1% 里 62% 是三款夏装尾货，按现价清仓能把 Q4 退货成本压回 15 万以内。'
          : '45 天账期下缺口 82 万，集中在第二周；把两笔大额应付款挪到 11/03 能降到 31 万。'
        const list = events.get(sessionId) ?? []
        list.push({
          seq: list.length + 1,
          type: 'assistant/message',
          data: {
            interrupted: false,
            message: { id: `a${list.length + 1}`, role: 'assistant', content: [{ type: 'text', text }] },
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

const LAN = { kind: 'lan', peer: '192.168.1.42', machine: 'MacBook-Air' }
const now = () => new Date().toISOString()

function seed(store) {
  store.commit((draft) => {
    draft.self.name = '林岸'
    const room = createRoom(draft, {
      name: 'Q4 复盘 · 现金流',
      topic: '把应付账期和退货率对一遍，产出下一版预算',
    })
    createRoom(draft, { name: '选品会', topic: '下周上新的三个款' })
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
    // 远程那台机器上的人，以及它带过来的 agent：origin 决定界面上的「本机 / LAN」。
    addMember(draft, {
      roomId: room.id,
      member: { id: 'h_zhou', kind: 'human', name: '周荻', role: '供应链', origin: LAN },
    })
    updateMember(draft, { roomId: room.id, memberId: 'm_bot_returns', patch: { origin: LAN, reach: 'lan' } })

    const say = (authorId, text) => postMessage(draft, { roomId: room.id, authorId, text })
    say(draft.self.id, '这版预算我按 45 天账期算的，@账期 agent 先看缺口。')
    say('m_bot_cashflow', '45 天账期下，10 月缺口约 82 万，集中在第二周。把两笔大额应付款挪到 11/03，缺口降到 31 万。')
    say('h_zhou', '退货这版按 6.2% 算的，但华东仓上周开始冒到 7.1%。')
    say('m_bot_returns', '7.1% 里 62% 是三款夏装尾货。按现在节奏，Q4 退货成本会多 19 万。')
    say(draft.self.id, '那就先把尾货清仓价挂出来，预算按 7.1% 重算一版。')
    // 最后两条留成未读，截图里才有徽标与提醒可看。
    markRead(draft, { roomId: room.id, memberId: draft.self.id, seq: room.nextSeq - 3 })
    return room
  })
}

export async function bootFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-preview-'))
  const store = await Store.open(dir)
  const ctx = fakeCtx(dir)
  const runner = createBotRunner(ctx, { log })
  const speaker = createSpeaker({ store, runner, log })
  seed(store)

  return {
    store,
    speaker,
    dir,
    snapshot: () => project(store.state),
    command: (payload) => dispatch({ store, speaker, command: payload }),
    /** 截「消息提醒」用：真的往屋里放一条 agent 消息，让长轮询把它推给界面。 */
    nudge() {
      store.commit((draft) => {
        const room = draft.rooms.find((row) => row.id === draft.activeRoomId) ?? draft.rooms[0]
        postMessage(draft, {
          roomId: room.id,
          authorId: 'm_bot_cashflow',
          text: '11/03 那两笔挪款我写进合同条款了，缺口才算真的降到 31 万。',
        })
      })
      return project(store.state)
    },
  }
}
