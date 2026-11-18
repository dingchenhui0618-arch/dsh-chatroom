import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx } from './helpers/fake-ctx.mjs'

/**
 * 房间码是六位 32 进制，靠猜没希望；但没有节流时，同网段一台机器可以打满速一直猜，
 * 这件事没有成本。这一组盯的是「试错有代价」这件事本身：
 *
 *   - 同一个来源地址一分钟里失败 12 次之后，第 13 次直接 429，并告诉人还要等几秒；
 *   - 这个账按**地址**分，别人（另一台机器）不受牵连；
 *   - 成功加入会清账：打错十几次之后输对，照常进屋，之后不会一直被拦。
 *
 * 用 node:http 而不是 fetch：要绑 `localAddress` 假装是另一台机器。
 */

process.env.DSH_CHATROOM_PORT = '0'

async function withHost(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lan-ratelimit-'))
  const fake = fakeCtx(dir, { reply: '收到' })
  const dispose = await apply(fake.ctx)
  try {
    const snap = await call(fake.routes, 'snapshot', {})
    assert.equal(snap.ok, true, JSON.stringify(snap.error))
    assert.ok(snap.value.lan.port > 0, '宿主应该真的监听了端口')
    const created = await call(fake.routes, 'command', { action: 'room.create', input: { name: '节流' } })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    await run({ ...fake, port: snap.value.lan.port, room: created.value.rooms[0] })
  } finally {
    await dispose().catch(() => {})
  }
}

function joinRequest(port, body, localAddress = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/lan/join',
        headers: { 'content-type': 'application/json' },
        localAddress,
      },
      (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (data += chunk))
        response.on('end', () => {
          let payload = null
          try {
            payload = JSON.parse(data)
          } catch {
            payload = null
          }
          resolve({ status: response.statusCode, payload, raw: data })
        })
      },
    )
    request.on('error', reject)
    request.end(JSON.stringify(body))
  })
}

const wrong = (machine) => ({ code: 'ZZZZZZ', machine, self: { name: '试错的人' }, agents: [] })
const right = (code, machine) => ({ code, machine, self: { name: '试错的人' }, agents: [] })

test('同一个地址试错 12 次之后第 13 次被 429，还说清要等几秒', async () => {
  await withHost(async (host) => {
    for (let i = 1; i <= 12; i += 1) {
      const response = await joinRequest(host.port, wrong(`TRY-${i}`))
      assert.equal(response.status, 403, `第 ${i} 次该是 403，实际 ${response.status}`)
      assert.equal(response.payload?.error?.code, 'room_not_found')
    }
    const blocked = await joinRequest(host.port, wrong('TRY-13'))
    assert.equal(blocked.status, 429, `第 13 次该是 429，实际 ${blocked.status} ${blocked.raw}`)
    assert.equal(blocked.payload?.error?.code, 'too_many_tries')
    assert.match(blocked.payload?.error?.message ?? '', /等 \d+ 秒再试/, '提示里要写清还要等多久')

    // 连输对房间码也先被这道闸拦住 —— 但只拦这一分钟，且只拦这个地址。
    const sameAddress = await joinRequest(host.port, right(host.room.code, 'SAME'))
    assert.equal(sameAddress.status, 429)

    const snap = await call(host.routes, 'snapshot', {})
    const rooms = snap.value.rooms ?? []
    assert.equal(rooms.length, 1, '试错不该多出屋子')
    assert.equal(rooms[0].members.length, 1, '试错不该在屋里留下成员')
  })
})

test('节流按地址分：另一台机器照常进屋', async () => {
  await withHost(async (host) => {
    for (let i = 1; i <= 12; i += 1) await joinRequest(host.port, wrong(`TRY-${i}`), '127.0.0.1')
    const blocked = await joinRequest(host.port, wrong('TRY-13'), '127.0.0.1')
    assert.equal(blocked.status, 429)

    const other = await joinRequest(host.port, right(host.room.code, 'GUEST-OTHER'), '127.0.0.2')
    assert.equal(other.status, 200, `另一台机器不该被牵连：${other.raw}`)
    assert.ok(other.payload?.value?.peerId, '另一台机器应当拿到 peerId')
    const members = other.payload.value.snapshot.room?.members ?? other.payload.value.snapshot.rooms?.[0]?.members ?? []
    assert.ok(
      members.some((member) => member.name === '试错的人'),
      '另一台机器的人应当真的进到屋里',
    )
  })
})

test('打错十几次之后输对：照常进屋，账也清了', async () => {
  await withHost(async (host) => {
    for (let i = 1; i <= 11; i += 1) {
      const response = await joinRequest(host.port, wrong(`TYPO-${i}`))
      assert.equal(response.status, 403)
    }
    const ok = await joinRequest(host.port, right(host.room.code, 'GUEST-LATE'))
    assert.equal(ok.status, 200, `11 次试错之后输对应当能进：${ok.raw}`)

    // 成功一次就把这一格清掉：再打错 11 次也不该被拦（12 次才开始计时的那一格已经没了）。
    for (let i = 1; i <= 11; i += 1) {
      const response = await joinRequest(host.port, wrong(`AGAIN-${i}`))
      assert.equal(response.status, 403, `清账之后第 ${i} 次仍该是 403，实际 ${response.status}`)
      assert.notEqual(response.payload?.error?.code, 'too_many_tries')
    }
  })
})
