import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { PAGE_DEFAULT, PAGE_MAX, pageMessages } from '../src/host/project.js'
import { call, fakeCtx } from './helpers/fake-ctx.mjs'

/**
 * 往回翻历史。
 *
 * 投影只带最近 200 条（PROJECTION_MESSAGES），房间能存 4000 条。没有这一步，
 * 说满 200 句之后那些话在界面上就等于不存在：用户既翻不回去，也不知道还留着多少。
 *
 * 这里守三条：
 *   1. 分页函数本身：窗口、上限、还有没有更早的，以及「一路翻到底不重不漏」；
 *   2. 端点真的挂着：本机房间直接给，不存在的屋子给可读错误；
 *   3. 加入方也能翻：本机只镜像了 200 条，更早的必须去宿主那台机器要，
 *      而且**只能翻到自己加入的那间屋子** —— 一张合法凭据不该能读别人的历史。
 */

process.env.DSH_CHATROOM_PORT = '0'

function fakeRoom(count) {
  const messages = []
  for (let i = 1; i <= count; i += 1) messages.push({ id: `m${i}`, seq: i, text: `第 ${i} 句`, authorId: 'me' })
  return { messages }
}

test('分页函数：窗口、上限、还有没有更早的', () => {
  const room = fakeRoom(240)

  // 界面第一次翻：投影从 41 开始，更早的正好 40 条 —— 一次给完，不说「还有」。
  const first = pageMessages(room, { beforeSeq: 41 })
  assert.equal(first.messages.length, 40)
  assert.equal(first.messages[0].seq, 1)
  assert.equal(first.messages[39].seq, 40)
  assert.equal(first.hasMore, false)
  assert.equal(first.firstSeq, 1)
  assert.equal(first.total, 240)

  // 一页装不下：只给最后一页，并且说还有更早的。
  const partial = pageMessages(room, { beforeSeq: 241, limit: 50 })
  assert.equal(partial.messages.length, 50)
  assert.equal(partial.messages[0].seq, 191)
  assert.equal(partial.messages[49].seq, 240)
  assert.equal(partial.hasMore, true)

  // 上限就是投影窗口：谁也不能用一个巨大的 limit 把整库一次拖出来。
  const clamped = pageMessages(room, { beforeSeq: 241, limit: 100000 })
  assert.equal(clamped.messages.length, PAGE_MAX)
  assert.equal(clamped.messages[PAGE_MAX - 1].seq, 240)

  // 不给 limit / 给 0：退回默认那一页，而不是当「不限」。
  assert.equal(pageMessages(room, { beforeSeq: 241 }).messages.length, PAGE_DEFAULT)
  assert.equal(pageMessages(room, { beforeSeq: 241, limit: 0 }).messages.length, PAGE_DEFAULT)

  // 不给 beforeSeq：当作「从最新一条往前翻」。
  const latest = pageMessages(room)
  assert.equal(latest.messages[latest.messages.length - 1].seq, 240)

  // 空屋子不该炸，也不该编出「还有」。
  const empty = pageMessages(fakeRoom(0), { beforeSeq: 1 })
  assert.deepEqual(empty.messages, [])
  assert.equal(empty.hasMore, false)
  assert.equal(empty.firstSeq, null)
  assert.equal(empty.total, 0)
})

test('一路翻到底：不重、不漏、按 seq 递增', () => {
  const room = fakeRoom(240)
  const collected = []
  let beforeSeq = 241
  for (let guard = 0; guard < 10; guard += 1) {
    const page = pageMessages(room, { beforeSeq, limit: 100 })
    collected.unshift(...page.messages)
    if (!page.hasMore) break
    assert.ok(page.messages.length, '说还有更早的，就必须真的给出一页')
    beforeSeq = page.messages[0].seq
  }
  assert.deepEqual(
    collected.map((row) => row.seq),
    Array.from({ length: 240 }, (_, index) => index + 1),
  )
})

test('端点：本机房间能翻回去，不存在的屋子给可读错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-page-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '长历史' } })
    assert.equal(created.ok, true)
    const roomId = created.value.rooms[0].id
    for (let i = 1; i <= 240; i += 1) {
      const sent = await call(routes, 'command', { action: 'msg.send', input: { roomId, text: `第 ${i} 句` } })
      assert.equal(sent.ok, true)
    }
    // 这一屏是「说过的话还在」，不是「再聊 240 句」：模型一次都不该被驱动。
    assert.equal(prompts.length, 0)

    const snapshot = await call(routes, 'snapshot', {})
    const room = snapshot.value.rooms[0]
    assert.equal(room.messages.length, 200, '投影只带最近 200 条')
    assert.equal(room.truncated, true)

    const page = await call(routes, 'messages', { roomId, beforeSeq: room.messages[0].seq })
    assert.equal(page.ok, true)
    assert.equal(page.value.messages.length, 40)
    assert.equal(page.value.messages[0].seq, 1)
    assert.equal(page.value.hasMore, false)
    assert.equal(page.value.total, 240)
    // 翻出来的还是消息本身：谁说的、什么时候、什么状态都在，界面直接能画。
    assert.equal(page.value.messages[0].authorId, 'me')
    assert.equal(typeof page.value.messages[0].at, 'string')

    const missing = await call(routes, 'messages', { roomId: 'rm_nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'room_not_found')
    assert.doesNotMatch(missing.error.message, /undefined|NaN/)
  } finally {
    await dispose()
  }
})

test('加入方也能往回翻：更早的消息去宿主那台机器要，且只能翻自己加入的那间屋子', async () => {
  const hostDir = await mkdtemp(join(tmpdir(), 'chatroom-page-host-'))
  const guestDir = await mkdtemp(join(tmpdir(), 'chatroom-page-guest-'))
  const host = fakeCtx(hostDir, { reply: '宿主这边收到。' })
  const guest = fakeCtx(guestDir, { reply: '远程这边：退货率 7.1%。' })
  const disposeHost = await apply(host.ctx)
  const disposeGuest = await apply(guest.ctx)
  try {
    const created = await call(host.routes, 'command', { action: 'room.create', input: { name: '长历史' } })
    const hostRoom = created.value.rooms[0]
    for (let i = 1; i <= 240; i += 1) {
      await call(host.routes, 'command', { action: 'msg.send', input: { roomId: hostRoom.id, text: `第 ${i} 句` } })
    }

    const hostView = await call(host.routes, 'snapshot', {})
    const port = hostView.value.lan.port
    assert.ok(port, '宿主应该已经在监听')

    // 加入方只有宿主发过来的那 200 条。
    const joined = await call(guest.routes, 'command', {
      action: 'lan.join',
      input: { host: '127.0.0.1', port, code: hostRoom.code },
    })
    assert.equal(joined.ok, true)
    const mirror = joined.value.rooms.find((room) => room.remote)
    assert.ok(mirror, '加入后应该有一间镜像房间')
    assert.equal(mirror.messages.length, 200)
    assert.equal(mirror.truncated, true)

    // 更早那 40 条本机没有：翻页必须真的走一趟 LAN，拿到宿主的那份。
    const page = await call(guest.routes, 'messages', { roomId: mirror.id, beforeSeq: mirror.messages[0].seq })
    assert.equal(page.ok, true)
    assert.equal(page.value.messages.length, 40)
    assert.equal(page.value.messages[0].seq, 1)
    assert.equal(page.value.messages[0].text, '第 1 句')
    assert.equal(page.value.hasMore, false)

    // 凭据只能翻它自己那间屋子：拿宿主房间 id 在加入方这边要，根本找不到。
    const foreign = await call(guest.routes, 'messages', { roomId: hostRoom.id })
    assert.equal(foreign.ok, false)
    assert.equal(foreign.error.code, 'room_not_found')
    // 反过来：宿主那边也不认识加入方本地的房间 id。
    const backwards = await call(host.routes, 'messages', { roomId: mirror.id })
    assert.equal(backwards.ok, false)
    assert.equal(backwards.error.code, 'room_not_found')

    // 直接打 LAN 端点、拿着一串假凭据：403 peer_unknown，一条历史都不给。
    const response = await fetch(`http://127.0.0.1:${port}/lan/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'pe_nope', beforeSeq: 41, limit: 100 }),
    })
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'peer_unknown')
    assert.equal(body.messages, undefined)
  } finally {
    await disposeHost()
    await disposeGuest()
  }
})
