import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx } from './helpers/fake-ctx.mjs'

/**
 * 局域网写接口只认「字符串」。
 *
 * 模糊测试（lan-fuzz）灌的是随机字节，基本到不了业务层；这一组灌的是**形状不对但
 * JSON 合法**的请求 —— `{"text": {"a": 1}}` 这种。以前 `String({a:1})` 会把
 * `[object Object]` 当成一句正常的聊天话落库：屋里多一条谁也看不懂的话，而且它还会
 * 被当成对话记录喂给模型。名字/职责/房间码同理。
 *
 * 断言不是「回了 400」，而是「屋里一条都没多」：状态零改动才是这一组的重点。
 */

process.env.DSH_CHATROOM_PORT = '0'

async function withHost(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lan-shapes-'))
  const fake = fakeCtx(dir, { reply: '收到' })
  const dispose = await apply(fake.ctx)
  try {
    const snap = await call(fake.routes, 'snapshot', {})
    assert.equal(snap.ok, true, JSON.stringify(snap.error))
    assert.ok(snap.value.lan.port > 0, '宿主应该真的监听了端口')
    const created = await call(fake.routes, 'command', { action: 'room.create', input: { name: '形状' } })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    const room = created.value.rooms[0]
    await run({ ...fake, port: snap.value.lan.port, code: room.code, roomId: room.id })
  } finally {
    await dispose().catch(() => {})
  }
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload === null ? {} : { 'content-type': 'application/json' },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, json, raw: text })
        })
      },
    )
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

const post = (port, path, body) => request(port, 'POST', path, body)
const get = (port, path) => request(port, 'GET', path)

async function until(read, { timeout = 4000, step = 50 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}

const joinBody = (code, extra = {}) => ({
  code,
  machine: '形状测试机',
  instance: 'shape-1',
  self: { name: '阿测' },
  agents: [{ id: 'a1', name: '阿甲', role: '核数字' }],
  build: { agents: 1 },
  ...extra,
})

test('形状不对的正文进不了屋：对象/数组正文一律 400，屋里一条都不多', async () => {
  await withHost(async ({ routes, port, code, roomId }) => {
    const joined = await post(port, '/lan/join', joinBody(code))
    assert.equal(joined.status, 200, joined.raw)
    const peerId = joined.json.value.peerId

    const before = await call(routes, 'snapshot', {})
    const beforeRoom = before.value.rooms.find((room) => room.id === roomId)
    const beforeCount = beforeRoom.messages.length
    const beforeRevision = before.value.revision

    const objectText = await post(port, '/lan/message', { peerId, text: { a: 1 } })
    assert.equal(objectText.status, 400, objectText.raw)
    assert.equal(objectText.json.error.code, 'bad_text')

    const arrayText = await post(port, '/lan/message', { peerId, text: ['a'] })
    assert.equal(arrayText.status, 400, arrayText.raw)
    assert.equal(arrayText.json.error.code, 'bad_text')

    const numberText = await post(port, '/lan/message', { peerId, text: 7 })
    assert.equal(numberText.status, 400, numberText.raw)

    // 屋里的状态一个字节都没动
    const after = await call(routes, 'snapshot', {})
    const afterRoom = after.value.rooms.find((room) => room.id === roomId)
    assert.equal(afterRoom.messages.length, beforeCount, '坏形状不该往屋里落消息')
    assert.equal(after.value.revision, beforeRevision, '坏形状不该推进 revision')
    assert.equal(afterRoom.messages.some((message) => /object Object/.test(message.text ?? '')), false)

    // 同一条连接换回字符串正文照常能发
    const good = await post(port, '/lan/message', { peerId, text: '数字我核完了，7.1%。' })
    assert.equal(good.status, 200, good.raw)
    const settled = await call(routes, 'snapshot', {})
    const room = settled.value.rooms.find((row) => row.id === roomId)
    assert.equal(room.messages.length, beforeCount + 1)
    assert.equal(room.messages.at(-1).text, '数字我核完了，7.1%。')

    // 宿主还活着
    const ping = await get(port, '/lan/ping')
    assert.equal(ping.status, 200)
  })
})

test('回传的正文只认字符串：坏形状回 400 且不消耗这一轮', async () => {
  await withHost(async ({ routes, port, code, roomId }) => {
    const joined = await post(port, '/lan/join', joinBody(code, { instance: 'shape-2' }))
    assert.equal(joined.status, 200, joined.raw)
    const peerId = joined.json.value.peerId

    // 宿主这边 @ 它一下：这一轮应该被派发到那台机器
    const sent = await call(routes, 'command', {
      action: 'msg.send',
      input: { roomId, text: '@阿甲 数字再核一遍' },
    })
    assert.equal(sent.ok, true, JSON.stringify(sent.error))

    const assignment = await until(async () => {
      const poll = await get(port, `/lan/assignments?peerId=${encodeURIComponent(peerId)}`)
      return poll.json?.value?.assignment ?? null
    })
    assert.ok(assignment, '这一轮应该派发到那台机器')

    const bad = await post(port, '/lan/reply', { peerId, assignmentId: assignment.id, text: { wrong: true } })
    assert.equal(bad.status, 400, bad.raw)
    assert.equal(bad.json.error.code, 'bad_text')

    // 坏形状没有把这一轮用掉：同一个 assignmentId 换回字符串还能交卷
    const good = await post(port, '/lan/reply', {
      peerId,
      assignmentId: assignment.id,
      text: '核完了，退货率 7.1%。',
    })
    assert.equal(good.status, 200, good.raw)

    const reply = await until(async () => {
      const snap = await call(routes, 'snapshot', {})
      const room = snap.value.rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.authorName === '阿甲' && message.status !== 'pending') ?? null
    })
    assert.ok(reply, '回传之后应该以那个 agent 的身份落库')
    assert.match(reply.text, /7\.1%/)
  })
})

test('名字与房间码也只看字符串：对象名字不会变成 [object Object]', async () => {
  await withHost(async ({ routes, port, code, roomId }) => {
    // 房间码给了数组 → 直接 403，不是「String() 一下碰巧对上了」
    const arrayCode = await post(port, '/lan/join', { ...joinBody(code), code: [code] })
    assert.equal(arrayCode.status, 403, arrayCode.raw)
    assert.equal(arrayCode.json.error.code, 'code_required')

    // 自己报的名字是对象 → 用机器名兜底，不能是 [object Object]
    const joined = await post(port, '/lan/join', joinBody(code, { instance: 'shape-3', self: { name: { evil: true } } }))
    assert.equal(joined.status, 200, joined.raw)
    const peerId = joined.json.value.peerId

    const snap = await call(routes, 'snapshot', {})
    const room = snap.value.rooms.find((row) => row.id === roomId)
    const guest = room.members.find((member) => member.owner === peerId && member.kind === 'human')
    assert.ok(guest, '人应该进屋了')
    assert.equal(guest.name, '形状测试机', '报不出字符串名字就用机器名兜底')
    assert.equal(/object Object/.test(guest.name), false)

    // agent 名单里的坏条目被丢掉，不会造出名叫 [object Object] 的成员
    const names = room.members.filter((member) => member.kind === 'bot').map((member) => member.name)
    assert.deepEqual(names, ['阿甲'])

    // 改名的名字是对象 → 400，成员名不变
    const rename = await post(port, '/lan/self', { peerId, name: { nope: 1 } })
    assert.equal(rename.status, 400, rename.raw)
    assert.equal(rename.json.error.code, 'bad_text')
    const after = await call(routes, 'snapshot', {})
    const still = after.value.rooms
      .find((row) => row.id === roomId)
      .members.find((member) => member.owner === peerId && member.kind === 'human')
    assert.equal(still.name, '形状测试机')
  })
})
