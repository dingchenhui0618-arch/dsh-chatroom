import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 两侧的协议面。
 *
 * 这个插件最难受的一类坏法不是算错，而是**两侧名字对不上**：界面还在面朝 `bot.update`
 * 喊，宿主那边已经把它改名了；加入方的代码还在敲 `/lan/reply`，宿主的路由里只剩
 * `/lan/assignments`。这类错没有异常、没有日志，表现是「点了没反应」「跨机器那轮永远不回」，
 * 排查要顺着网络一层层扒。
 *
 * 所以这里不测行为，只把两侧的字面量对齐：
 *   1. 界面调的每个 action，宿主必须有分支；
 *   2. 界面用的每个 RPC 方法，宿主必须有对应端点；
 *   3. 加入方调的每个 /lan 路由，宿主必须真的在服务。
 *
 * 判据是**严格子集**：多出来的宿主分支（`msg.retry` 这种只在内部用的）不算问题。
 */

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host/plugin.js', import.meta.url), 'utf8')
const guest = readFileSync(new URL('../src/host/lan-guest.js', import.meta.url), 'utf8')
const lanHost = readFileSync(new URL('../src/host/lan-host.js', import.meta.url), 'utf8')

/**
 * 客户端里那些「长得像 action 但不是」的点号名字：它们是 slot 的 key。
 * 加新的白名单项要想清楚——白名单越长，这个用例能挡住的错就越少。
 */
const NOT_ACTIONS = new Set(['shell.overlay', 'sidebar.panellist'])

function collect(source, pattern) {
  const found = new Set()
  for (const match of source.matchAll(pattern)) found.add(match[1])
  return found
}

test('协议面：界面调的每个 action，宿主都有分支', () => {
  const hostActions = collect(host, /case '([a-z]+(?:\.[a-zA-Z]+)+)'/g)
  const clientNames = collect(client, /['`]([a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)['`]/g)

  assert.ok(hostActions.size >= 15, `宿主分支只读到 ${hostActions.size} 个，正则大概被改坏了`)
  assert.ok(clientNames.size >= 15, `界面里的名字只读到 ${clientNames.size} 个，正则大概被改坏了`)

  const missing = [...clientNames].filter((name) => !NOT_ACTIONS.has(name) && !hostActions.has(name))
  assert.deepEqual(missing, [], `界面会调、宿主没有分支：${missing.join('、')}`)
})

test('协议面：界面用的每个 RPC 方法，宿主都有对应端点', () => {
  const methods = collect(client, /\brpc\(\s*'([a-z]+)'/g)
  assert.ok(methods.size >= 3, `界面的 RPC 方法只读到 ${methods.size} 个`)
  for (const method of methods) {
    assert.match(
      host,
      new RegExp(`endpoint === '${method}'`),
      `界面在调 ${method}，宿主没有这个端点`,
    )
  }
  // 长轮询是「新消息到眼前」的唯一通道，少了它界面不会报错，只会一直不刷新。
  assert.ok(methods.has('watch'), '界面必须还在走 watch 长轮询')
})

test('协议面：加入方调的每个 /lan 路由，宿主都在服务', () => {
  const guestPaths = collect(guest, /(\/lan\/[a-z]+)/g)
  const hostPaths = collect(lanHost, /(\/lan\/[a-z]+)/g)

  for (const required of ['/lan/join', '/lan/state', '/lan/assignments', '/lan/reply']) {
    assert.ok(guestPaths.has(required), `加入方少了 ${required}，跨机器那一轮就断了`)
  }

  const missing = [...guestPaths].filter((path) => !hostPaths.has(path))
  assert.deepEqual(missing, [], `加入方在敲、宿主没挂这条路由：${missing.join('、')}`)
})
