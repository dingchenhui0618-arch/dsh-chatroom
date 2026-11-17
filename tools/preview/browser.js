import React from 'react'
import { createRoot } from 'react-dom/client'

/**
 * 浏览器侧的挂载脚本（esbuild 打包成 public/entry.js）。
 *
 * 它扮演 DSH 客户端的两个角色：模块加载器 + 一个只提供 slots/locale/connection 的
 * 最小 ctx。之后真的是 lib/client.js 自己注册四个 slot、自己拉 snapshot、自己渲染。
 */

const registry = new Map()
const dictionaries = {}
const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'panel'

let loaded = null

window.__ModuleLoader__ = {
  load(spec) {
    if (spec.id !== 'dsh-chatroom') throw new Error(`unexpected module id: ${spec.id}`)
    const require = (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    }
    loaded = spec.factory(require)
  },
}

const source = await (await fetch('/client.js', { cache: 'no-store' })).text()
new Function(source)()

if (!loaded || typeof loaded.apply !== 'function') throw new Error('client bundle did not export apply')

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: () => undefined,
  locale: {
    register(namespace, dictionariesFor) {
      dictionaries[namespace] = dictionariesFor
      return () => {}
    },
    bind(namespace) {
      return (key) => dictionaries[namespace]?.zh?.[key] ?? key
    },
  },
  slots: {
    inject(_name, register) {
      return register()
    },
    register(description, component) {
      registry.set(description.name, { description, component })
      return () => registry.delete(description.name)
    },
  },
  connection: {
    rpc: {
      async call(_path, method, payload, signal) {
        const response = await fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method,
            payload: payload ?? {},
          }),
          signal,
        })
        const envelope = await response.json()
        return envelope.result
      },
    },
  },
}

loaded.apply(ctx)

function mount(id) {
  const element = document.getElementById(id)
  return element ? createRoot(element) : null
}

const slots = {
  nav: 'sidebar.panellist',
  panel: 'main',
  header: 'conversation.session.header.actions',
  overlay: 'shell.overlay',
}

for (const [domId, slotName] of Object.entries(slots)) {
  const entry = registry.get(slotName)
  const root = mount(`root-${domId}`)
  if (entry && root) root.render(React.createElement(entry.component))
}

document.documentElement.dataset.view = view
window.__chatroomPreview = { registry, view }
