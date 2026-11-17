import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, tick, until } from './helpers/fake-ctx.mjs'

/**
 * 两台机器的端到端：真的起 node:http 监听、真的走局域网协议的 HTTP 请求，
 * 两个独立的插件实例（各自的 state、各自的 agent 目录），只把模型换成假的。
 *
 * 这条链路里唯一没被验证的是「信号能穿透两台物理机器的防火墙」，
 * 但协议、鉴权、归属、派发、回传、镜像、失败占位都是真跑的。
 */

// 让系统挑端口：测试不该和本机正在跑的宿主抢 4399。
process.env.DSH_CHATROOM_PORT = '0'

async function boot(name, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `lan-${name}-`))
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

const membersByName = (room) => Object.fromEntries(room.members.map((member) => [member.name, member]))

test('LAN 全链路：加入 → 双向发言 → 派发远程 agent → 回传落库 → 离开', async () => {
  const host = await boot('host', { reply: '宿主这边收到，数字我再核一遍。' })
  const guest = await boot('guest', { reply: '远程这边：退货率 7.1%，尾货占六成。' })
  try {
    // ---- 宿主：一间屋子 + 一个本机 agent
    const created = await command(host, 'room.create', { name: '周三对账', topic: '把两边的账对一遍' })
    const hostRoom = created.rooms[0]
    await command(host, 'member.createBot', { roomId: hostRoom.id, name: 'Claude', role: '账期' })
    const hostSnapshot = await snapshot(host)
    const port = hostSnapshot.lan.port
    assert.ok(port > 0, '宿主应该真的监听了端口')
    assert.equal(hostSnapshot.lan.serving, true)

    // ---- 加入方：先有一个自己的 agent，再加入别人的屋子
    const local = await command(guest, 'room.create', { name: '我自己的屋子' })
    await command(guest, 'member.createBot', { roomId: local.rooms[0].id, name: '阿甲', role: '退货' })
    await command(guest, 'self.rename', { name: '周荻' })
    const guestBotId = (await snapshot(guest)).bots[0].id

    const joined = await command(guest, 'lan.join', { host: '127.0.0.1', port, code: hostRoom.code })
    const link = joined.links[0]
    const mirror = joined.rooms.find((room) => room.remote)
    assert.ok(mirror, '加入方应该出现一间镜像房间')
    const peerId = mirror.remote.peerId
    assert.ok(peerId, '加入后应该拿到 peerId')
    assert.equal(mirror.remote.port, port)
    assert.equal(mirror.members.length, 4, '两边的人各一条 + 两个 agent')

    // ---- 归属：宿主看到的人是 LAN 进来的，agent 也是
    const hostView = await snapshot(host)
    const hostRoom2 = hostView.rooms.find((room) => room.id === hostRoom.id)
    const joinedMembers = membersByName(hostRoom2)
    const guestHuman = joinedMembers['周荻']
    assert.equal(guestHuman.origin.kind, 'lan', '加入方的人必须标成 LAN')
    assert.equal(guestHuman.owner, peerId)
    const remoteAgent = joinedMembers['阿甲']
    assert.equal(remoteAgent.kind, 'bot')
    assert.equal(remoteAgent.origin.kind, 'lan')
    assert.equal(remoteAgent.botId, guestBotId, '宿主记的是加入方自己的 bot id')
    assert.equal(hostRoom2.unread, 0)

    // ---- 视角翻转：加入方看自己的人是本机，看宿主的人是 LAN
    const guestView = await snapshot(guest)
    const guestMirror = guestView.rooms.find((room) => room.remote)
    const fromGuest = membersByName(guestMirror)
    assert.equal(fromGuest['周荻'].id, 'me', '镜像里「我」要对齐成本地 self')
    assert.equal(fromGuest['周荻'].origin.kind, 'local')
    assert.equal(fromGuest['阿甲'].origin.kind, 'local', '我自己带的 agent 在本机')
    assert.equal(fromGuest['Claude'].origin.kind, 'lan', '宿主那边的 agent 从这边看是远程')

    // ---- 加入方发言：必须落进宿主那间屋子，并标成 LAN 来源
    await command(guest, 'msg.send', { roomId: guestMirror.id, text: '我这边先把退货率放上来。' })
    const afterGuestPost = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === hostRoom.id)
      return room.messages.find((message) => message.text.includes('退货率放上来'))
    }, { label: '宿主收到加入方的消息' })
    assert.equal(afterGuestPost.authorName, '周荻')
    assert.equal(afterGuestPost.origin.kind, 'lan')

    // ---- 宿主 @ 远程 agent：本机不能替它说话，必须派发出去
    await command(host, 'msg.send', { roomId: hostRoom.id, text: '@阿甲 你那边退货率现在多少？' })
    const remoteReply = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === hostRoom.id)
      return room.messages.find((message) => message.authorName === '阿甲')
    }, { label: '远程 agent 的回复落进宿主房间' })
    assert.equal(remoteReply.authorKind, 'bot')
    assert.equal(remoteReply.origin.kind, 'lan', '远程 agent 的话不能被标成本机')
    assert.match(remoteReply.text, /7\.1%/)
    assert.equal(guest.prompts.length, 1, '加入方应该被派发了一轮')
    assert.match(guest.prompts[0].text, /@阿甲 你那边退货率现在多少/, '派发的 prompt 要带房间上下文')
    assert.equal(host.prompts.length, 0, '宿主不该替远程 agent 调模型')

    // ---- 镜像会跟着走：加入方也能看到这条回复，未读按它自己的游标算
    const guestAfter = await until(async () => {
      const view = await snapshot(guest)
      const room = view.rooms.find((row) => row.remote)
      return room.messages.find((message) => message.authorName === '阿甲') ? room : null
    }, { label: '加入方镜像收到远程 agent 的回复' })
    assert.ok(guestAfter.unread >= 0)
    const mirroredReply = guestAfter.messages.find((message) => message.authorName === '阿甲')
    assert.equal(mirroredReply.origin.kind, 'local', '自己 agent 说的话，在本地视角就是本机')

    // ---- 宿主的 agent 被 @ 时仍然本地跑
    await command(host, 'msg.send', { roomId: hostRoom.id, text: '@Claude 你核一下这个数。' })
    await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === hostRoom.id)
      return room.messages.find((message) => message.authorName === 'Claude')
    }, { label: '本机 agent 的回复' })
    assert.equal(host.prompts.length, 1, '本机 agent 走本地模型')

    // ---- 未读与已读：加入方读到最新后，宿主那边的未读归零
    await until(async () => {
      const view = await snapshot(guest)
      const room = view.rooms.find((row) => row.remote)
      if (!room) return false
      if (room.unread === 0) return true
      // 读到最后一条已知消息；期间又来了新消息就再读一次（和真实用户的行为一致）。
      await command(guest, 'read.mark', { roomId: room.id, seq: room.nextSeq - 1 })
      return false
    }, { label: '未读清零' })
    const cleared = await snapshot(guest)
    assert.equal(cleared.rooms.find((room) => room.remote).unread, 0)

    // ---- 镜像房间不许在本地改规则：规则只有一份，在那台机器上
    const refused = await call(guest.routes, 'command', {
      action: 'room.update',
      input: { roomId: guestMirror.id, rules: { roundRobin: true } },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'remote_room')

    // ---- 离开：宿主的成员被撤掉，加入方的镜像也没了
    await command(guest, 'lan.leave', { linkId: link.id })
    const hostAfterLeave = await snapshot(host)
    const leftRoom = hostAfterLeave.rooms.find((room) => room.id === hostRoom.id)
    assert.deepEqual(leftRoom.members.map((member) => member.name).sort(), ['Claude', '我'].sort())
    assert.equal(hostAfterLeave.lan.peers.length, 0)
    const guestAfterLeave = await snapshot(guest)
    assert.equal(guestAfterLeave.rooms.some((room) => room.remote), false)
    assert.equal(guestAfterLeave.links.length, 0)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('房间码不对就进不来', async () => {
  const host = await boot('host-code')
  const guest = await boot('guest-code')
  try {
    await command(host, 'room.create', { name: '关门' })
    const port = (await snapshot(host)).lan.port
    const bad = await call(guest.routes, 'command', {
      action: 'lan.join',
      input: { host: '127.0.0.1', port, code: 'ZZZZZZ' },
    })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'room_not_found')
    const after = await snapshot(guest)
    assert.equal(after.rooms.some((room) => room.remote), false)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('对面机器掉线：这一轮超时后落一条失败占位，不把整轮卡死', async () => {
  process.env.DSH_CHATROOM_ASSIGN_TIMEOUT = '250'
  const host = await boot('host-timeout')
  const guest = await boot('guest-timeout')
  try {
    const created = await command(host, 'room.create', { name: '会掉线的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿乙' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })

    // 直接拔线（不 leave）：宿主仍然认为它在屋里，但那台机器已经不再领任务了。
    await guest.dispose()

    await command(host, 'msg.send', { roomId, text: '@阿乙 还在吗？' })
    const failure = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.status === 'error')
    }, { label: '失败占位', timeoutMs: 5000 })
    assert.match(failure.text, /没回上来/)
    assert.match(failure.text, /阿乙/)
    const settled = await snapshot(host)
    assert.equal(settled.rooms.find((room) => room.id === roomId).activity, null, '超时后不该还挂着发言中')
  } finally {
    delete process.env.DSH_CHATROOM_ASSIGN_TIMEOUT
    await host.dispose()
  }
})

test('宿主重启：上一轮从 LAN 进来的成员不会留成幽灵', async () => {
  const host = await boot('host-restart')
  const guest = await boot('guest-restart')
  try {
    const created = await command(host, 'room.create', { name: '会重启的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿丙' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const before = await snapshot(host)
    assert.equal(before.rooms.find((room) => room.id === roomId).members.length, 3)

    // 拔电重启：不 leave，直接关掉宿主再用同一个 profile 目录重新 apply。
    await guest.dispose()
    await host.dispose()
    const again = fakeCtx(host.dir)
    const dispose = await apply(again.ctx)
    try {
      const after = await call(again.routes, 'snapshot', {})
      const room = after.value.rooms.find((row) => row.id === roomId)
      assert.equal(room.members.length, 1, '重启后只剩本机的人')
      assert.equal(room.members[0].owner ?? 'local', 'local')
      assert.equal(after.value.lan.peers.length, 0)
    } finally {
      await dispose()
    }
  } finally {
    await host.dispose().catch(() => {})
  }
})

test('局域网端点自带门禁：没带 peerId、带错的 peerId 都进不来', async () => {  const host = await boot('host-gate')
  try {
    await command(host, 'room.create', { name: '有门禁的屋子' })
    const port = (await snapshot(host)).lan.port
    const base = `http://127.0.0.1:${port}`

    const noPeer = await fetch(`${base}/lan/state?since=-1`)
    assert.equal(noPeer.status, 403)
    const wrongPeer = await fetch(`${base}/lan/state?peerId=p_deadbeef&since=-1`)
    assert.equal(wrongPeer.status, 403)
    const unknownPath = await fetch(`${base}/lan/nope`)
    assert.equal(unknownPath.status, 404)
    const ping = await fetch(`${base}/lan/ping`)
    assert.equal(ping.status, 200)
    const body = await ping.json()
    assert.equal(body.value.serving, true)
  } finally {
    await host.dispose()
  }
})

test('宿主重启后旧凭据失效：加入方不用手动重连，下一次发言自己重新握手', async () => {
  const host = await boot('host-rejoin', { reply: '重启之后还在。' })
  const guest = await boot('guest-rejoin', { reply: '这边也还在。' })
  try {
    const created = await command(host, 'room.create', { name: '会重启的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'self.rename', { name: '周荻' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const mirrorId = (await snapshot(guest)).rooms.find((room) => room.remote).id

    // 宿主进程换一代：同一份 profile、同一个端口，上一轮的 peerId 全部作废。
    await host.dispose()
    process.env.DSH_CHATROOM_PORT = String(port)
    const again = fakeCtx(host.dir, { reply: '重启之后还在。' })
    const dispose = await apply(again.ctx)
    try {
      // 不做任何手工重连，直接说话 —— 用户视角就是「对面重启了，我继续发」。
      const sent = await call(guest.routes, 'command', {
        action: 'msg.send',
        input: { roomId: mirrorId, text: '重启之后我还能说话。' },
      })
      assert.equal(sent.ok, true, `发言应该自己重连成功：${JSON.stringify(sent.error)}`)
      const landed = await until(async () => {
        const view = await call(again.routes, 'snapshot', {})
        const room = view.value.rooms.find((row) => row.id === roomId)
        return room.messages.find((message) => message.text.includes('重启之后我还能说话'))
      }, { label: '重启后的消息落库' })
      assert.equal(landed.authorName, '周荻')
      // 只该出现一份「周荻」：并发重连去重没做好时，这里会冒出两个。
      const view = await call(again.routes, 'snapshot', {})
      const people = view.value.rooms.find((row) => row.id === roomId).members.filter((row) => row.kind === 'human')
      assert.deepEqual(people.map((row) => row.name).sort(), ['周荻', '我'].sort())
    } finally {
      process.env.DSH_CHATROOM_PORT = '0'
      await dispose()
    }
  } finally {
    await guest.dispose().catch(() => {})
  }
})

test('宿主解散房间：加入方留一张能清理的墓碑，不是发不出话也退不出的死胡同', async () => {
  const host = await boot('host-dissolve')
  const guest = await boot('guest-dissolve')
  try {
    const created = await command(host, 'room.create', { name: '会被解散的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const mirrorId = (await snapshot(guest)).rooms.find((room) => room.remote).id

    await command(host, 'room.dissolve', { roomId })

    const tomb = await until(async () => {
      const view = await snapshot(guest)
      const room = view.rooms.find((row) => row.id === mirrorId)
      return room && room.remote.lost ? { room, view } : null
    }, { label: '加入方看到墓碑' })
    assert.equal(tomb.view.links[0].status, 'gone')
    assert.equal(tomb.room.messages.length, 0)
    // 历史还在，但已经写不进去了：给出明确错误码，而不是一句泛泛的失败。
    const refused = await call(guest.routes, 'command', {
      action: 'msg.send',
      input: { roomId: mirrorId, text: '还能发吗？' },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'remote_room_gone')
    // 关键：还能自己把它从列表里清掉。
    await command(guest, 'lan.leave', { linkId: tomb.view.links[0].id })
    const after = await snapshot(guest)
    assert.equal(after.rooms.some((row) => row.id === mirrorId), false)
    assert.equal(after.links.length, 0)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('跑着的宿主会清掉真的关掉的机器，但不会清正在长轮询的那台', async () => {
  // 把 idle 压到 400ms：测试要量的是「清扫逻辑」，不是等 45 秒。
  process.env.DSH_CHATROOM_PEER_IDLE = '400'
  const host = await boot('host-sweep')
  const guest = await boot('guest-sweep')
  try {
    const created = await command(host, 'room.create', { name: '会掉人的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿丁' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })

    // 对面一直挂着长轮询（这是它在屋里的常态），不能被当成掉线清掉。
    await tick(1200)
    const alive = await snapshot(host)
    assert.equal(alive.rooms.find((room) => room.id === roomId).members.length, 3, '长轮询中的机器不算掉线')
    assert.equal(alive.lan.peers.length, 1)

    // 真的关掉（不发 leave，模拟关窗口 / 掉网），清扫器应该把整组成员撤掉。
    await guest.dispose()
    const swept = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      return room.members.length === 1 && view.lan.peers.length === 0 ? view : null
    }, { label: '清扫掉线的机器', timeoutMs: 8000 })
    assert.equal(swept.rooms.find((room) => room.id === roomId).members[0].owner ?? 'local', 'local')
  } finally {
    delete process.env.DSH_CHATROOM_PEER_IDLE
    await host.dispose()
  }
})
