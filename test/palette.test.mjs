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
 * 虎鲸的颜色：每间屋里一人一档，起屋和进屋都要自己挑。
 *
 * 这层语义换过一次：颜色一开始跟着人走（self / bots 上存一份再映到成员），
 * 现在跟着房间走 —— 真源只有 room.members[].color。最容易错的地方有三个：
 *   1. 两处都存 → 改了一处另一处不动（本文件第 2 条盯着迁移把旧字段抹掉）；
 *   2. 改色只改了本机、没转发给宿主 → 两边各显示一个颜色；
 *   3. 「挑颜色」被当成「随便给一档」→ 抢了同屋别人那一档还静默换掉。
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

const command = async (side, action, input = {}) => call(side.routes, 'command', { action, input })

const ok = async (side, action, input = {}) => {
  const result = await command(side, action, input)
  assert.equal(result.ok, true, `${action} 应该成功：${JSON.stringify(result.error)}`)
  return result.value
}

const mirrorOf = (view) => view.rooms.find((room) => room.remote)
const membersByName = (room) => Object.fromEntries(room.members.map((member) => [member.name, member]))
const colorOf = (room, memberId) => room.members.find((member) => member.id === memberId)?.color ?? null

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

test('老存档迁移：旧的身份色被抹掉，成员色保留，缺的那几个按空档补且不撞色', () => {
  const state = {
    ...emptyState(),
    self: { id: 'me', name: '我', color: 'violet', colorPicked: true },
    bots: [
      { id: 'bot_a', name: 'Claude', role: '', color: 'teal' },
      { id: 'bot_b', name: 'GPT', role: '', color: 'teal' },
    ],
    rooms: [
      {
        id: 'rm_1',
        code: 'AAAAAA',
        name: '旧屋子',
        topic: '',
        rules: {},
        members: [
          { id: 'me', kind: 'human', name: '我', color: 'violet' },
          { id: 'm_bot_a', kind: 'bot', name: 'Claude', botId: 'bot_a' },
          { id: 'h_guest', kind: 'human', name: 'GUEST-A', owner: 'p_x' },
        ],
        messages: [],
      },
    ],
  }
  const next = validateState(state)
  // 颜色的真源只剩成员表：旧的两处不能再留着当第二个真相。
  assert.equal('color' in next.self, false, 'self 上不该再存颜色')
  assert.equal('colorPicked' in next.self, false)
  assert.equal('color' in next.bots[0], false, 'agent 上不该再存颜色')
  assert.equal(next.rooms[0].members[0].color, 'violet', '老存档里已经定下的座位色要原样留着')
  assert.equal(next.rooms[0].members[1].color, 'frost', '没色的 agent 成员补一档，而不是继承 bot 上的 teal')
  assert.ok(isWhaleColor(next.rooms[0].members[2].color), '别人的人也要有颜色，不能是 undefined')
  assert.notEqual(
    next.rooms[0].members[2].color,
    next.rooms[0].members[0].color,
    '同屋不能补出两个一样的颜色',
  )
  // 已经是合法值的成员色不许被改写：颜色是用户的决定。
  const kept = validateState({
    ...next,
    schema: SCHEMA,
    rooms: [
      {
        ...next.rooms[0],
        members: next.rooms[0].members.map((member) => ({ ...member, color: 'coral' })),
      },
    ],
  })
  assert.deepEqual(
    kept.rooms[0].members.map((member) => member.color),
    ['coral', 'coral', 'coral'],
    '已经是合法值的存档不归一化：旧数据里有重复色也照原样留着',
  )
})

test('建屋：挑的那一档落到屋里「我」身上；不给颜色也能建（脚本/旧客户端）', async () => {
  const side = await boot('create')
  try {
    const coral = await ok(side, 'room.create', { name: '珊瑚屋', color: 'coral' })
    assert.equal(coral.self.color, 'coral', '刚建好时当前屋就是我刚挑的那一档')
    const coralRoom = coral.rooms.find((row) => row.name === '珊瑚屋')
    assert.equal(colorOf(coralRoom, coral.self.id), 'coral')

    const plain = await ok(side, 'room.create', { name: '没挑的屋' })
    assert.equal(plain.self.color, 'frost', '没给颜色就铺第一档，不让建屋失败')

    // 两间屋各坐各的：回到珊瑚屋，我的颜色还是珊瑚。
    const back = await ok(side, 'room.activate', { roomId: coralRoom.id })
    assert.equal(back.self.color, 'coral', '换屋子要换成那间屋里我的颜色')
  } finally {
    await side.dispose()
  }
})

test('self.color 只改当前这间屋；被同屋别人占着的那一档要报 color_taken', async () => {
  const side = await boot('self')
  try {
    const a = await ok(side, 'room.create', { name: '甲屋', color: 'coral' })
    const roomA = a.rooms.find((row) => row.name === '甲屋')
    // 甲屋里给 agent 占掉 sky。
    await ok(side, 'member.createBot', { roomId: roomA.id, name: 'Claude', role: '', color: 'sky' })
    const b = await ok(side, 'room.create', { name: '乙屋', color: 'amber' })
    const roomB = b.rooms.find((row) => row.name === '乙屋')
    assert.equal(b.self.color, 'amber')

    const changed = await ok(side, 'self.color', { roomId: roomA.id, color: 'moss' })
    assert.equal(changed.self.color, 'amber', '当前显示的仍是乙屋（动作改的是甲屋）')
    const inA = changed.rooms.find((row) => row.id === roomA.id)
    assert.equal(colorOf(inA, 'me'), 'moss', '甲屋里「我」换成了苔绿')
    assert.equal(colorOf(changed.rooms.find((row) => row.id === roomB.id), 'me'), 'amber', '乙屋不动')
    const backB = await ok(side, 'room.activate', { roomId: roomB.id })
    assert.equal(backB.self.color, 'amber', '另一间屋的颜色不该被顺手改掉')

    const bad = await command(side, 'self.color', { roomId: roomB.id, color: 'hotpink' })
    assert.equal(bad.ok, false, '不在表里的颜色应该被拒')
    assert.equal(bad.error.code, 'bad_color')

    const taken = await command(side, 'self.color', { roomId: roomA.id, color: 'sky' })
    assert.equal(taken.ok, false, 'agent 已经坐着的那一档不能被我抢走')
    assert.equal(taken.error.code, 'color_taken')
    const after = await ok(side, 'room.activate', { roomId: roomA.id })
    assert.equal(after.self.color, 'moss', '被拒之后不该改动任何东西')
    assert.equal(colorOf(after.rooms.find((row) => row.id === roomA.id), 'me'), 'moss')
  } finally {
    await side.dispose()
  }
})

test('agent：新建时挑的那一档只作用于这间屋；同一档被占要报错；bot.update 不再带颜色', async () => {
  const side = await boot('bot')
  try {
    const created = await ok(side, 'room.create', { name: '三只鲸', color: 'frost' })
    const roomId = created.rooms[0].id
    const first = await ok(side, 'member.createBot', { roomId, name: 'Claude', role: '', color: 'teal' })
    const second = await ok(side, 'member.createBot', { roomId, name: 'GPT', role: '' })
    const rowFirst = first.rooms[0].members.find((member) => member.name === 'Claude')
    const rowSecond = second.rooms[0].members.find((member) => member.name === 'GPT')
    assert.equal(rowFirst.color, 'teal', '人给 agent 挑的颜色要落到这间屋的成员上')
    assert.notEqual(rowSecond.color, rowFirst.color, '没挑的那只拿一档屋里空着的')
    assert.notEqual(rowSecond.color, 'frost', '也不能和屋里的人撞')

    const clash = await ok(side, 'member.createBot', { roomId, name: '第三只', color: 'teal' })
    const third = clash.rooms[0].members.find((member) => member.name === '第三只')
    // 建成员这一侧不因为撞色失败（对面那台可能刚报上来一个 agent，界面不该报红），
    // 但绝不能把两行写成同一个颜色：抢不到就给一档空的。
    assert.notEqual(third.color, 'teal', '撞色时不能和屋里已有的成员同色')
    assert.notEqual(third.color, 'frost')
    assert.notEqual(third.color, rowFirst.color)

    const swap = await ok(side, 'member.update', {
      roomId,
      memberId: rowFirst.id,
      patch: { color: 'coral' },
    })
    const rowSwapped = swap.rooms[0].members.find((member) => member.id === rowFirst.id)
    assert.equal(rowSwapped.color, 'coral', '改 agent 的色要落到这间屋的成员上')

    const taken = await command(side, 'member.update', {
      roomId,
      memberId: rowSecond.id,
      patch: { color: 'coral' },
    })
    assert.equal(taken.ok, false, '同屋两个成员不能坐同一档')
    assert.equal(taken.error.code, 'color_taken')

    // 名字/职责仍由 bot.update 管；带上 color 也不该把成员色改掉（颜色不走那一层）。
    const renamed = await ok(side, 'bot.update', { botId: rowFirst.botId, name: 'Claude 2', color: 'moss' })
    const rowRenamed = renamed.rooms[0].members.find((member) => member.botId === rowFirst.botId)
    assert.equal(rowRenamed.name, 'Claude 2')
    assert.equal(rowRenamed.color, 'coral', 'bot.update 不再搬颜色，成员色只能由 member.update 改')
  } finally {
    await side.dispose()
  }
})

test('LAN：加入必须报自己挑的那一档；两个人抢同一档，后来的人进不来', async () => {
  const host = await boot('host')
  const guest = await boot('guest')
  try {
    const created = await ok(host, 'room.create', { name: '跨机器配色', color: 'frost' })
    const roomId = created.rooms[0].id
    await ok(host, 'member.createBot', { roomId, name: 'Claude', role: '账期' })
    const port = (await snapshot(host)).lan.port

    const taken = await command(guest, 'lan.join', {
      host: '127.0.0.1',
      port,
      code: created.rooms[0].code,
      machine: 'GUEST-B',
      color: 'frost',
    })
    assert.equal(taken.ok, false, '宿主自己坐着霜白，第二个人不能也挑霜白')
    assert.equal(taken.error.code, 'color_taken')
    // 没进屋：成员数不变。
    const afterFail = (await snapshot(host)).rooms.find((row) => row.id === roomId)
    assert.equal(afterFail.members.length, 2, '被拒的加入不该留下半个成员')

    // 加入方带一只自己的 agent 进来：它的颜色由宿主按空档安排（人不在这间屋里给它挑）。
    await ok(guest, 'bot.create', { name: '阿甲', role: '退货' })

    await ok(guest, 'lan.join', {
      host: '127.0.0.1',
      port,
      code: created.rooms[0].code,
      machine: 'GUEST-A',
      color: 'teal',
    })

    const hostRoom = await until(
      async () => {
        const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
        return room && room.members.length >= 3 ? room : null
      },
      { label: '宿主看到加入方的人和 agent' },
    )
    const humans = hostRoom.members.filter((member) => member.kind === 'human')
    assert.equal(humans.length, 2)
    const inHost = membersByName(hostRoom)
    assert.equal(inHost['GUEST-A'].color, 'teal', '加入表单里挑的那一档要跟着人进来')
    // agent 不随身带颜色：宿主按空档给它一档，且不能和屋里已有的两档重复。
    const guestAgent = hostRoom.members.find((member) => member.kind === 'bot' && member.name === '阿甲')
    assert.ok(guestAgent, '加入方带的 agent 应该进屋')
    assert.ok(isWhaleColor(guestAgent.color))
    assert.notEqual(guestAgent.color, 'teal')
    assert.notEqual(guestAgent.color, 'frost')

    // 加入方改色：宿主跟着变，自己的镜像也当场跟着变。
    const changed = await ok(guest, 'self.color', { roomId: mirrorOf(await snapshot(guest)).id, color: 'coral' })
    assert.equal(changed.self.color, 'coral', '宿主回的投影直接刷新镜像，不用等下一轮长轮询')
    const hostChanged = (await snapshot(host)).rooms.find((row) => row.id === roomId)
    assert.equal(membersByName(hostChanged)['GUEST-A'].color, 'coral')

    const mirror = mirrorOf(await snapshot(guest))
    assert.equal(membersByName(mirror)['GUEST-A'].color, 'coral', '镜像里自己也是新颜色')

    // 加入方去抢宿主那一档：宿主拒绝，两边都不动。
    const stolen = await command(guest, 'self.color', {
      roomId: mirrorOf(await snapshot(guest)).id,
      color: 'frost',
    })
    assert.equal(stolen.ok, false)
    assert.equal(stolen.error.code, 'color_taken')
    assert.equal(
      membersByName((await snapshot(host)).rooms.find((row) => row.id === roomId))['GUEST-A'].color,
      'coral',
      '被拒之后宿主那边不该动',
    )
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('LAN：没带颜色的旧加入方仍然进得来，拿一档屋里空着的', async () => {
  const host = await boot('host2')
  const guest = await boot('guest2')
  try {
    const created = await ok(host, 'room.create', { name: '旧客户端进屋', color: 'frost' })
    const port = (await snapshot(host)).lan.port
    await ok(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-D' })

    const room = await until(
      async () => {
        const row = (await snapshot(host)).rooms.find((entry) => entry.id === created.rooms[0].id)
        return row && row.members.length === 2 ? row : null
      },
      { label: '宿主看到进来的人' },
    )
    const hostMe = room.members.find((member) => member.kind === 'human' && member.id === 'me')
    const guestMe = room.members.find((member) => member.kind === 'human' && member.id !== 'me')
    assert.equal(hostMe.color, 'frost', '本机的人挑的那一档不动')
    assert.notEqual(guestMe.color, 'frost', '没带颜色的人进屋，要换成一档屋里没人用的')
    assert.ok(isWhaleColor(guestMe.color))
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('whaleFor / 颜色表：铺色不会越界，负数与小数都能落到表里', () => {
  for (let i = -5; i < 40; i += 1) assert.ok(isWhaleColor(whaleFor(i)), `whaleFor(${i}) 应该落在一档里`)
  assert.equal(whaleFor(0), WHALE_COLORS[0])
  assert.equal(whaleFor(WHALE_COLORS.length), WHALE_COLORS[0], '取模：第九个回到第一种')
  assert.equal(whaleFor(2.7), WHALE_COLORS[2])
})
