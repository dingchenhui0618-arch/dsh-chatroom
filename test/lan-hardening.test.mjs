import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx } from './helpers/fake-ctx.mjs'

/**
 * 局域网宿主的请求面是**对同网段所有人开着**的，所以这里测的不是功能，是「坏包能不能
 * 把宿主带走」。
 *
 * 起因是一个真实的崩溃：`new URL(request.url, 'http://' + host)` 里 Host 头是由请求方
 * 决定的，一个 `Host: [` 就让 new URL 抛 ERR_INVALID_URL；抛在处理函数最外层之外 →
 * 未处理的拒绝 → Node 按未捕获异常处理 → 宿主进程退出。也就是说同 WiFi 下随便一个
 * 端口扫描器 / 坏客户端，40 个字节就能把整个 DSH 关掉。
 *
 * 现在的要求：这类包一个都不许把进程带走；说得清的给状态码，说不清的明确回 400。
 */

process.env.DSH_CHATROOM_PORT = '0'

/** 任何一个逃出去的拒绝都记下来：既是断言对象，也顺带防止测试进程被它带走。 */
const rejections = []
process.on('unhandledRejection', (reason) => rejections.push(reason))

async function withHost(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lan-hardening-'))
  const fake = fakeCtx(dir, { reply: '收到' })
  const dispose = await apply(fake.ctx)
  try {
    const snap = await call(fake.routes, 'snapshot', {})
    assert.equal(snap.ok, true, JSON.stringify(snap.error))
    assert.ok(snap.value.lan.port > 0, '宿主应该真的监听了端口')
    await run({ ...fake, port: snap.value.lan.port })
  } finally {
    // 宿主真的在监听：不关掉它，node --test 等不到事件循环空下来。
    await dispose().catch(() => {})
  }
}

/** 直接往 socket 里灌字节：这些包没法用 fetch 发出来。 */
function raw(port, payload, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(payload))
    let data = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => (data += chunk))
    socket.on('error', (error) => finish({ error: String(error.message), data }))
    socket.on('close', () => finish({ data }))
    const timer = setTimeout(() => finish({ data, timedOut: true }), timeoutMs)
    timer.unref?.()
  })
}

const statusOf = (data) => (/\s(\d{3})\s/.exec(data ?? '')?.[1] ?? null)

/** 一个「坏包」之后宿主还能不能用：这条路径不经过被断言的那个处理函数。 */
async function stillServing(port) {
  const response = await fetch(`http://127.0.0.1:${port}/lan/ping`)
  const payload = await response.json()
  return { status: response.status, payload }
}

test('畸形请求不会把宿主带走：说得清的给出状态码，说不清的明确拒绝', async () => {
  await withHost(async (host) => {
    const cases = [
      // Host 头现在根本不参与解析：它只影响绝对地址的请求行，我们不按 Host 路由。
      // 这类包应当照常处理（/lan/ping 是健康检查，没有状态），而不是拿它当身份。
      ['Host 头不是合法 URL', 'GET /lan/ping HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n', '200'],
      ['Host 里有空格（Host: exa mple）', 'GET /lan/ping HTTP/1.1\r\nHost: exa mple\r\nConnection: close\r\n\r\n', '200'],
      // 请求行本身没法解析时没得救，只能明确回 400。
      ['请求行是非法绝对地址', 'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', '400'],
      ['请求行不是路径也不是绝对地址', 'GET * HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', '404'],
    ]
    for (const [label, payload, expected] of cases) {
      const result = await raw(host.port, payload)
      assert.equal(result.timedOut, undefined, `${label} 没有回音，说明请求挂住了`)
      assert.ok(result.data.length > 0, `${label} 一个字节都没回`)
      assert.equal(
        statusOf(result.data),
        expected,
        `${label} 应该回 ${expected}，实际：${JSON.stringify(result.data.slice(0, 120))}`,
      )
      const after = await stillServing(host.port)
      assert.equal(after.status, 200, `${label} 之后宿主已经不能服务了`)
      assert.equal(after.payload.value.ok, true)
    }
    assert.equal(
      rejections.length,
      0,
      `有未处理的拒绝：\n${rejections.map((row) => String(row?.stack ?? row)).join('\n---\n')}`,
    )
  })
})

test('坏包之后真实加屋流程照旧：宿主状态没被弄坏', async () => {
  await withHost(async (host) => {
    const base = rejections.length
    await raw(host.port, 'GET /lan/ping HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n')
    const created = await call(host.routes, 'command', { action: 'room.create', input: { name: '坏包之后' } })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    const room = created.value.rooms[0]

    const response = await fetch(`http://127.0.0.1:${host.port}/lan/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: room.code, machine: 'GUEST-PC', self: { name: '周笙' }, agents: [] }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    assert.ok(payload.value.peerId, '加入应该拿到 peerId')
    const members = payload.value.snapshot.room?.members ?? payload.value.snapshot.rooms?.[0]?.members ?? []
    assert.ok(
      members.some((member) => member.name === '周笙'),
      '新成员应该出现在快照里',
    )
    assert.equal(rejections.length, base, '这一路不该产生未处理的拒绝')
  })
})

test('其它坏输入：未知路径 404、超大声明长度 400、方法不对 404、非 JSON 400', async () => {
  await withHost(async (host) => {
    const base = rejections.length
    const cases = [
      ['未知路径', 'GET /lan/nope HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', '404'],
      [
        '声明的 Content-Length 超过上限',
        'POST /lan/join HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n{}',
        '400',
      ],
      ['GET 打到只认 POST 的端点', 'GET /lan/join HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', '404'],
      ['路径里的 since 不是数字', 'GET /lan/state?since=abc HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', '403'],
    ]
    for (const [label, payload, expected] of cases) {
      const result = await raw(host.port, payload)
      assert.equal(
        statusOf(result.data),
        expected,
        `${label} 应该回 ${expected}，实际：${JSON.stringify(result.data.slice(0, 120))}`,
      )
    }

    // 非 JSON 的请求体走的是真实 HTTP 栈（fetch 能发），单独验一遍。
    const response = await fetch(`http://127.0.0.1:${host.port}/lan/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.error.code, 'bad_json')
    assert.equal(rejections.length, base, '这一路不该产生未处理的拒绝')
  })
})
