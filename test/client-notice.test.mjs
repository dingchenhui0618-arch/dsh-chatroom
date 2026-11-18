import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/**
 * 提醒（右下角那条 toast）到底在提醒什么。
 *
 * 这条链路原先有个很别扭的毛病：判断「有没有新消息」用的是全屋未读总数，
 * 而被念出来的那句话取的是**当前激活屋子**的最后一句。于是三种真实情形都错：
 *   1. 你在 A 屋，B 屋的 agent 回了你 —— toast 念的是 A 屋的旧话，点开也停在 A 屋；
 *   2. A 屋最后一句是人说的 —— 干脆一声不响，B 屋的回复没有提醒；
 *   3. A 屋的未读刚被读掉、B 屋同时来一条 —— 两边相加的总数没变，提醒消失。
 *
 * 这里对着 store 真跑：喂两份快照（真长轮询就是给这一份结构），看它挑哪间屋子、
 * 哪句话、点一下之后停在哪。React 用极小桩替身，验的是状态机而不是像素。
 */

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

function makeDocument() {
  return {
    title: 'DSH',
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
  }
}

let captured = null

async function loadClient() {
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        captured = definition
      },
    },
  }
  globalThis.document = makeDocument()
  await import(pathToFileURL(join(process.cwd(), 'lib', 'client.js')).href)
  return captured.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

function msg(seq, kind, name, text) {
  return {
    id: 'm' + seq,
    seq: seq,
    authorId: kind === 'bot' ? 'bot1' : 'me',
    authorName: name,
    authorKind: kind,
    text: text,
    at: '2026-11-18T00:00:00.000Z',
  }
}

function room(id, name, unread, messages) {
  return { id: id, name: name, unread: unread, messages: messages }
}

function snapshot(revision, rooms, activeRoomId) {
  return {
    revision: revision,
    self: { id: 'me', name: '我' },
    rooms: rooms,
    activeRoomId: activeRoomId,
    bots: [],
    links: [],
    lan: { serving: false },
  }
}

/**
 * 起一个只连着假 RPC 的客户端：快照由 stage 决定，command 记下来，
 * watch 挂住不动 —— 长轮询在这里没用，提醒是被「新快照」推出来的。
 */
async function boot(first) {
  const exports = await loadClient()
  const registered = []
  const disposers = []
  const stage = { snapshot: first, commands: [], activated: null }
  const ctx = {
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(name, factory) {
        factory()
      },
      register(options, component) {
        registered.push({ options: options, component: component })
        return () => {}
      },
    },
    get: () => undefined,
    connection: {
      rpc: {
        call: async (channel, method, payload) => {
          if (method === 'dsh.chatroom/snapshot') return { ok: true, value: stage.snapshot }
          if (method === 'dsh.chatroom/watch') return new Promise(() => {})
          if (method === 'dsh.chatroom/command') {
            stage.commands.push(payload)
            return { ok: true, value: stage.activated || stage.snapshot }
          }
          if (method === 'dsh.chatroom/messages') return { ok: true, value: { messages: [], hasMore: false, total: 0 } }
          throw new Error('unexpected method: ' + method)
        },
      },
    },
  }
  exports.apply(ctx)
  await tick()
  // 侧栏入口把 store 当 props 递给图标组件 —— 这是从外面拿到真 store 的唯一一条路。
  const nav = registered.find((row) => row.options.name === 'sidebar.panellist')
  const store = nav.component().props.store
  assert.ok(store, '侧栏入口应该把 store 传下来')
  return { store: store, stage: stage, dispose: () => disposers.forEach((run) => run()) }
}

test('提醒说的是「哪间屋子新来那句」：在 A 屋时 B 屋的回复要点名 B 屋那句', async () => {
  const first = snapshot(
    5,
    [
      room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '今天的排期已经发在群公告里了')]),
      room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '这周先把报表对齐')]),
    ],
    'ra',
  )
  const client = await boot(first)
  try {
    assert.equal(client.store.get().snapshot.revision, 5, '首份快照应该已经落地')

    client.stage.snapshot = snapshot(
      6,
      [
        room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '今天的排期已经发在群公告里了')]),
        room('rb', '退货复盘', 1, [msg(1, 'human', '老陈', '这周先把报表对齐'), msg(2, 'bot', '阿乙', '7.1% 已经核过了')]),
      ],
      'ra',
    )
    await client.store.refresh()

    const notice = client.store.get().notice
    assert.ok(notice, 'B 屋来了 agent 的回复，就该有提醒')
    assert.equal(notice.room, '退货复盘', '提醒必须点名消息真正来的那间屋子，而不是当前打开的那间')
    assert.equal(notice.roomId, 'rb', '提醒要记着屋子 id：点一下得能切过去')
    assert.equal(notice.name, '阿乙', '提醒报的是说话的那个人')
    assert.equal(notice.text, '7.1% 已经核过了', '提醒念的是这一轮新来的那句，不是当前屋子的旧话')
  } finally {
    client.dispose()
  }
})

test('当前屋子的最后一句是人说的，别处 agent 的回复照样要提醒', async () => {
  const first = snapshot(
    5,
    [
      room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '早'), msg(2, 'human', '我', '我先看下排期')]),
      room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '这周先把报表对齐')]),
    ],
    'ra',
  )
  const client = await boot(first)
  try {
    client.stage.snapshot = snapshot(
      6,
      [
        room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '早'), msg(2, 'human', '我', '我先看下排期')]),
        room('rb', '退货复盘', 1, [msg(1, 'human', '老陈', '这周先把报表对齐'), msg(2, 'bot', '阿乙', '核完了，差 0.3 个点')]),
      ],
      'ra',
    )
    await client.store.refresh()

    const notice = client.store.get().notice
    assert.ok(notice, 'A 屋最后一句是人说的，不代表别处没有 agent 的回复')
    assert.equal(notice.room, '退货复盘')
    assert.equal(notice.text, '核完了，差 0.3 个点')
  } finally {
    client.dispose()
  }
})

test('一边读掉、一边来新的：未读总数没变，提醒也不能丢', async () => {
  const first = snapshot(
    5,
    [
      room('ra', '早会', 1, [msg(1, 'bot', '阿甲', '排期看下')]),
      room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '先对齐报表')]),
    ],
    'ra',
  )
  const client = await boot(first)
  try {
    // A 屋那 1 条被读掉了，同时 B 屋来 1 条：1 → 1，总数一模一样。
    client.stage.snapshot = snapshot(
      6,
      [
        room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '排期看下')]),
        room('rb', '退货复盘', 1, [msg(1, 'human', '老陈', '先对齐报表'), msg(2, 'bot', '阿乙', '报表对齐了')]),
      ],
      'ra',
    )
    await client.store.refresh()

    const notice = client.store.get().notice
    assert.ok(notice, '判据是「哪间屋子涨了」，不是「总数大了」')
    assert.equal(notice.room, '退货复盘')
    assert.equal(notice.text, '报表对齐了')
  } finally {
    client.dispose()
  }
})

test('只有人说话也要提醒，报的是那个人；同一间屋子别把旧话再念一遍', async () => {
  const first = snapshot(5, [room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '先对齐报表')])], 'rb')
  const client = await boot(first)
  try {
    // 同一间屋子：新来的是 agent 的，报新的那句。
    client.stage.snapshot = snapshot(
      6,
      [room('rb', '退货复盘', 1, [msg(1, 'human', '老陈', '先对齐报表'), msg(2, 'bot', '阿乙', '对齐了')])],
      'rb',
    )
    await client.store.refresh()
    assert.equal(client.store.get().notice.text, '对齐了')

    // 再来一条，是另一个人说的：也提醒，名字得换成他。
    client.store.set({ notice: null })
    client.stage.snapshot = snapshot(
      7,
      [
        room('rb', '退货复盘', 2, [
          msg(1, 'human', '老陈', '先对齐报表'),
          msg(2, 'bot', '阿乙', '对齐了'),
          msg(3, 'human', '小周', '我这边补一句：仓库那批也算进去了'),
        ]),
      ],
      'rb',
    )
    await client.store.refresh()
    const notice = client.store.get().notice
    assert.ok(notice, '人说的话也要提醒 —— 那也是「有话说」')
    assert.equal(notice.name, '小周')
    assert.equal(notice.text, '我这边补一句：仓库那批也算进去了')
  } finally {
    client.dispose()
  }
})

test('点一下提醒：开窗、切到那句话所在的屋子；本来就在那间就不必切', async () => {
  const first = snapshot(
    5,
    [
      room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '排期看下')]),
      room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '先对齐报表')]),
    ],
    'ra',
  )
  const client = await boot(first)
  try {
    client.stage.snapshot = snapshot(
      6,
      [
        room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '排期看下')]),
        room('rb', '退货复盘', 1, [msg(1, 'human', '老陈', '先对齐报表'), msg(2, 'bot', '阿乙', '7.1% 已经核过了')]),
      ],
      'ra',
    )
    await client.store.refresh()
    const notice = client.store.get().notice
    assert.equal(notice.roomId, 'rb')

    // 宿主回一份「已经切到 rb」的快照：投影里 rb 也就读掉了。
    client.stage.activated = snapshot(
      7,
      [
        room('ra', '早会', 0, [msg(1, 'bot', '阿甲', '排期看下')]),
        room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '先对齐报表'), msg(2, 'bot', '阿乙', '7.1% 已经核过了')]),
      ],
      'rb',
    )
    await client.store.focusRoom(notice)

    assert.deepEqual(
      client.stage.commands.map((row) => [row.action, row.input.roomId]),
      [['room.activate', 'rb']],
      '点提醒 = 把这个屋子打开，而不是把人留在原来那间',
    )
    assert.equal(client.store.get().floatOpen, true, '点一下要把悬浮窗打开')
    assert.equal(client.store.get().notice, null, '点过就把这条提醒收掉')
    assert.equal(client.store.get().snapshot.activeRoomId, 'rb', '切完之后当前屋子就是提醒里那间')

    // 已经在看这间屋子：再点一次不该白跑一趟宿主。
    await client.store.focusRoom({ roomId: 'rb', text: '' })
    assert.equal(client.stage.commands.length, 1, '同屋不该再发一次 room.activate')
  } finally {
    client.dispose()
  }
})

test('浮窗开着就不弹提醒：人已经看见了，不该在右下角再拦一次', async () => {
  const first = snapshot(5, [room('rb', '退货复盘', 0, [msg(1, 'human', '老陈', '先对齐报表')])], 'rb')
  const client = await boot(first)
  try {
    client.store.set({ floatOpen: true })
    client.stage.snapshot = snapshot(
      6,
      [room('rb', '退货复盘', 1, [msg(1, 'human', '老陈', '先对齐报表'), msg(2, 'bot', '阿乙', '对齐了')])],
      'rb',
    )
    await client.store.refresh()
    assert.equal(client.store.get().notice, null)
  } finally {
    client.dispose()
  }
})
