import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Client 半边的装载测试。
 *
 * 这一半跑在浏览器里，装错了的后果是整个页面白屏，所以至少要在 Node 里
 * 走一遍它真实的加载协议：window.__ModuleLoader__.load({id, factory}) →
 * factory(require) → apply(ctx)。React 用一个极小的桩替身，
 * 因为这里验证的是「注册了什么」，不是「渲染成什么样」。
 */

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

function makeDocument() {
  const appended = []
  return {
    appended,
    title: 'DSH',
    head: {
      appendChild: (node) => appended.push(node),
    },
    createElement: () => ({
      setAttribute: () => {},
      remove: () => {},
      textContent: '',
    }),
  }
}

function makeClientCtx() {
  const injected = []
  const registered = []
  const effects = []
  const disposers = []
  const css = []
  const ctx = {
    effect(fn, label) {
      effects.push(label ?? 'effect')
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject(name, factory) {
        injected.push(name)
        // DSH 的真实行为是「先有 slot，再登记」；这里直接跑工厂。
        factory()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    get: () => undefined,
    connection: undefined,
  }
  return { ctx, injected, registered, effects, css, disposers }
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

const EMPTY_SNAPSHOT = { revision: 3, self: { id: 'me', name: '我' }, rooms: [], bots: [], links: [] }

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value }
}

let captured = null

async function clientExports() {
  if (!captured) {
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => {
          captured = definition
        },
      },
    }
    globalThis.document = makeDocument()
    await import(pathToFileURL(join(process.cwd(), 'lib', 'client.js')).href)
  }
  return captured.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })
}

test('client bundle：按加载协议装载，注册侧栏入口、主面板、会话开关、悬浮窗', async () => {
  const exports = await clientExports()
  // 这条只验装载：把请求打回一个「没有服务器」的错误，别真去连谁。
  globalThis.fetch = async () => {
    throw Object.assign(new Error('测试里没有服务器'), { code: 'disabled' })
  }

  assert.ok(captured, '应该调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-chatroom', 'id 必须精确等于包名')

  assert.equal(exports.name, 'dsh-chatroom')
  assert.ok(Array.isArray(exports.inject))
  assert.equal(typeof exports.apply, 'function')

  const { ctx, injected, registered, disposers } = makeClientCtx()
  exports.apply(ctx)

  assert.ok(injected.includes('sidebar.panellist'), '侧栏入口要注册')
  assert.ok(injected.includes('main'), '主面板要注册')
  assert.ok(injected.includes('shell.overlay'), '悬浮窗要注册')

  const panellist = registered.find((row) => row.options.name === 'sidebar.panellist')
  const main = registered.find((row) => row.options.name === 'main')
  assert.ok(panellist && main)
  // 面板 key 必须等于侧栏入口 id，否则点侧栏打不开面板 —— 这是这个 slot 的契约。
  assert.equal(main.options.key, panellist.options.id)
  assert.equal(typeof panellist.component, 'function')

  // 样式与控制台错误都不该在装载阶段抛
  assert.ok(globalThis.document.appended.length >= 1, '应该注入一份样式')
  // 装载就会开始长轮询，测试结束必须把它停掉，否则 node --test 等不到事件循环空下来。
  for (const dispose of disposers) dispose()
})

test('有连接服务时走 rpc.call：拿到快照后才开始长轮询，一次都不碰 fetch', async () => {
  const exports = await clientExports()
  let fetched = 0
  globalThis.fetch = async () => {
    fetched += 1
    throw new Error('有连接服务时不该走 fetch')
  }
  const calls = []
  const { ctx, disposers } = makeClientCtx()
  ctx.connection = {
    rpc: {
      call: async (channel, method, payload, signal) => {
        calls.push({ channel, method, payload, hasSignal: Boolean(signal) })
        return { ok: true, value: method.endsWith('/watch') ? { revision: 3 } : EMPTY_SNAPSHOT }
      },
    },
  }
  exports.apply(ctx)
  await tick(60)

  assert.ok(calls.length >= 1, 'apply 之后应该立刻拉一次快照')
  assert.equal(calls[0].channel, '/api')
  assert.equal(calls[0].method, 'dsh.chatroom/snapshot')
  assert.equal(calls[0].hasSignal, true, 'RPC 要带可取消的 signal')
  assert.ok(
    calls.some((call) => call.method === 'dsh.chatroom/watch'),
    '拿到快照之后应该用同一条路开始长轮询',
  )
  assert.equal(fetched, 0)
  for (const dispose of disposers) dispose()
})

test('取不到连接服务时回落到同源的 /api：信封一样，面板照常工作', async () => {
  const exports = await clientExports()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const envelope = JSON.parse(init.body)
    return jsonResponse(
      envelope.method === 'dsh.chatroom/watch'
        ? { ok: true, value: { revision: 3 } }
        : { ok: true, value: EMPTY_SNAPSHOT },
    )
  }
  const { ctx, disposers } = makeClientCtx()
  exports.apply(ctx)
  await tick(60)

  const first = calls[0]
  assert.ok(first, 'apply 之后应该立刻拉一次快照')
  assert.equal(first.url, '/api/dsh.chatroom/snapshot', '回落用的是这个包自己的 /api 路由')
  assert.equal(first.init.method, 'POST')
  assert.equal(first.init.credentials, 'same-origin', '浏览器要带上自己的 Cookie')
  const envelope = JSON.parse(first.init.body)
  assert.equal(envelope.type, 'client-request', '信封与 rpc.call 完全一致')
  assert.equal(envelope.method, 'dsh.chatroom/snapshot')
  assert.equal(typeof envelope.rpcId, 'string')
  assert.deepEqual(envelope.payload, {})
  assert.ok(
    calls.some((call) => call.url === '/api/dsh.chatroom/watch'),
    '快照成功之后才会进入长轮询：说明这条回落路真跑通了',
  )
  for (const dispose of disposers) dispose()
})

