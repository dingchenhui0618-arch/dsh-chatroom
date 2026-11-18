import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx } from './helpers/fake-ctx.mjs'

/**
 * 局域网面对**同网段所有人**开着，而 `lan-hardening` 那三条用例只覆盖了手工想到的坏包。
 * 这一条换一种问法：随机字节与一批点名坏包打过去之后，能不能守住三条不变量 ——
 *
 *   1. 宿主还在服务（端口没变、ping 照常 200）；
 *   2. **状态一个字节都没被改动**（revision 不变、没有凭空多出屋子或成员）：
 *      没凭据的包不许产生任何写入，这是这一面最要紧的一条；
 *   3. 全程没有 5xx、没有未处理的拒绝。
 *
 * 不断言「每个包都必须有回应」：解析不了的包直接断开、keep-alive 的连接保持打开，
 * 都是合理的 HTTP 行为。断言的是上面那三条 —— 它们才是有牙的部分。
 */

process.env.DSH_CHATROOM_PORT = '0'

const rejections = []
process.on('unhandledRejection', (reason) => rejections.push(reason))

async function withHost(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lan-fuzz-'))
  const fake = fakeCtx(dir, { reply: '收到' })
  const dispose = await apply(fake.ctx)
  try {
    const snap = await call(fake.routes, 'snapshot', {})
    assert.equal(snap.ok, true, JSON.stringify(snap.error))
    assert.ok(snap.value.lan.port > 0, '宿主应该真的监听了端口')
    await run({ ...fake, port: snap.value.lan.port })
  } finally {
    await dispose().catch(() => {})
  }
}

/** 灌一段字节进去，读一小会儿，然后自己把 socket 关掉。 */
function shoot(port, payload, timeoutMs = 250) {
  return new Promise((resolve) => {
    let socket
    try {
      socket = net.connect({ host: '127.0.0.1', port })
    } catch (error) {
      resolve({ error: String(error.message), data: '' })
      return
    }
    let data = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已经坏了 */
      }
      resolve(result)
    }
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => (data += chunk))
    socket.on('error', (error) => finish({ error: String(error.message), data }))
    socket.on('close', () => finish({ data }))
    const timer = setTimeout(() => finish({ data, quiet: true }), timeoutMs)
    timer.unref?.()
    socket.on('connect', () => {
      try {
        socket.write(payload)
      } catch (error) {
        finish({ error: String(error.message), data })
      }
    })
  })
}

const statusOf = (data) => (/\s(\d{3})\s/.exec(data ?? '')?.[1] ?? null)

/** 固定种子：每次跑的是同一批字节，红了能复现。 */
function lcg(seed) {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x100000000
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS', 'TRACE', 'DELETE', 'PATCH', 'PROPFIND', 'get']
const TARGETS = [
  '/lan/ping',
  '/lan/join',
  '/lan/state',
  '/lan/message',
  '/lan/reply',
  '/lan/assignments',
  '/',
  '/../../etc/passwd',
  '/lan/join?code=%00',
  '/lan/%zz',
  '*',
  'http://[',
  'http://127.0.0.1:4399/lan/ping',
  '',
]
const HEADER_LINES = [
  'Host: [',
  'Host: exa mple',
  'Content-Length: 999999999',
  'Content-Length: -1',
  'Content-Length: 0',
  'Content-Length: 12\r\nContent-Length: 13',
  'Transfer-Encoding: chunked',
  'Transfer-Encoding: chunked\r\nContent-Length: 5',
  'Content-Type: application/json',
  'Content-Type: text/plain',
  'Connection: close',
  'Connection: keep-alive',
  'Upgrade: websocket',
  'Origin: https://evil.example',
  'X-Junk: ' + 'a'.repeat(300),
]
const BODIES = [
  '',
  '{}',
  'not json at all',
  '{"type":"client-request","rpcId":"r","method":"dsh.chatroom/snapshot"}',
  '{"type":"client-request","rpcId":1,"method":2}',
  '{"type":"client-request","rpcId":null,"method":null,"payload":[]}',
  '[]',
  '{"code":"AAAAAA","peerId":"p_deadbeef","text":"hi","action":"room.create"}',
  'd'.repeat(4000),
]

function randomPacket(random) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const eol = random() < 0.8 ? '\r\n' : '\n'
  const first = `${pick(METHODS)} ${pick(TARGETS)} HTTP/1.1`
  if (random() < 0.15) {
    // 15% 的包干脆连请求行都拼不完整。
    const cut = Math.floor(random() * first.length)
    return first.slice(0, cut) + (random() < 0.5 ? eol : '')
  }
  const lines = []
  const headerCount = Math.floor(random() * 4)
  for (let i = 0; i < headerCount; i += 1) lines.push(pick(HEADER_LINES))
  const body = random() < 0.5 ? '' : pick(BODIES)
  return [first, ...lines, '', body].join(eol)
}

async function stateOf(host) {
  const snap = await call(host.routes, 'snapshot', {})
  assert.equal(snap.ok, true, JSON.stringify(snap.error))
  const value = snap.value
  const rooms = value.rooms ?? []
  const members = rooms.reduce((sum, room) => sum + (room.members?.length ?? 0), 0)
  const messages = rooms.reduce((sum, room) => sum + (room.messages?.length ?? 0), 0)
  return { revision: value.revision, rooms: rooms.length, members, messages, port: value.lan?.port }
}

test('随机字节打完后：宿主还在服务，状态一个字节都没动，也没有 5xx', async () => {
  await withHost(async (host) => {
    const base = rejections.length
    const before = await stateOf(host)
    const random = lcg(20261118)
    let fiveHundreds = []
    for (let i = 0; i < 120; i += 1) {
      const payload = randomPacket(random)
      const result = await shoot(host.port, payload, 200)
      const status = statusOf(result.data)
      if (status && Number(status) >= 500) fiveHundreds.push(`${i}:${status}`)
    }
    assert.deepEqual(fiveHundreds, [], '坏包打出了 5xx —— 说明有输入走到了内部错误路径')

    const after = await stateOf(host)
    assert.deepEqual(after, before, '没凭据的坏包改动了宿主状态')
    const ping = await fetch(`http://127.0.0.1:${host.port}/lan/ping`)
    assert.equal(ping.status, 200, '随机包打完之后宿主已经不服务了')
    assert.equal((await ping.json()).value.ok, true)
    assert.equal(rejections.length, base, `有未处理的拒绝：\n${rejections.map((row) => String(row?.stack ?? row)).join('\n---\n')}`)
  })
})

const CASES = [
  ['请求头一行 8 KB', `GET /lan/ping HTTP/1.1\r\nHost: h\r\nX-Big: ${'a'.repeat(8192)}\r\nConnection: close\r\n\r\n`],
  ['chunked 里塞非法块长', 'POST /lan/join HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\n{}\r\n0\r\n\r\n'],
  ['两条请求挤在同一个连接里', 'GET /lan/ping HTTP/1.1\r\nHost: h\r\n\r\nGET /lan/ping HTTP/1.1\r\nHost: h\r\n\r\n'],
  ['TRACE 打只认 GET/POST 的端点', 'TRACE /lan/join HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n'],
  ['路径里带编码过的空字节', 'GET /lan/%00ping HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n'],
  ['请求行只有方法', 'GET\r\n\r\n'],
  ['Upgrade 请求', 'GET /lan/ping HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\n\r\n'],
  ['Content-Length 是负数', 'POST /lan/join HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n{}'],
  ['400 KB 的 body', `POST /lan/join HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nContent-Length: 409600\r\n\r\n${'x'.repeat(409600)}`],
  ['HTTP/0.9 风格的一行', 'GET /lan/ping\r\n\r\n'],
  ['伪造的 peerId 想读历史', 'POST /lan/messages HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"peerId":"p_0123456789abcdef","beforeSeq":999999}'],
  ['伪造的 peerId 想发言', 'POST /lan/message HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"peerId":"p_0123456789abcdef","text":"我进来了"}'],
]

test('点名的坏包各自有说法：不 5xx、不改状态，之后真实加入照旧', async () => {
  await withHost(async (host) => {
    const base = rejections.length
    const before = await stateOf(host)
    for (const [label, payload] of CASES) {
      const result = await shoot(host.port, payload, 900)
      const status = statusOf(result.data)
      if (status) {
        assert.ok(
          Number(status) < 500,
          `${label} 打出了 ${status} —— 输入不该走到内部错误路径：${JSON.stringify(result.data.slice(0, 120))}`,
        )
      }
      const alive = await fetch(`http://127.0.0.1:${host.port}/lan/ping`)
      assert.equal(alive.status, 200, `${label} 之后宿主不能服务了`)
    }
    const after = await stateOf(host)
    assert.deepEqual(after, before, '点名坏包动了宿主状态（revision / 屋子 / 成员 / 消息）')
    // 伪造 peerId 那两条必须真的被挡在门外：403 而不是「写进去了但恰好没变」。
    assert.equal(rejections.length, base, '这一路不该产生未处理的拒绝')

    // 挨完打之后真的还能用：建房 → 加入 → 发言都走得通。
    const created = await call(host.routes, 'command', { action: 'room.create', input: { name: '挨完打之后' } })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    const room = created.value.rooms[0]
    const joined = await fetch(`http://127.0.0.1:${host.port}/lan/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: room.code, machine: 'GUEST-PC', self: { name: '宋迟' }, agents: [] }),
    })
    const payload = await joined.json()
    assert.equal(joined.status, 200, JSON.stringify(payload))
    assert.ok(payload.value.peerId, '坏包之后真实加入流程仍该给出 peerId')
  })
})

test('伪造的 peerId 一律 403，且不会在屋里留下任何东西', async () => {
  await withHost(async (host) => {
    const created = await call(host.routes, 'command', { action: 'room.create', input: { name: '假凭据' } })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    const room = created.value.rooms[0]
    const before = await stateOf(host)

    const probes = [
      ['读快照', 'GET', `/lan/state?peerId=p_0123456789abcdef&since=0`, null],
      ['读历史', 'POST', '/lan/messages', JSON.stringify({ peerId: 'p_0123456789abcdef', beforeSeq: 999999 })],
      ['发言', 'POST', '/lan/message', JSON.stringify({ peerId: 'p_0123456789abcdef', text: '我进来了' })],
      ['领回合', 'GET', `/lan/assignments?peerId=p_0123456789abcdef`, null],
      ['回传', 'POST', '/lan/reply', JSON.stringify({ peerId: 'p_0123456789abcdef', assignmentId: 'as_x', text: '回一句' })],
      ['改名', 'POST', '/lan/self', JSON.stringify({ peerId: 'p_0123456789abcdef', name: '改个名' })],
      ['补报名单', 'POST', '/lan/agents', JSON.stringify({ peerId: 'p_0123456789abcdef', agents: [{ id: 'b_1', name: '假 agent' }] })],
    ]
    for (const [label, method, path, body] of probes) {
      const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ?? undefined,
      })
      const payload = await response.json()
      assert.equal(response.status, 403, `${label} 应该被挡在门外，实际 ${response.status} ${JSON.stringify(payload)}`)
      assert.equal(payload.error?.code, 'peer_unknown', `${label} 的错误码该说清是凭据不认识`)
    }

    const after = await stateOf(host)
    assert.deepEqual(after, before, '假凭据的请求改动了屋子状态')
    assert.equal(after.rooms, 1)
    const detail = await call(host.routes, 'command', { action: 'msg.send', input: { roomId: room.id, text: '我还是能说话' } })
    assert.equal(detail.ok, true, JSON.stringify(detail.error))
  })
})
