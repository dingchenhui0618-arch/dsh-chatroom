import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { WHALE_COLORS, isWhaleColor, whaleFor } from '../src/host/palette.js'
import { SCHEMA, emptyState, validateState } from '../src/host/state.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 虎鲸的颜色：每个人、每个 agent 可以挑不一样的。
 *
 * 这条链路最容易断在「两边各存一套」上：宿主只认 id、色值在客户端，
 * 存档里再加一层成员镜像（bot 的色要映到成员上）。所以这份用例盯三件事：
 *   1. 两份 id 列表没有漂移（客户端多一档少一档都要红）；
 *   2. 老存档补齐之后不是「人人同一个色」；
 *   3. 改色要真的映到屋里那个人身上，而不是只改了 self 上那个字段。
 */

const here = fileURLToPath(new URL('..', import.meta.url))

process.env.DSH_CHATROOM_PORT = '0'

const boot = async (name, options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), `whale-${name}-`))
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
  return result
}

const ok = async (side, action, input = {}) => {
  const result = await command(side, action, input)
  assert.equal(result.ok, true, `${action} 应该成功：${JSON.stringify(result.error)}`)
  return result.value
}

const mirrorOf = (view) => view.rooms.find((room) => room.remote)
const membersByName = (room) => Object.fromEntries(room.members.map((member) => [member.name, member]))

test('客户端与宿主是同一份颜色表：id 一一对应，色值互不相同', async () => {
  const client = await readFile(join(here, 'lib/client.js'), 'utf8')
  const block = client.match(/var WHALE = \[([\s\S]*?)\n {4}\]/)
  assert.ok(block, 'lib/client.js 里应该能找到 WHALE 颜色表')
  const rows = [...block[1].matchAll(/\['([a-z]+)', '(#[0-9a-f]{6})'\]/g)].map((row) => ({
    id: row[1],
    hex: row[2],
  }))
  assert.deepEqual(
    rows.map((row) => row.id),
    WHALE_COLORS,
    '两颗颜色表不一致：改了宿主那张就要改客户端那张（顺序也是 id → 颜色）',
  )
  assert.equal(new Set(rows.map((row) => row.hex)).size, rows.length, '色值不能重复，否则两个成员看着一样')
  for (const row of rows) assert.ok(isWhaleColor(row.id), `${row.id} 应该是宿主认的 id`)
})

test('老存档补齐：self 有默认色，两个 agent 不会撞成同一个颜色，成员跟着各自的身份走', () => {
  const state = {
    ...emptyState(),
    self: { id: 'me', name: '我' },
    bots: [
      { id: 'bot_a', name: 'Claude', role: '' },
      { id: 'bot_b', name: 'GPT', role: '' },
    ],
    rooms: [
      {
        id: 'rm_1',
        code: 'AAAAAA',
        name: '旧屋子',
        topic: '',
        rules: {},
        members: [
          { id: 'me', kind: 'human', name: '我' },
          { id: 'm_bot_a', kind: 'bot', name: 'Claude', botId: 'bot_a' },
          { id: 'h_guest', kind: 'human', name: 'GUEST-A', owner: 'p_x' },
        ],
        messages: [],
      },
    ],
  }
  const next = validateState(state)
  assert.equal(next.self.color, 'frost', '没挑过就是霜白')
  assert.notEqual(next.bots[0].color, next.bots[1].color, '两个 agent 应该铺成两种颜色')
  assert.equal(next.rooms[0].members[0].color, 'frost', '我在屋里的成员色跟着 self')
  assert.equal(next.rooms[0].members[1].color, next.bots[0].color, 'agent 成员的颜色跟着那个 agent')
  assert.ok(isWhaleColor(next.rooms[0].members[2].color), '别人的人也要有颜色，不能是 undefined')
  // 已经是合法值的存档不许被改写：颜色是用户的决定。
  const kept = validateState({
    ...next,
    schema: SCHEMA,
    self: { ...next.self, color: 'violet' },
  })
  assert.equal(kept.self.color, 'violet')
})

test('self.color：自选颜色映到每间本机房间里，坏值被挡掉且不留半截改动', async () => {
  const side = await boot('self')
  try {
    const created = await ok(side, 'room.create', { name: '配色间' })
    await ok(side, 'member.createBot', { roomId: created.rooms[0].id, name: 'Claude', role: '' })

    const bad = await command(side, 'self.color', { color: 'hotpink' })
    assert.equal(bad.ok, false, '不在表里的颜色应该被拒')
    assert.equal((await snapshot(side)).self.color, 'frost', '被拒之后不该改动任何东西')

    const next = await ok(side, 'self.color', { color: 'coral' })
    assert.equal(next.self.color, 'coral')
    const room = next.rooms.find((row) => row.id === created.rooms[0].id)
    const me = room.members.find((member) => member.id === next.self.id)
    assert.equal(me.color, 'coral', '屋里「我」这个成员要换色，否则消息行还是旧颜色')
  } finally {
    await side.dispose()
  }
})

test('bot.update 改色映到成员；bot.create 不给颜色时按顺序铺开', async () => {
  const side = await boot('bot')
  try {
    const created = await ok(side, 'room.create', { name: '三个 agent' })
    const roomId = created.rooms[0].id
    const first = await ok(side, 'member.createBot', { roomId, name: 'Claude', role: '' })
    const second = await ok(side, 'member.createBot', { roomId, name: 'GPT', role: '' })
    const bots = ((await snapshot(side)).bots || []).filter((bot) => bot.id !== undefined)
    assert.equal(bots.length, 2)
    assert.notEqual(bots[0].color, bots[1].color, '连着建两个 agent 不该是同一个颜色')

    const target = first.bots[0]
    const after = await ok(side, 'bot.update', { botId: target.id, color: 'teal' })
    const room = after.rooms.find((row) => row.id === roomId)
    const member = room.members.find((row) => row.botId === target.id)
    assert.equal(member.color, 'teal', '改了 agent 的颜色，成员列那一行也要跟着换')

    // 只改颜色不该把名字/职责冲掉（旧实现只在 name/role 存在时才写，这里守住这一点）。
    assert.equal(member.name, target.name)
    assert.equal(second.bots.length, 2)
  } finally {
    await side.dispose()
  }
})

test('LAN：加入时带过来的颜色要落到宿主屋里，改色两边都跟上', async () => {
  const host = await boot('host')
  const guest = await boot('guest')
  try {
    const created = await ok(host, 'room.create', { name: '跨机器配色' })
    const roomId = created.rooms[0].id
    await ok(host, 'member.createBot', { roomId, name: 'Claude', role: '账期' })
    const port = (await snapshot(host)).lan.port

    await ok(guest, 'room.create', { name: '我的屋子' })
    await ok(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿甲', role: '退货' })
    await ok(guest, 'self.rename', { name: '周荻' })
    await ok(guest, 'self.color', { color: 'teal' })
    const guestBot = (await snapshot(guest)).bots[0]
    await ok(guest, 'bot.update', { botId: guestBot.id, color: 'amber' })

    await ok(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-A' })

    const hostRoom = await until(
      async () => {
        const view = await snapshot(host)
        const room = view.rooms.find((row) => row.id === roomId)
        return room && room.members.length >= 3 ? room : null
      },
      { label: '宿主看到加入方的人和 agent' },
    )
    const inHost = membersByName(hostRoom)
    assert.equal(inHost['周荻'].color, 'teal', '对面挑的颜色要跟着人进来')
    assert.equal(inHost['阿甲'].color, 'amber', 'agent 的颜色也要跟着进来')
    assert.notEqual(inHost['周荻'].color, inHost.Claude.color, '两台机器的人不该撞成同一个颜色')

    // 加入方改色：宿主那边要跟着变，它自己的镜像也要跟着变（两处都看才叫「同步」）。
    await ok(guest, 'self.color', { color: 'coral' })
    const renamed = await until(
      async () => {
        const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
        const member = room && membersByName(room)['周荻']
        return member && member.color === 'coral' ? member : null
      },
      { label: '宿主跟上加入方的新颜色' },
    )
    assert.equal(renamed.color, 'coral')

    const mirror = await until(
      async () => {
        const room = mirrorOf(await snapshot(guest))
        const member = room && membersByName(room)['周荻']
        return member && member.color === 'coral' ? member : null
      },
      { label: '加入方镜像里的自己也是新颜色' },
    )
    assert.equal(mirror.color, 'coral')
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('两个都是默认色的人先后进屋：不会都挂在霜白上', async () => {
  const host = await boot('host2')
  const guest = await boot('guest2')
  try {
    const created = await ok(host, 'room.create', { name: '默认色进屋' })
    const port = (await snapshot(host)).lan.port
    // 加入方什么都不挑：它自己那台也是霜白。
    assert.equal((await snapshot(guest)).self.color, 'frost')
    await ok(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-D' })

    const room = await until(
      async () => {
        const view = await snapshot(host)
        const row = view.rooms.find((entry) => entry.id === created.rooms[0].id)
        return row && row.members.length === 2 ? row : null
      },
      { label: '宿主看到进来的人' },
    )
    const hostMe = room.members.find((member) => member.kind === 'human' && member.id === 'me')
    const guestMe = room.members.find((member) => member.kind === 'human' && member.id !== 'me')
    assert.equal(hostMe.color, 'frost', '本机的人是自己挑的位置，不动')
    assert.notEqual(guestMe.color, 'frost', '没点过颜色的人进屋，要换成一档屋里没人用的')
    assert.ok(isWhaleColor(guestMe.color))
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('whaleFor：铺色不会越界，负数与小数都能落到表里', () => {
  for (let i = -5; i < 40; i += 1) assert.ok(isWhaleColor(whaleFor(i)), `whaleFor(${i}) 应该落在一档里`)
  assert.equal(whaleFor(0), WHALE_COLORS[0])
  assert.equal(whaleFor(WHALE_COLORS.length), WHALE_COLORS[0], '取模：第九个回到第一种')
  assert.equal(whaleFor(2.7), WHALE_COLORS[2])
})
