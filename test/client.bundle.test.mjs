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
  const css = []
  const ctx = {
    effect(fn, label) {
      effects.push(label ?? 'effect')
      const disposer = typeof fn === 'function' ? fn() : undefined
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
  return { ctx, injected, registered, effects, css }
}

test('client bundle：按加载协议装载，注册侧栏入口、主面板、会话开关、悬浮窗', async () => {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        captured = definition
      },
    },
  }
  globalThis.document = makeDocument()

  await import(pathToFileURL(join(process.cwd(), 'lib', 'client.js')).href)

  assert.ok(captured, '应该调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-chatroom', 'id 必须精确等于包名')

  const exports = captured.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })

  assert.equal(exports.name, 'dsh-chatroom')
  assert.ok(Array.isArray(exports.inject))
  assert.equal(typeof exports.apply, 'function')

  const { ctx, injected, registered } = makeClientCtx()
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
})
