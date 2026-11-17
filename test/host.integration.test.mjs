import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'

/**
 * Host 半边的端到端测试：真的跑 apply(ctx)，真的过一遍路由、信封、命令分发、
 * Bot 回合，只是把「模型」和「文件系统」换成假的。
 *
 * 这层测的是接线，而不是模型：一条人消息进来，@ 到的 agent 必须真的被驱动一轮，
 * 它的回复必须按 seq 落进房间并出现在下一个 snapshot 里。
 */

const encoder = new TextEncoder()

// LAN 监听在 apply() 里就会起来；测试用系统挑的空闲端口，不去抢本机宿主的 4399。
process.env.DSH_CHATROOM_PORT = '0'

const DEFAULT_REPLY = '我看了现金流，数字对得上。'

function fakeCtx(dir, { reply = DEFAULT_REPLY, gate = null } = {}) {
  const routes = new Map()
  const agents = new Map()
  const events = new Map()
  const prompts = []

  function agentFor(sessionId) {
    const session = { id: sessionId, seq: 0, header: {} }
    const agent = {
      session,
      status: 'idle',
      followup(message) {
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        prompts.push({ sessionId, text, message })
        const answer = typeof reply === 'function' ? reply(text) : reply
        const list = events.get(sessionId) ?? []
        list.push({
          seq: list.length + 1,
          type: 'assistant/message',
          data: {
            interrupted: false,
            message: {
              id: 'a' + (list.length + 1),
              role: 'assistant',
              content: [{ type: 'text', text: answer }],
            },
          },
        })
        events.set(sessionId, list)
        session.seq = list.length
      },
      // gate 让测试能把「这一轮还在跑」这个时间窗拉长到可以操作，否则假模型瞬间就跑完了。
      whenIdle: async () => {
        if (typeof gate === 'function') await gate()
      },
    }
    return agent
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
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-chat' }) },
    workingDirectory: { defaultDirectory: dir },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }

  const ctx = {
    profileContext: { name: 'test', dir },
    get: (key) => services[key],
    effect: (fn) => fn(),
  }
  return { ctx, routes, prompts, events }
}

function request(payload, method = 'dsh.chatroom/command') {
  const body = encoder.encode(JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload }))
  return {
    method: 'POST',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : undefined) },
    signal: new AbortController().signal,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: body }
          },
          releaseLock() {},
        }
      },
    },
  }
}

async function call(routes, endpoint, payload) {
  const route = routes.get(`/api/dsh.chatroom/${endpoint}`)
  assert.ok(route, `路由 ${endpoint} 应该已注册`)
  const response = await route.fetch(request(payload, `dsh.chatroom/${endpoint}`))
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  return body.result
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

test('三个端点都注册，快照是空房间列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    for (const endpoint of ['snapshot', 'command', 'watch']) {
      assert.ok(routes.has(`/api/dsh.chatroom/${endpoint}`), `缺少 ${endpoint}`)
    }
    const snapshot = await call(routes, 'snapshot', {})
    assert.equal(snapshot.ok, true)
    assert.deepEqual(snapshot.value.rooms, [])
    assert.equal(snapshot.value.self.id, 'me')
  } finally {
    await dispose()
  }
})

test('建房间 → 加 agent → 人发言 @ 它 → agent 真的被驱动并按 seq 落进房间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '周四投委会', topic: '看财报' } })
    assert.equal(created.ok, true)
    const roomId = created.value.rooms[0].id
    assert.match(created.value.rooms[0].code, /^[2-9A-HJ-NP-Z]{6}$/)

    const withBot = await call(routes, 'command', {
      action: 'member.createBot',
      input: { roomId, name: 'Claude', role: '看财报的' },
    })
    assert.equal(withBot.ok, true)
    assert.equal(withBot.value.rooms[0].members.filter((m) => m.kind === 'bot').length, 1)

    const sent = await call(routes, 'command', {
      action: 'msg.send',
      input: { roomId, text: '@Claude 现金流那行对不对？' },
    })
    assert.equal(sent.ok, true)
    // 人那条立刻可见，agent 那条是异步补进来的
    assert.equal(sent.value.rooms[0].messages.length, 1)
    assert.equal(sent.value.rooms[0].messages[0].authorId, 'me')

    await tick(200)

    const after = await call(routes, 'snapshot', {})
    const room = after.value.rooms[0]
    assert.equal(room.messages.length, 2, 'agent 应该回了一句')
    const reply = room.messages[1]
    assert.equal(reply.authorName, 'Claude')
    assert.equal(reply.authorKind, 'bot')
    assert.equal(reply.seq, 2)
    assert.match(reply.text, /现金流/)
    assert.equal(room.activity, null, '这一轮结束后不该还挂着发言中')

    assert.equal(prompts.length, 1, 'agent 应该只被驱动一次')
    assert.match(prompts[0].text, /@Claude 现金流那行对不对？/, '房间上下文要进 prompt')
    assert.match(prompts[0].text, /周四投委会/)
    assert.equal(prompts[0].message.role, 'user', '必须是 user 角色消息')
  } finally {
    await dispose()
  }
})

test('没被 @ 也没开全员轮次时，agent 不发言（不白烧模型调用）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '安静点' } })
    const roomId = created.value.rooms[0].id
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'Grok' } })
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '今天先不聊' } })
    await tick(120)
    assert.equal(prompts.length, 0)
    const after = await call(routes, 'snapshot', {})
    assert.equal(after.value.rooms[0].messages.length, 1)
  } finally {
    await dispose()
  }
})

test('「让全员说一轮」不靠 @ 也会让所有 agent 各说一句', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '全员发言' } })
    const roomId = created.value.rooms[0].id
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'A' } })
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'B' } })
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '每人一句' } })
    const round = await call(routes, 'command', { action: 'round.run', input: { roomId } })
    assert.equal(round.ok, true)
    await tick(250)
    const after = await call(routes, 'snapshot', {})
    assert.equal(after.value.rooms[0].messages.length, 3, '人 1 条 + 两个 agent 各 1 条')
    assert.equal(prompts.length, 2)
  } finally {
    await dispose()
  }
})

/** prompt 里的「以「X」的身份」就是这一轮被驱动的 agent。 */
const speakerOf = (text) => text.match(/以「(.+?)」的身份/)?.[1] ?? null

const botsOf = (snapshot) => snapshot.value.rooms[0].members.filter((member) => member.kind === 'bot')

test('三条规则同时开：主持人 @ 的人不会被再调度一次，全员轮次仍然轮到每个人', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  // 主持人先说话，并在回复里 @B —— 这是「chair 接力」和「全员轮流」撞在一起的那条路。
  const { ctx, routes, prompts } = fakeCtx(dir, {
    reply: (text) =>
      text.includes('主持人')
        ? '现金流这块我先定调：没问题。@B 你把成本那部分补一下。'
        : '我补一句：这版数字能对上。',
  })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '三条规则同时开' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B', 'C']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name, role: '参谋' } })
    }
    const listed = await call(routes, 'snapshot', {})
    const bots = botsOf(listed)
    const chair = bots.find((member) => member.name === 'A')
    // 三条规则一起开，预算留够 4 个回合：扣掉「同一个人不许说两遍」，三个人正好各一次。
    const updated = await call(routes, 'command', {
      action: 'room.update',
      input: { roomId, rules: { mention: true, roundRobin: true, chairId: chair.id, maxSpeakers: 4 } },
    })
    assert.equal(updated.value.rooms[0].rules.roundRobin, true)
    assert.equal(updated.value.rooms[0].rules.mention, true)
    assert.equal(updated.value.rooms[0].rules.chairId, chair.id)

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@C 你先出个意见' } })
    await tick(400)

    const after = await call(routes, 'snapshot', {})
    const replies = after.value.rooms[0].messages.filter((message) => message.authorKind === 'bot')
    const said = replies.map((message) => message.authorName)
    assert.deepEqual(said.slice().sort(), ['A', 'B', 'C'], `每个 agent 只能说一次，实际：${said.join('、')}`)
    assert.equal(prompts.length, 3, `只该驱动三轮回合，实际驱动了 ${prompts.length} 轮`)
    const driven = prompts.map((prompt) => speakerOf(prompt.text))
    assert.deepEqual(driven.slice().sort(), ['A', 'B', 'C'], `被驱动的应该恰好是三个人，实际：${driven.join('、')}`)
    assert.equal(after.value.rooms[0].activity, null, '这一轮结束后不该还挂着发言中')
  } finally {
    await dispose()
  }
})

test('正在发言时人又说了一句：这句不会被吞掉，等这一轮结束就接上', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  let release = () => {}
  let open = false
  const held = new Promise((resolve) => {
    release = () => {
      open = true
      resolve()
    }
  })
  // 把「一轮还没跑完」这个窗口撑开：真实房间里它有好几秒，用户正是在这时候插话。
  const { ctx, routes, prompts } = fakeCtx(dir, { gate: async () => (open ? null : held) })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '插话' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name } })
    }
    await call(routes, 'command', { action: 'room.update', input: { roomId, rules: { roundRobin: true } } })

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '每人一句' } })
    await tick(80)
    assert.equal(prompts.length, 1, '这一轮应该已经开始（第一句卡在 gate 上）')

    // 这一句发在别人发言中间：它必须被记下来，而不是静默丢掉。
    const interjected = await call(routes, 'command', {
      action: 'msg.send',
      input: { roomId, text: '@B 你等会儿单独说一句' },
    })
    const interjectedSeq = interjected.value.rooms[0].messages.find((message) => message.authorKind === 'human' && message.text.includes('单独说一句'))?.seq
    assert.ok(interjectedSeq, '人那句本身应该已经落进房间')

    release()
    await tick(600)

    const after = await call(routes, 'snapshot', {})
    // 第一轮是 A、B 各一句；插话进来后按同一套规则再来一轮（@ 的 B 在前，全员轮到的 A 在后）。
    assert.equal(prompts.length, 4, `插话应该再引出两轮发言，实际总共 ${prompts.length} 次驱动`)
    assert.deepEqual(prompts.map((prompt) => speakerOf(prompt.text)), ['A', 'B', 'B', 'A'])
    assert.match(prompts[2].text, /@B 你等会儿单独说一句/, '接上的那一轮要带上插话本身')

    const replied = after.value.rooms[0].messages.filter(
      (message) => message.authorKind === 'bot' && message.seq > interjectedSeq && message.authorName === 'B',
    )
    // 一句是这一轮自己的台词（排队排在插话后面），一句是插话换来的。
    assert.equal(replied.length, 2)
    assert.equal(after.value.rooms[0].activity, null)
  } finally {
    await dispose()
  }
})

test('信封不合法直接 400，不会把垃圾当成命令', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const route = routes.get('/api/dsh.chatroom/command')
    const bad = {
      method: 'POST',
      headers: { get: () => 'application/json' },
      signal: new AbortController().signal,
      body: {
        getReader() {
          const body = encoder.encode(JSON.stringify({ hello: 'world' }))
          let sent = false
          return {
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: body }
            },
            releaseLock() {},
          }
        },
      },
    }
    const response = await route.fetch(bad)
    assert.equal(response.status, 400)
  } finally {
    await dispose()
  }
})

test('未知命令返回可读错误而不是把进程带崩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const result = await call(routes, 'command', { action: 'rm -rf /', input: {} })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unknown_action')
  } finally {
    await dispose()
  }
})

test('watch：revision 变了立刻返回，没变就等到超时', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const snapshot = await call(routes, 'snapshot', {})
    // since 落后 → 立即返回
    const immediate = await call(routes, 'watch', { since: snapshot.value.revision - 1 })
    assert.equal(immediate.ok, true)
  } finally {
    await dispose()
  }
})
