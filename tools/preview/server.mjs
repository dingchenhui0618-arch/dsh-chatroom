import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootFixture, bootGuest, warmUp } from './fixture.mjs'

/**
 * 截图用的最小服务器：静态文件 + 三个和线上同形的端点。
 * 客户端那半边完全不知道自己在替身里 —— 它照样走 /api/dsh.chatroom/* 与长轮询。
 *
 * 起两份：3491 是宿主那台机器，3492 是加入的那台机器。
 * 两份各有一个 Store、一个 LAN 监听，互相走真实的局域网协议，
 * 所以「远程成员 / 跨机派发」在截图里是真的，不是画上去的。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const hostPort = Number(process.env.PREVIEW_PORT ?? 3491)
const guestPort = Number(process.env.PREVIEW_GUEST_PORT ?? hostPort + 1)
// 宿主那块局域网监听的端口会印在「邀请」那一屏上；系统随手挑一个的话，
// 同一个界面每截一次就是一张不同的图。给它一个固定的，被别人占用了再退回随机。
const wantedLanPort = Number(process.env.PREVIEW_LAN_PORT ?? 4455)

let host
try {
  host = await bootFixture({ port: wantedLanPort })
} catch (error) {
  console.warn(`[chatroom-preview] 固定端口 ${wantedLanPort} 起不来，改用系统挑的端口：${error?.message ?? error}`)
  host = await bootFixture({ port: 0 })
}
const guest = await bootGuest({ port: host.lanPort, code: host.code })
await warmUp(host, guest)
console.log(`preview host room ${host.code} on LAN port ${host.lanPort}`)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function waitForChange(store, since, signal, timeoutMs = 20_000) {
  if (store.state.revision !== since) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    const unsubscribe = store.subscribe(finish)
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function serve(side, port, { nudge = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    try {
      if (url.pathname.startsWith('/api/dsh.chatroom/')) {
        const endpoint = url.pathname.slice('/api/dsh.chatroom/'.length)
        const body = await readJson(req)
        let result
        try {
          if (body.method !== `dsh.chatroom/${endpoint}`) throw Object.assign(new Error('bad method'), { code: 'bad_method' })
          const payload = body.payload ?? {}
          if (endpoint === 'snapshot') {
            result = { ok: true, value: side.snapshot() }
          } else if (endpoint === 'command') {
            result = { ok: true, value: await side.command(payload) }
          } else if (endpoint === 'watch') {
            await waitForChange(side.store, Number(payload.since ?? -1), undefined)
            result = { ok: true, value: side.snapshot() }
          } else {
            throw Object.assign(new Error('not found'), { code: 'not_found' })
          }
        } catch (error) {
          result = { ok: false, error: { code: error?.code ?? 'internal_error', message: String(error?.message ?? error) } }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
        return
      }

      if (nudge && url.pathname === '/preview/nudge') {
        nudge()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // 截图用：让宿主真的把那间屋子解散，好去截加入方那边的「墓碑」状态。
      // 走的是插件自己的 command，不是给页面塞假数据。
      if (nudge && url.pathname === '/preview/dissolve') {
        const view = host.snapshot()
        const room = view.rooms.find((row) => !row.remote) ?? view.rooms[0]
        if (room) await host.command({ action: 'room.dissolve', input: { roomId: room.id } })
        await new Promise((resolve) => setTimeout(resolve, 600))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: Boolean(room), roomId: room?.id ?? null }))
        return
      }

      const map = {
        '/': join(here, 'index.html'),
        '/client.js': join(root, 'lib', 'client.js'),
        '/entry.js': join(here, 'public', 'entry.js'),
      }
      const file = map[url.pathname]
      if (!file) {
        res.writeHead(404).end('not found')
        return
      }
      const body = await readFile(file)
      const ext = file.slice(file.lastIndexOf('.'))
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(error?.stack ?? error))
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`preview ${side === host ? 'host' : 'guest'}: http://127.0.0.1:${port}/`)
  })
  return server
}

serve(host, hostPort, { nudge: () => host.nudge() })
serve(guest, guestPort)
