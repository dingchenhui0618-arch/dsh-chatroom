import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { validateState } from '../src/host/state.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 本机授权：另一台机器派过来的回合，要不要在这台机器上执行。
 *
 * 为什么要专门一组用例：这条链路里「不执行」是一种**正确结果**，而不是失败。
 * 它没有异常、没有红色占位、模型一次都没被调用 —— 只看「流程跑通了」的用例
 * 根本发现不了门有没有装上（装着的时候和不装的时候，界面都很安静）。
 *
 * 所以这里既断言「不跑」，也断言「屋里留下说明」，还要断言「允许之后真的跑」。
 */

process.env.DSH_CHATROOM_PORT = '0'

async function boot(name, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `gate-${name}-`))
  const fake = fakeCtx(dir, options)
  const dispose = await apply(fake.ctx)
  return { dir, dispose, ...fake }
}

const snapshot = async (side) => {
  const result = await call(side.routes, 'snapshot', {})
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}

const command = async (side, action, input = {}) => {
  const result = await call(side.routes, 'command', { action, input })
  assert.equal(result.ok, true, `${action} 失败：${JSON.stringify(result.error)}`)
  return result.value
}

const roomOf = async (side, roomId) => (await snapshot(side)).rooms.find((room) => room.id === roomId)

/** 宿主开一间屋 + 一个本机 agent；加入方带着自己的 agent 进来。 */
async function pair({ hostReply, guestReply, guestName = '周荻', agentName = '阿甲', hostAgent = null }) {
  const host = await boot('host', { reply: hostReply })
  const guest = await boot('guest', { reply: guestReply })
  const created = await command(host, 'room.create', { name: '授权的屋子' })
  const roomId = created.rooms[0].id
  await command(host, 'self.rename', { name: '林岸' })
  if (hostAgent) await command(host, 'member.createBot', { roomId, name: hostAgent })
  const port = (await snapshot(host)).lan.port

  await command(guest, 'room.create', { name: '客人自己的屋子' })
  await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: agentName })
  await command(guest, 'self.rename', { name: guestName })
  await command(guest, 'lan.join', {
    host: '127.0.0.1',
    port,
    code: created.rooms[0].code,
    machine: 'GUEST-A',
  })
  const mirror = (await snapshot(guest)).rooms.find((room) => room.remote)
  assert.ok(mirror, '加入方应该有镜像房间')
  return { host, guest, roomId, mirror }
}

const disposeAll = async (...sides) => {
  for (const side of sides) await side?.dispose?.().catch(() => {})
}

test('默认只读：别的机器 @ 本机 agent，本机不跑，屋里留一条说明', async () => {
  const { host, guest, roomId, mirror } = await pair({
    hostReply: '本机不该被驱动。',
    guestReply: '客人这边。',
    hostAgent: 'Claude',
  })
  try {
    const view = await snapshot(host)
    assert.equal(view.auth.level, 'readonly', '新机器默认必须是只读')
    assert.deepEqual(view.approvals, [], '默认档位下不该挂出待授权')

    await command(guest, 'msg.send', { roomId: mirror.id, text: '@Claude 帮我看下缺口' })

    const notice = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.status === 'notice')
      },
      { label: '只读说明落进房间' },
    )
    assert.match(notice.text, /只读/, '说明里要点出是哪一档拦下的')
    assert.match(notice.text, /本机授权/, '说明里要告诉人去哪儿改')
    assert.equal(host.prompts.length, 0, '默认只读绝不该调用本机模型')
  } finally {
    await disposeAll(guest, host)
  }
})

test('授权后执行：卡片说清谁要哪个 agent 做什么，允许才跑、拒绝不跑', async () => {
  const { host, guest, roomId, mirror } = await pair({
    hostReply: '授权之后才说的话。',
    guestReply: '客人这边。',
    hostAgent: 'Claude',
  })
  try {
    await command(host, 'auth.set', { level: 'ask' })
    // 外面的机器看不到这台机器的待授权：它是本机的安全设置，不是房间的事实。
    assert.equal((await snapshot(guest)).approvals.length, 0)

    await command(guest, 'msg.send', { roomId: mirror.id, text: '@Claude 帮我看下缺口' })
    const card = await until(
      async () => {
        const view = await snapshot(host)
        return view.approvals[0] ?? null
      },
      { label: '待授权出现在本机快照里' },
    )
    assert.equal(card.agentName, 'Claude')
    assert.equal(card.fromName, '周荻', '卡片要说清是谁要它做')
    assert.equal(card.fromMachine, 'GUEST-A', '还要说清是哪台机器')
    assert.equal(card.fromKind, 'human')
    assert.match(card.prompt, /帮我看下缺口/, '卡片要带上对方要它做的事')
    assert.equal(host.prompts.length, 0, '还没点允许就不该跑')

    // 点「允许」之后，卡片消失、这一轮真的跑起来。
    await command(host, 'auth.answer', { id: card.id, allow: true })
    const reply = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.authorName === 'Claude' && message.status === 'sent')
      },
      { label: '允许之后 agent 真的发言' },
    )
    assert.match(reply.text, /授权之后才说的话/)
    assert.equal(host.prompts.length, 1)
    assert.deepEqual((await snapshot(host)).approvals, [])

    // 拒绝：不跑，留说明。
    await command(guest, 'msg.send', { roomId: mirror.id, text: '@Claude 再来一遍' })
    const next = await until(
      async () => {
        const view = await snapshot(host)
        return view.approvals[0] ?? null
      },
      { label: '第二次待授权' },
    )
    await command(host, 'auth.answer', { id: next.id, allow: false })
    const declined = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.status === 'notice' && /拒绝/.test(message.text))
      },
      { label: '拒绝之后留一条说明' },
    )
    assert.match(declined.text, /没有执行/)
    assert.equal(host.prompts.length, 1, '拒绝之后不该多一次模型调用')
  } finally {
    await disposeAll(guest, host)
  }
})

test('授权后执行：不点按钮就按拒绝收尾，不会一直挂着', async () => {
  const { host, guest, roomId, mirror } = await pair({
    hostReply: '不该跑到这里。',
    guestReply: '客人这边。',
    hostAgent: 'Claude',
  })
  const previous = process.env.DSH_CHATROOM_APPROVAL_MS
  process.env.DSH_CHATROOM_APPROVAL_MS = '250'
  try {
    await command(host, 'auth.set', { level: 'ask' })
    await command(guest, 'msg.send', { roomId: mirror.id, text: '@Claude 你还在吗' })
    const notice = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.status === 'notice')
      },
      { label: '超时之后留一条说明' },
    )
    assert.match(notice.text, /时限/)
    assert.equal(host.prompts.length, 0, '超时按拒绝，不执行')
    assert.deepEqual((await snapshot(host)).approvals, [], '超时的卡片要自己消失')
  } finally {
    if (previous === undefined) delete process.env.DSH_CHATROOM_APPROVAL_MS
    else process.env.DSH_CHATROOM_APPROVAL_MS = previous
    await disposeAll(guest, host)
  }
})

test('完全授权：不问直接跑', async () => {
  const { host, guest, roomId, mirror } = await pair({
    hostReply: '直接说了。',
    guestReply: '客人这边。',
    hostAgent: 'Claude',
  })
  try {
    await command(host, 'auth.set', { level: 'full' })
    await command(guest, 'msg.send', { roomId: mirror.id, text: '@Claude 说一句' })
    const reply = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.authorName === 'Claude' && message.status === 'sent')
      },
      { label: '完全授权下直接发言' },
    )
    assert.match(reply.text, /直接说了/)
    assert.deepEqual((await snapshot(host)).approvals, [], '完全授权不该弹卡')
  } finally {
    await disposeAll(guest, host)
  }
})

test('加入方侧：默认只读拒掉远端派发，改成完全授权能跑，改成授权后能弹卡并允许', async () => {
  const { host, guest, roomId } = await pair({
    hostReply: '宿主这边。',
    guestReply: '本机执行才说的话。',
  })
  try {
    // 宿主 @ 加入方的 agent：这一轮要在加入方那台机器上跑。
    await command(host, 'msg.send', { roomId, text: '@阿甲 你说一句' })
    const notice = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.status === 'notice')
      },
      { label: '加入方只读时宿主收到的说明' },
    )
    assert.match(notice.text, /只读/)
    assert.equal(guest.prompts.length, 0, '加入方默认只读，不该跑')

    await command(guest, 'auth.set', { level: 'full' })
    await command(host, 'msg.send', { roomId, text: '@阿甲 再说一句' })
    const reply = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.find((message) => message.authorName === '阿甲' && message.status === 'sent')
      },
      { label: '完全授权之后加入方跑起来' },
    )
    assert.match(reply.text, /本机执行才说的话/)
    assert.equal(guest.prompts.length, 1)

    await command(guest, 'auth.set', { level: 'ask' })
    await command(host, 'msg.send', { roomId, text: '@阿甲 第三句' })
    const card = await until(
      async () => {
        const view = await snapshot(guest)
        return view.approvals[0] ?? null
      },
      { label: '加入方侧弹出待授权' },
    )
    assert.equal(card.agentName, '阿甲')
    assert.equal(card.fromName, '林岸', '卡片要说清是宿主那台机器上的人要它做')
    assert.equal(card.fromMachine, hostname(), '本机引出的派发要填本机名')
    await command(guest, 'auth.answer', { id: card.id, allow: true })
    const third = await until(
      async () => {
        const room = await roomOf(host, roomId)
        return room.messages.filter((message) => message.authorName === '阿甲' && message.status === 'sent')[1] ?? null
      },
      { label: '加入方允许之后回传落库' },
    )
    assert.match(third.text, /本机执行才说的话/)
  } finally {
    await disposeAll(guest, host)
  }
})

test('授权档位落盘：重启之后还是上次选的档；老 state.json 没这一项时按只读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-persist-'))
  const first = fakeCtx(dir, { reply: '无所谓' })
  const disposeFirst = await apply(first.ctx)
  const set = await call(first.routes, 'command', { action: 'auth.set', input: { level: 'full' } })
  assert.equal(set.ok, true, JSON.stringify(set.error))
  await disposeFirst()

  const second = fakeCtx(dir, { reply: '无所谓' })
  const disposeSecond = await apply(second.ctx)
  try {
    const view = await call(second.routes, 'snapshot', {})
    assert.equal(view.ok, true)
    assert.equal(view.value.auth.level, 'full', '档位要跟着 state.json 一起活下来')
  } finally {
    await disposeSecond()
  }

  // 旧版本写下的 state.json 里没有 auth：补成只读，绝不默认放行。
  const legacy = validateState({
    schema: 1,
    revision: 0,
    createdAt: new Date().toISOString(),
    self: { id: 'me', name: '我' },
    rooms: [],
    bots: [],
    links: [],
    activeRoomId: null,
  })
  assert.equal(legacy.auth.level, 'readonly')
  for (const bogus of ['yes', 'FULL', '', null]) {
    assert.equal(validateState({ ...legacy, auth: { level: bogus } }).auth.level, 'readonly')
  }
})

test('未知档位会被拒：界面不该能把授权设成一个不存在的值', async () => {
  const side = await boot('bad-level')
  try {
    const result = await call(side.routes, 'command', { action: 'auth.set', input: { level: 'always' } })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad_level')
  } finally {
    await disposeAll(side)
  }
})
