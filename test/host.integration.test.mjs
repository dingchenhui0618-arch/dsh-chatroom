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

function fakeCtx(dir) {
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
        const list = events.get(sessionId) ?? []
        list.push({
          seq: list.length + 1,
          type: 'assistant/message',
          data: {
            interrupted: false,
            message: {
              id: 'a' + (list.length + 1),
              role: 'assistant',
              content: [{ type: 'text', text: '我看了现金流，数字对得上。' }],
            },
          },
        })
        events.set(sessionId, list)
        session.seq = list.length
      },
      whenIdle: async () => {},
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
