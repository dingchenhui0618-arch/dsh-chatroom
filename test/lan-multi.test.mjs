import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 三台机器同屋（宿主 + 两台加入方）。
 *
 * 为什么单开一个文件：之前的 LAN 测试只有「宿主 + 一台机器」。两台以上时最容易错的不是
 * 连接，而是**归属**——谁的人和 agent 是谁的、谁的话该标成哪台机器的、一轮该派给哪台。
 * 这些错了不会报错，只会让人在界面里看到「陈默」的消息显示成「本机发的」。
 */

process.env.DSH_CHATROOM_PORT = '0'

async function boot(name, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `multi-${name}-`))
  // 这组用例演的是跨机派发本身，不是授权门：显式开到完全授权。
  // 默认档位是只读，那道门单独在 test/auth-gate.test.mjs 里测。
  const { auth = 'full', ...rest } = options
  const fake = fakeCtx(dir, rest)
  const dispose = await apply(fake.ctx)
  if (auth) {
    const granted = await call(fake.routes, 'command', { action: 'auth.set', input: { level: auth } })
    if (!granted.ok) throw new Error(`设置本机授权失败：${JSON.stringify(granted.error)}`)
  }
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

const mirrorOf = (view) => view.rooms.find((room) => room.remote)
const membersByName = (room) => Object.fromEntries(room.members.map((member) => [member.name, member]))

test('三方同屋：两台机器同时加入，成员归属与消息来源都不串台', async () => {
  const host = await boot('host', { reply: '宿主这边：数对得上。' })
  const alice = await boot('alice', { reply: '甲这边：退货率 7.1%。' })
  const bob = await boot('bob', { reply: '乙这边：尾货占六成。' })
  try {
    // ---- 宿主：一间屋子 + 一个本机 agent
    const created = await command(host, 'room.create', { name: '三方对账', topic: '三台机器的账' })
    const roomId = created.rooms[0].id
    await command(host, 'member.createBot', { roomId, name: 'Claude', role: '账期' })
    const port = (await snapshot(host)).lan.port

    // ---- 两台加入方：各自有自己的 agent 与自己的名字
    await command(alice, 'room.create', { name: '甲的屋子' })
    await command(alice, 'member.createBot', { roomId: (await snapshot(alice)).rooms[0].id, name: '阿甲', role: '退货' })
    await command(alice, 'self.rename', { name: '周荻' })
    await command(bob, 'room.create', { name: '乙的屋子' })
    await command(bob, 'member.createBot', { roomId: (await snapshot(bob)).rooms[0].id, name: '阿乙', role: '库存' })
    await command(bob, 'self.rename', { name: '陈默' })

    await command(alice, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-A' })
    await command(bob, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-B' })

    // ---- 宿主视角：6 个人，两台机器的人和 agent 都标 LAN，且能认出是哪台机器
    const hostView = await snapshot(host)
    const hostRoom = hostView.rooms.find((room) => room.id === roomId)
    assert.equal(hostRoom.members.length, 6, `应该有 6 个成员，实际 ${hostRoom.members.map((m) => m.name).join('/')}`)
    const inHost = membersByName(hostRoom)
    assert.equal(inHost.Claude.origin.kind, 'local')
    for (const name of ['周荻', '阿甲']) {
      assert.equal(inHost[name].origin.kind, 'lan', `${name} 在宿主这边应该标 LAN`)
      assert.equal(inHost[name].origin.machine, 'GUEST-A', `${name} 应该能认出是 A 那台机器`)
    }
    for (const name of ['陈默', '阿乙']) {
      assert.equal(inHost[name].origin.kind, 'lan', `${name} 在宿主这边应该标 LAN`)
      assert.equal(inHost[name].origin.machine, 'GUEST-B', `${name} 应该能认出是 B 那台机器`)
    }
    assert.equal(hostView.lan.peers.length, 2, '宿主应该认得两台机器')

    // ---- A 的视角：自己是本机、带着自己的 agent 是本机；宿主和 B 都是 LAN，且分别标机器名
    // A 比 B 先进屋，所以它要等下一条长轮询把 B 的成员带过来 —— 这就是真实行为，不是延迟 bug。
    const aliceRoom = await until(async () => {
      const room = mirrorOf(await snapshot(alice))
      return room && room.members.length === 6 ? room : null
    }, { label: 'A 的镜像跟上两台机器的成员' })
    const inAlice = membersByName(aliceRoom)
    assert.equal(inAlice['周荻'].id, 'me')
    assert.equal(inAlice['周荻'].origin.kind, 'local')
    assert.equal(inAlice['阿甲'].origin.kind, 'local', '我自己带的 agent，在我这台机器上就是本机')
    assert.equal(inAlice.Claude.origin.kind, 'lan')
    assert.equal(inAlice['陈默'].origin.kind, 'lan', 'B 的人对 A 是远程')
    assert.equal(inAlice['陈默'].origin.machine, 'GUEST-B', 'A 要能看出这是 B 那台机器的人')
    assert.equal(inAlice['阿乙'].origin.machine, 'GUEST-B')

    // ---- B 的视角对称
    const bobRoom = mirrorOf(await snapshot(bob))
    const inBob = membersByName(bobRoom)
    assert.equal(inBob['陈默'].origin.kind, 'local')
    assert.equal(inBob['阿乙'].origin.kind, 'local')
    assert.equal(inBob['周荻'].origin.machine, 'GUEST-A')
    assert.equal(inBob['阿甲'].origin.kind, 'lan')

    // ---- A 说一句：宿主与 B 都要收到，且在 B 那边不能标成「本机」
    await command(alice, 'msg.send', { roomId: aliceRoom.id, text: '甲：我先把退货率放上来。' })
    const atHost = await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.text.includes('我先把退货率'))
    }, { label: '宿主收到 A 的消息' })
    assert.equal(atHost.authorName, '周荻')
    assert.equal(atHost.origin.kind, 'lan')
    assert.equal(atHost.origin.machine, 'GUEST-A')

    const atBob = await until(async () => {
      const room = mirrorOf(await snapshot(bob))
      return room ? room.messages.find((message) => message.text.includes('我先把退货率')) : null
    }, { label: 'B 的镜像收到 A 的消息' })
    assert.equal(atBob.origin.kind, 'lan', 'A 的话在 B 那边必须是远程')
    assert.equal(atBob.origin.machine, 'GUEST-A', 'B 要看出这话来自 A 那台机器，而不是自己也说不定')

    // ---- 群发一个 @阿乙：只能派给 B，A 和宿主都不许替它跑
    await command(host, 'msg.send', { roomId, text: '@阿乙 尾货现在多少？' })
    const answer = await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.authorName === '阿乙')
    }, { label: 'B 的 agent 回复落进宿主房间' })
    assert.equal(answer.origin.kind, 'lan')
    assert.equal(answer.origin.machine, 'GUEST-B', 'B 的 agent 的话要标成 B 那台机器')
    assert.match(answer.text, /尾货占六成/)
    assert.equal(bob.prompts.length, 1, 'B 应该被派发这一轮')
    assert.equal(alice.prompts.length, 0, 'A 不该被派发别人的回合')
    assert.equal(host.prompts.length, 0, '宿主不该替远程 agent 调模型')

    // ---- A 的镜像也看得到这条回复，来源仍然是 B
    const atAlice = await until(async () => {
      const room = mirrorOf(await snapshot(alice))
      return room ? room.messages.find((message) => message.authorName === '阿乙') : null
    }, { label: 'A 的镜像收到 B 的 agent 回复' })
    assert.equal(atAlice.origin.kind, 'lan')
    assert.equal(atAlice.origin.machine, 'GUEST-B')
  } finally {
    await bob.dispose().catch(() => {})
    await alice.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('全员轮次跨两台机器：三台机器上各有一个 agent，一轮里各说一次', async () => {
  const host = await boot('host3', { reply: '宿主：我这边的数报完了。' })
  const alice = await boot('alice3', { reply: '甲这边：退货率 7.1%。' })
  const bob = await boot('bob3', { reply: '乙这边：尾货占六成。' })
  try {
    const created = await command(host, 'room.create', { name: '全员报数' })
    const roomId = created.rooms[0].id
    await command(host, 'member.createBot', { roomId, name: 'Claude' })
    await command(host, 'room.update', { roomId, rules: { roundRobin: true } })
    const port = (await snapshot(host)).lan.port

    await command(alice, 'room.create', { name: '甲的屋子' })
    await command(alice, 'member.createBot', { roomId: (await snapshot(alice)).rooms[0].id, name: '阿甲' })
    await command(alice, 'self.rename', { name: '周荻' })
    await command(bob, 'room.create', { name: '乙的屋子' })
    await command(bob, 'member.createBot', { roomId: (await snapshot(bob)).rooms[0].id, name: '阿乙' })
    await command(bob, 'self.rename', { name: '陈默' })
    await command(alice, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-A' })
    await command(bob, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-B' })

    // 一句不带 @ 的话：靠「全员轮次」让三个 agent 各说一句，预算正好是 3
    await command(host, 'msg.send', { roomId, text: '三边都报一下本月的数。' })

    const room = await until(async () => {
      const now = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      const bots = now.messages.filter((message) => message.authorKind === 'bot')
      return bots.length >= 3 ? now : null
    }, { label: '三个 agent 各说一句', timeoutMs: 8000 })

    const bots = room.messages.filter((message) => message.authorKind === 'bot')
    assert.deepEqual(bots.map((message) => message.authorName).sort(), ['Claude', '阿乙', '阿甲'].sort())
    assert.equal(host.prompts.length, 1, '宿主只跑自己那个 agent')
    assert.equal(alice.prompts.length, 1, 'A 只被派发一轮')
    assert.equal(bob.prompts.length, 1, 'B 只被派发一轮')

    // 来源不能串：宿主的 agent 是本机，两台机器的 agent 各标自己的机器
    const byAuthor = Object.fromEntries(bots.map((message) => [message.authorName, message]))
    assert.equal(byAuthor.Claude.origin.kind, 'local')
    assert.equal(byAuthor['阿甲'].origin.kind, 'lan')
    assert.equal(byAuthor['阿甲'].origin.machine, 'GUEST-A')
    assert.equal(byAuthor['阿乙'].origin.kind, 'lan')
    assert.equal(byAuthor['阿乙'].origin.machine, 'GUEST-B')

    // 等一会儿：一轮结束后不该再冒出重复回复（同一个人一轮只说一次）
    await new Promise((resolve) => setTimeout(resolve, 600))
    const settled = (await snapshot(host)).rooms.find((row) => row.id === roomId)
    assert.equal(
      settled.messages.filter((message) => message.authorKind === 'bot').length,
      3,
      '一轮之内每个 agent 只能说一次，不能因为跨机器就重复派发',
    )
    assert.equal(alice.prompts.length, 1, 'A 不能被派发第二次')
    assert.equal(bob.prompts.length, 1, 'B 不能被派发第二次')
  } finally {
    await bob.dispose().catch(() => {})
    await alice.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('主持人指派跨机器：主席在 B 那台机器，它 @ 的 A 那台机器上的 agent 要能接上', async () => {
  const host = await boot('host4', { reply: '宿主：我这边先不说了。' })
  const alice = await boot('alice4', { reply: '甲：那我补一句，退货率 7.1%。' })
  // 主席（B 那台机器的 agent）的回复里 @ 了 A 那台机器的 agent —— 这一句得在宿主那边被认出来，
  // 再把下一轮派到 A。跨机器的 @ 识别是最容易断的一环：文字是从 HTTP 回传到宿主才落库的。
  const bob = await boot('bob4', { reply: '乙：我建议听 @阿甲 的，他那边有数。' })
  try {
    const created = await command(host, 'room.create', { name: '听主席的' })
    const roomId = created.rooms[0].id
    await command(host, 'member.createBot', { roomId, name: 'Claude' })
    const port = (await snapshot(host)).lan.port

    await command(alice, 'room.create', { name: '甲的屋子' })
    await command(alice, 'member.createBot', { roomId: (await snapshot(alice)).rooms[0].id, name: '阿甲' })
    await command(alice, 'self.rename', { name: '周荻' })
    await command(bob, 'room.create', { name: '乙的屋子' })
    await command(bob, 'member.createBot', { roomId: (await snapshot(bob)).rooms[0].id, name: '阿乙' })
    await command(bob, 'self.rename', { name: '陈默' })
    await command(alice, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-A' })
    await command(bob, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-B' })

    // 把主席指派给 B 那台机器的 agent
    const chairId = (await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.members.find((member) => member.name === '阿乙')
    }, { label: '宿主看到 B 的 agent' })).id
    await command(host, 'room.update', { roomId, rules: { chairId } })

    await command(host, 'msg.send', { roomId, text: '先听乙那边的意见。' })

    const room = await until(async () => {
      const now = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      const gotChair = now.messages.some((message) => message.authorName === '阿乙')
      const gotFollow = now.messages.some((message) => message.authorName === '阿甲')
      return gotChair && gotFollow ? now : null
    }, { label: '主席发话后把它 @ 的 agent 接上', timeoutMs: 8000 })

    assert.equal(bob.prompts.length, 1, '主席在 B 那台机器上跑')
    assert.equal(alice.prompts.length, 1, '主席 @ 到的 A 那台机器的 agent 也要被派发')
    assert.equal(host.prompts.length, 0, '宿主这边不该被拉进来跑模型')

    const byAuthor = Object.fromEntries(
      room.messages.filter((message) => message.authorKind === 'bot').map((message) => [message.authorName, message]),
    )
    assert.equal(byAuthor['阿乙'].origin.machine, 'GUEST-B')
    assert.equal(byAuthor['阿甲'].origin.machine, 'GUEST-A')
  } finally {
    await bob.dispose().catch(() => {})
    await alice.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('第三方离开：只撤它的人与 agent，另外两台不受影响', async () => {
  const host = await boot('host2', { reply: '宿主' })
  const alice = await boot('alice2', { reply: '甲' })
  const bob = await boot('bob2', { reply: '乙' })
  try {
    const created = await command(host, 'room.create', { name: '有人先走' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port

    await command(alice, 'room.create', { name: '甲的屋子' })
    await command(alice, 'member.createBot', { roomId: (await snapshot(alice)).rooms[0].id, name: '阿甲' })
    await command(bob, 'room.create', { name: '乙的屋子' })
    await command(bob, 'member.createBot', { roomId: (await snapshot(bob)).rooms[0].id, name: '阿乙' })

    await command(alice, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-A' })
    const bobJoined = await command(bob, 'lan.join', {
      host: '127.0.0.1',
      port,
      code: created.rooms[0].code,
      machine: 'GUEST-B',
    })
    assert.equal(mirrorOf(await snapshot(bob)).members.length, 5)

    // B 主动离开
    await command(bob, 'lan.leave', { linkId: bobJoined.links[0].id })

    const hostAfter = await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.members.length === 3 ? room : null
    }, { label: '宿主撤掉 B 的两条成员' })
    // A 没有单独改名，自称和宿主都叫「我」——这时用机器名兜底，屋里才不会出现两个「我」。
    assert.deepEqual(hostAfter.members.map((member) => member.name).sort(), ['GUEST-A', '我', '阿甲'].sort())
    assert.equal((await snapshot(host)).lan.peers.length, 1, '只剩 A 一台机器')
    assert.equal((await snapshot(bob)).links.length, 0)
    assert.equal((await snapshot(bob)).rooms.some((room) => room.remote), false)

    // A 的镜像里 B 消失，自己的成员还在
    const aliceAfter = await until(async () => {
      const room = mirrorOf(await snapshot(alice))
      return room && !room.members.some((member) => member.name === '陈默' || member.name === '阿乙') ? room : null
    }, { label: 'A 的镜像里 B 消失' })
    const names = aliceAfter.members.map((member) => member.name).sort()
    assert.equal(names.includes('GUEST-A'), true, 'A 自己的人还在（没单独改名，用的是机器名兜底）')
    assert.equal(names.includes('阿甲'), true, 'A 自己带的 agent 还在')
    assert.equal(aliceAfter.remote.lost, undefined, 'A 还在屋里，镜像不该被标成已解散')
  } finally {
    await bob.dispose().catch(() => {})
    await alice.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})
