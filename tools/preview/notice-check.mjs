import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 真 Chrome 里验一条链路：多房间时那条提醒指的是谁，点一下去哪儿。
 *
 * 单测（test/client-notice.test.mjs）验的是 store 的判据；这里验的是同一份
 * lib/client.js 在真浏览器里跑出来的 DOM 与真点击：另一间屋子来了 agent 的回复，
 * toast 必须点名那间屋子、念那句新话，点一下要真的切过去。
 *
 * 自己起一台预览服务、自己的 Chrome，结束时都关掉 —— 不碰 npm run preview:serve
 * 那台，也不写 docs/。用法：node tools/preview/notice-check.mjs
 */

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PREVIEW_NOTICE_PORT ?? 3471)
const guestPort = Number(process.env.PREVIEW_NOTICE_GUEST_PORT ?? port + 1)
const cdpPort = Number(process.env.PREVIEW_NOTICE_CDP_PORT ?? 9335)

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((path) => path && existsSync(path))

if (!CHROME) throw new Error('找不到 Chrome 可执行文件')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForJson(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error(`等不到：${url}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify(payload))
    })
  }

  close() {
    this.ws.close()
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面脚本报错')
  return result.result?.value
}

async function waitFor(cdp, sessionId, expression, label, attempts = 150) {
  for (let i = 0; i < attempts; i += 1) {
    if (await evaluate(cdp, sessionId, expression)) return true
    await sleep(100)
  }
  throw new Error(`等不到${label}`)
}

/** 走界面同一条 `/api/dsh.chatroom/<端点>`（同样的信封），让宿主真落库、真派发。 */
async function rpc(method, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh.chatroom/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'notice-' + method,
      method: 'dsh.chatroom/' + method,
      payload: payload ?? {},
    }),
  })
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`${method} 失败：${JSON.stringify(body.result)}`)
  return body.result.value
}

const snapshotOf = () => rpc('snapshot', {})

const server = spawn(process.execPath, [join(here, 'server.mjs')], {
  env: {
    ...process.env,
    PREVIEW_PORT: String(port),
    PREVIEW_GUEST_PORT: String(guestPort),
    // 这一跑只关心提醒，不看局域网：端口交给系统挑，免得和别的东西撞。
    PREVIEW_LAN_PORT: '0',
  },
  stdio: 'ignore',
})

const profileDir = await mkdtemp(join(tmpdir(), 'chatroom-notice-'))
let chrome = null
let cdp = null

try {
  const info = await waitForJson(`http://127.0.0.1:${port}/preview/writes`)
  if (Number(info.writes) > 0) throw new Error(`预览服务已经被写过 ${info.writes} 次，换一台再跑`)
  console.log(`预览服务就绪 — 宿主端口 ${port}`)

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`)
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  )
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?view=session` }, sessionId)
  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-float-pill'))`, '会话界面里的折叠胶囊')

  // ---- 摆出「在看 B 屋、消息来在 A 屋」这个处境 -------------------------------
  const seeded = await snapshotOf()
  const roomA = seeded.rooms[0]
  const agent = (seeded.bots || [])[0]
  if (!roomA) throw new Error('种子房间里一间都没有，预览状态不对')
  if (!agent) throw new Error('宿主还没有 agent，没人会回话')

  const created = await rpc('command', { action: 'room.create', input: { name: '提醒测试的房间' } })
  const roomB = created.rooms.find((row) => row.name === '提醒测试的房间')
  if (!roomB) throw new Error('新建的屋子没出现在快照里')
  await rpc('command', { action: 'room.activate', input: { roomId: roomB.id } })
  // B 屋最后一句是人说的：旧代码只认「当前屋子最后一句是 agent 说的」，这里正好落空。
  await rpc('command', { action: 'msg.send', input: { roomId: roomB.id, text: '先把 B 屋这句放着，我去看一眼别的屋子' } })

  const active = (await snapshotOf()).activeRoomId
  if (active !== roomB.id) throw new Error(`当前屋子应该是 B 屋，实际 ${active}`)
  await waitFor(
    cdp,
    sessionId,
    `(async () => (await (await fetch('/api/dsh.chatroom/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'dsh.chatroom/snapshot', payload: {} }) })).json()).result.value.activeRoomId === ${JSON.stringify(roomB.id)})()`,
    '界面自己认下的当前屋子是 B 屋',
  )
  console.log(`处境就位 — 当前看「${roomB.name}」，消息接下来来在「${roomA.name}」`)

  // A 屋里 @ 那个 agent：它在自己那间屋子回话，B 屋这屏不动。
  await rpc('command', {
    action: 'msg.send',
    input: { roomId: roomA.id, text: `@${agent.name} 这一条是在另一间屋子里回的，数核完了吗` },
  })
  let after = null
  for (let i = 0; i < 80; i += 1) {
    const view = await snapshotOf()
    const row = view.rooms.find((room) => room.id === roomA.id)
    const last = row && row.messages[row.messages.length - 1]
    if (row && row.unread > 0 && last && last.authorKind === 'bot') {
      after = { room: row, last: last }
      break
    }
    await sleep(150)
  }
  if (!after) throw new Error('A 屋没等来 agent 的回复（fake 模型没派发？）')
  console.log(`A 屋来了回复 — 「${after.last.authorName}：${after.last.text}」，未读 ${after.room.unread}`)

  // ---- 提醒必须点名 A 屋、念这句新话 ----------------------------------------
  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-toast'))`, '右下角那条提醒')
  const toast = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const node = document.querySelector('.cr-toast')
      const name = node && node.querySelector('.cr-toast-name')
      return {
        title: name ? name.textContent : '',
        body: node ? node.textContent : '',
        rooms: [...document.querySelectorAll('.cr-room')].length,
      }
    })()`,
  )
  if (!toast.title.includes(roomA.name)) {
    throw new Error(`提醒该点名「${roomA.name}」，实际是「${toast.title}」`)
  }
  if (!toast.body.includes(after.last.text)) {
    throw new Error(`提醒该念 A 屋新来那句，实际是「${toast.body}」`)
  }
  if (toast.body.includes('先把 B 屋这句放着')) {
    throw new Error('提醒念成了 B 屋的旧话：挑屋子的判据又退回「当前打开那间」了')
  }
  const collapsed = await evaluate(cdp, sessionId, `Boolean(document.querySelector('.cr-float-card'))`)
  if (collapsed) throw new Error('还没点，浮窗不该自己展开')
  console.log(`verified — 提醒点名「${roomA.name}」，念的是 A 屋新来那句，没念 B 屋的旧话`)

  // ---- 点一下：开窗、切到 A 屋 --------------------------------------------
  await evaluate(cdp, sessionId, `(() => { document.querySelector('.cr-toast').click(); return true })()`)
  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-float-card'))`, '浮窗展开')
  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-toast')) === false`, '提醒被收掉')

  const switched = await snapshotOf()
  if (switched.activeRoomId !== roomA.id) {
    throw new Error(`点提醒之后当前屋子该是 A 屋，实际 ${switched.activeRoomId}`)
  }
  const title = await evaluate(cdp, sessionId, `(document.querySelector('.cr-float-title') || {}).textContent || ''`)
  if (!title.includes(roomA.name)) throw new Error(`浮窗标题该是「${roomA.name}」，实际「${title}」`)
  const body = await evaluate(
    cdp,
    sessionId,
    `[...document.querySelectorAll('.cr-float-msg')].map((node) => node.textContent).join('\\n')`,
  )
  if (!body.includes(after.last.text)) throw new Error('浮窗里没有那句新来的回复')
  console.log(`verified — 点一下提醒：浮窗展开、切到「${roomA.name}」、那句回复就在眼前`)

  // ---- 同一间屋子再来一条：提醒照弹，点一下留在原地 --------------------------
  // 先把浮窗收起 —— 浮窗开着的时候人已经看见了，按设计就不该再弹提醒。
  await evaluate(cdp, sessionId, `(() => { document.querySelector('.cr-float-head .cr-icon-btn').click(); return true })()`)
  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-float-card')) === false`, '浮窗收起')

  // 判「第二条来了」看条数与 seq 长没长，不看正文 —— fake 模型每次回的都是同一句话。
  const beforeCount = after.room.messages.length
  const beforeSeq = after.last.seq
  await rpc('command', { action: 'msg.send', input: { roomId: roomA.id, text: `@${agent.name} 再确认一次` } })
  let second = null
  for (let i = 0; i < 80; i += 1) {
    const view = await snapshotOf()
    const row = view.rooms.find((room) => room.id === roomA.id)
    const last = row && row.messages[row.messages.length - 1]
    if (row && row.messages.length > beforeCount && last && last.authorKind === 'bot' && last.seq > beforeSeq) {
      second = { room: row, last: last }
      break
    }
    await sleep(150)
  }
  if (!second) throw new Error('A 屋的第二条回复没来')

  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-toast'))`, '第二条提醒')
  const secondTitle = await evaluate(cdp, sessionId, `(document.querySelector('.cr-toast-name') || {}).textContent || ''`)
  if (!secondTitle.includes(roomA.name)) throw new Error(`第二条提醒该还点名「${roomA.name}」，实际「${secondTitle}」`)
  await evaluate(cdp, sessionId, `(() => { document.querySelector('.cr-toast').click(); return true })()`)
  await waitFor(cdp, sessionId, `Boolean(document.querySelector('.cr-float-card'))`, '第二条提醒点开的浮窗')
  await sleep(300)
  const still = await snapshotOf()
  // 人本来就在这间屋子：正文不该被切走（「同屋不重复发 room.activate」由单测守）。
  if (still.activeRoomId !== roomA.id) throw new Error('本来就在这间屋子，点提醒把人切走了')
  const stillTitle = await evaluate(cdp, sessionId, `(document.querySelector('.cr-float-title') || {}).textContent || ''`)
  if (!stillTitle.includes(roomA.name)) throw new Error(`浮窗该还在「${roomA.name}」，实际「${stillTitle}」`)
  console.log(`verified — 同屋再来一条：提醒照弹、点一下留在「${roomA.name}」`)

  console.log('all notice checks passed')
} finally {
  try {
    cdp?.close()
  } catch {
    /* 收尾时连接已经断了也无所谓 */
  }
  if (chrome) chrome.kill()
  server.kill()
}
