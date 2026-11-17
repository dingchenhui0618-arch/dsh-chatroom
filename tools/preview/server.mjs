import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootFixture } from './fixture.mjs'

/**
 * 截图用的最小服务器：静态文件 + 三个和线上同形的端点。
 * 客户端那半边完全不知道自己在替身里 —— 它照样走 /api/dsh.chatroom/* 与长轮询。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const port = Number(process.env.PREVIEW_PORT ?? 3491)

const fixture = await bootFixture()

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
          result = { ok: true, value: fixture.snapshot() }
        } else if (endpoint === 'command') {
          result = { ok: true, value: fixture.command(payload) }
        } else if (endpoint === 'watch') {
          await waitForChange(fixture.store, Number(payload.since ?? -1), undefined)
          result = { ok: true, value: fixture.snapshot() }
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

    if (url.pathname === '/preview/nudge') {
      fixture.nudge()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
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
  console.log(`preview: http://127.0.0.1:${port}/`)
})
