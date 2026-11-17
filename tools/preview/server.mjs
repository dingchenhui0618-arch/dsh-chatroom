import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootFixture, bootGuest, joinThirdMachine, warmUp } from './fixture.mjs'
// 往回翻历史这一屏走的是宿主同一个分页函数：预览里的翻页不是给界面塞假数据，
// 而是真的从房间记录里切出更早那一页。
import { pageMessages } from '../../src/host/project.js'

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

// 「这次状态被写过几次」：截图脚本靠它判断服务器是不是刚起来的。
// 状态一旦被上一轮补过消息或解散过，再截出来的图就不是 docs/ 里那些了。
const usage = { writes: 0 }

let host
try {
  host = await bootFixture({ port: wantedLanPort })
} catch (error) {
  console.warn(`[chatroom-preview] 固定端口 ${wantedLanPort} 起不来，改用系统挑的端口：${error?.message ?? error}`)
  host = await bootFixture({ port: 0 })
}
const guest = await bootGuest({ port: host.lanPort, code: host.code })
await warmUp(host, guest)
// 第三台机器按需加入：前七张截图拍的是「两台机器」的样子，多一台会改掉它们的内容。
let third = null
async function joinThird() {
  if (third) return third
  third = await joinThirdMachine(host)
  return third
}
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
          } else if (endpoint === 'messages') {
            // 预览这一半没有局域网（这一屏演的是宿主自己往回翻），镜像房间走不到这里。
            const room = side.store.state.rooms.find((row) => row.id === String(payload.roomId ?? ''))
            if (!room) throw Object.assign(new Error('找不到这间屋子。'), { code: 'room_not_found' })
            result = { ok: true, value: pageMessages(room, payload) }
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

      if (url.pathname === '/preview/writes') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ writes: usage.writes, roomCode: host.code, lanPort: host.lanPort, third: Boolean(third) }))
        return
      }

      // 只读：把宿主此刻的 LAN 现状（端口 + 排好序的地址）交给截图脚本当基准。
      // 邀请条上那句地址必须和这里对得上 —— 否则「排错序」这件事在截图上根本看不出来。
      if (url.pathname === '/preview/lan') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(host.lan.status()))
        return
      }
      // 让第三台机器真的加入（真握手、真派发）：这张截图要证明界面分得清「哪一台机器」。
      if (url.pathname === '/preview/third') {
        usage.writes += 1
        await joinThird()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // 截图用：「说了一句、谁都没接」那一屏 —— 建一间有 agent 的屋子，说一句没点名的话。
      if (url.pathname === '/preview/no-reply') {
        usage.writes += 1
        await host.noReply()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // 截图用：「往回翻历史」那一屏 —— 一间说满 240 句的屋子，投影只给最近 200 条。
      if (url.pathname === '/preview/history') {
        usage.writes += 1
        await host.history()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (nudge && url.pathname === '/preview/nudge') {
        usage.writes += 1
        nudge()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // 截图收尾用：把这一屏专开的演示例房间收掉。
      // 留着的话它会出现在后面几张图的房间列表里 —— 那是上一屏的故事，不是这一屏的。
      if (nudge && url.pathname === '/preview/tidy') {
        usage.writes += 1
        const view = host.snapshot()
        const demo = ['带人进屋', '半新半旧']
          .map((name) => view.rooms.find((row) => row.name === name))
          .filter(Boolean)
        for (const room of demo) await host.command({ action: 'room.dissolve', input: { roomId: room.id } })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: demo.length > 0, rooms: demo.map((room) => room.id) }))
        return
      }

      // 截图用：「加入之后才建 agent」那一屏 —— 第二台机器空手进来，再在屋里建一个。
      if (nudge && url.pathname === '/preview/bring') {
        usage.writes += 1
        const brought = await host.bringAgent()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, rooms: brought.snapshot.rooms.length }))
        return
      }

      // 截图用：让一台旧版本的机器真进来（老协议的 body，没有能力位也没有 agent），
      // 好去截「版本不一致时界面怎么说」那一屏。
      if (nudge && url.pathname === '/preview/old-peer') {
        usage.writes += 1
        const old = await host.oldPeer()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, rooms: old.snapshot.rooms.length }))
        return
      }

      // 截图用：让宿主这边的 agent 真失败一轮，好去截「没回上来 + 重试」那一屏。
      if (nudge && url.pathname === '/preview/fail') {
        usage.writes += 1
        const view = await host.failOnce()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, rooms: view.rooms.length }))
        return
      }

      // 截图用：让宿主真的把那间屋子解散，好去截加入方那边的「墓碑」状态。
      // 走的是插件自己的 command，不是给页面塞假数据。
      if (nudge && url.pathname === '/preview/dissolve') {
        usage.writes += 1
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
