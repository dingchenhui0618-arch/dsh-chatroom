/**
 * 真实外壳截图：把本仓库装进一台真的 DSH，用真的浏览器点一遍，拍下插件在宿主界面里的样子。
 *
 * 为什么单独有这个脚本：`preview:shots` 那 17 张是「真客户端 + 替身外壳」，逐字节可复现，
 * 但看不出「装进 DSH 到底长什么样」。这张图补的就是那一段 —— 它在真的侧栏里、真的会话
 * 界面里、真的宿主主题下，走的是真的 RPC（建房、加 agent、发消息都落了库）。
 *
 * 它不参与像素门禁：要先联网装一个固定版本的 dsh、起一台真 web，属于集成证据，不是回归基线。
 *
 * 用法（先按 README 的「真外壳」小节把临时 profile 装好、把 dsh web 起起来）：
 *
 *   node tools/real-shell.mjs --url "http://127.0.0.1:3411/?token=<启动时打印的 token>" \
 *                             --out docs/real-shell.png
 *
 * 脚本只读页面、只点界面上本来就有的按钮（建房 / 加 agent / 发一句），不改任何配置。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name) => {
  const hit = args.find((row) => row === `--${name}` || row.startsWith(`--${name}=`))
  if (!hit) return null
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const index = args.indexOf(hit)
  return args[index + 1] ?? null
}

const url = argOf('url')
const out = resolve(argOf('out') ?? 'docs/real-shell.png')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const cdpPort = Number(argOf('port') ?? 9337)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!url) {
  console.error('缺少 --url：把 dsh web 启动时打印的那条带 token 的地址给它。')
  process.exit(2)
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

  static async connect(target) {
    const ws = new WebSocket(target)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连不上')), { once: true })
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
}

async function waitForJson(target, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(target)
      if (response.ok) return await response.json()
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(250)
  }
  throw new Error(`CDP 没有就绪：${target}`)
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (result.exceptionDetails) {
    throw new Error(`${result.exceptionDetails.text ?? '页面脚本报错'}：${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result?.value
}

async function waitUntil(cdp, sessionId, expression, label, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (await evaluate(cdp, sessionId, expression)) return true
    await sleep(150)
  }
  throw new Error(`等不到：${label}`)
}

/** 点一个「看得见的文字正好是 label」的按钮。 */
const clickText = (label, maxLeft) => {
  const leftFilter = maxLeft == null ? '' : `.filter((n) => n.getBoundingClientRect().left < ${Number(maxLeft)})`
  return `(() => {
  const rows = [...document.querySelectorAll('button,[role="button"],a')]
    .filter((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
    .filter((n) => n.offsetParent !== null)${leftFilter}
  const node = rows[0]
  if (!node) return false
  node.click()
  return true
})()`
}

/** React 受控输入：改 value 不会触发渲染，得走原生 setter 再派发 input。 */
const setInput = (selector, value, index = 0) => `(() => {
  const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
  if (!node) return false
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  node.focus()
  setter.call(node, ${JSON.stringify(value)})
  node.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

/**
 * 外壳自己会弹两个窗（「预览版说明」「开始使用」），它们盖在插件上面。
 * 只关窗、不登录：这脚本要证明的是插件在真外壳里跑起来了。
 */
const dismissOverlay = `(() => {
  const visible = (n) => n && n.offsetParent !== null
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible)
  if (!dialogs.length) return { closed: false, left: 0 }
  const dialog = dialogs[dialogs.length - 1]
  const buttons = [...dialog.querySelectorAll('button')].filter(visible)
  const pick = buttons.find((n) => /关闭|知道了|继续|以后/i.test([n.getAttribute('aria-label'), n.title, n.textContent].filter(Boolean).join(' ')))
  if (!pick) return { closed: false, left: dialogs.length }
  pick.click()
  return { closed: true, via: (pick.getAttribute('aria-label') || pick.textContent || '').trim().slice(0, 12), left: dialogs.length }
})()`

const profileDir = await mkdtemp(join(tmpdir(), 'chatroom-realshell-'))
const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--force-device-scale-factor=2',
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${cdpPort}`,
  'about:blank',
], { stdio: 'ignore' })

const report = { url, out, overlays: [], steps: [] }
try {
  const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`)
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  }, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)

  await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('button,[role="button"],a').length > 4)()`, '外壳渲染')
  await sleep(900)

  for (let i = 0; i < 8; i += 1) {
    const result = await evaluate(cdp, sessionId, dismissOverlay)
    if (!result.closed) break
    report.overlays.push(result)
    await sleep(450)
  }
  await sleep(400)

  // 侧栏点开「聊天室」：这是真的 sidebar.panellist 入口，不是替身。
  const opened = await evaluate(cdp, sessionId, clickText('聊天室', 320))
  if (!opened) throw new Error('左侧栏里没有「聊天室」入口')
  await waitUntil(cdp, sessionId, `(() => !!document.querySelector('.cr-grid'))()`, '插件面板挂载')
  await sleep(500)
  report.steps.push({ step: 'panel', first: await evaluate(cdp, sessionId, `!!document.querySelector('.cr-first')`) })

  // 一间屋子都没有：用第一屏那张卡上的入口真建一间。
  if (await evaluate(cdp, sessionId, `(() => !!document.querySelector('.cr-first'))()`)) {
    if (!(await evaluate(cdp, sessionId, clickText('新建房间')))) throw new Error('第一屏上的「新建房间」点不到')
    await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('.cr-form .cr-field').length >= 2)()`, '建房表单')
    await evaluate(cdp, sessionId, setInput('.cr-form .cr-field', '夜里的活儿', 0))
    await sleep(120)
    await evaluate(cdp, sessionId, setInput('.cr-form .cr-field', '三台机器的进度对一下', 1))
    await sleep(120)
    if (!(await evaluate(cdp, sessionId, clickText('建好')))) throw new Error('「建好」点不到')
    await waitUntil(cdp, sessionId, `(() => !!document.querySelector('.cr-textarea'))()`, '房间建出来')
    await sleep(400)
    report.steps.push({ step: 'room created' })
  }

  // 一个 agent 都没有就建一个：成员列里得有人和 agent 两类，图才说明得了「真人与他的 agent 同屋」。
  if (!(await evaluate(cdp, sessionId, `document.querySelectorAll('.cr-member').length > 1`))) {
    if (await evaluate(cdp, sessionId, clickText('+ 加一个 agent'))) {
      const form = await waitUntil(
        cdp,
        sessionId,
        `(() => document.querySelectorAll('.cr-agent-form .cr-field').length >= 2)()`,
        'agent 表单',
        24,
      ).catch(() => false)
      if (form) {
        await evaluate(cdp, sessionId, setInput('.cr-agent-form .cr-field', '小满', 0))
        await sleep(120)
        await evaluate(cdp, sessionId, setInput('.cr-agent-form .cr-field', '把三台机器的进度收成一段', 1))
        await sleep(120)
        await evaluate(cdp, sessionId, clickText('保存'))
        await sleep(700)
      }
      report.steps.push({ step: 'agent', form })
    }
  }

  // 屋里还一句话都没有：真的说一句。不带 @，所以不会去叫模型 —— 这台临时外壳通常没配 key。
  if ((await evaluate(cdp, sessionId, `document.querySelectorAll('.cr-msg').length`)) === 0) {
    await evaluate(cdp, sessionId, setInput('.cr-textarea', '各自手上的那件先说清楚，别急着互相接话。'))
    await sleep(200)
    const sent = await evaluate(cdp, sessionId, `(() => {
      const button = [...document.querySelectorAll('.cr-input-row button')].find((n) => n.textContent.trim() === '发送')
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)
    if (!sent) throw new Error('「发送」点不到')
    await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('.cr-msg').length > 0)()`, '消息进对话', 60)
    await sleep(500)
    report.steps.push({ step: 'message' })
  }

  report.measure = await evaluate(cdp, sessionId, `(() => {
    const box = document.querySelector('.cr-grid')?.getBoundingClientRect()
    const column = document.querySelector('.cr-col')?.getBoundingClientRect()
    const primary = [...document.querySelectorAll('.cr-btn.cr-primary')].find((n) => n.offsetParent !== null)
    const style = primary ? getComputedStyle(primary) : null
    return {
      grid: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null,
      firstColumn: column ? { width: Math.round(column.width) } : null,
      primary: style ? { ink: style.color, fill: style.backgroundColor, height: Math.round(primary.getBoundingClientRect().height) } : null,
      rooms: document.querySelectorAll('.cr-room').length,
      members: document.querySelectorAll('.cr-member').length,
      messages: document.querySelectorAll('.cr-msg').length,
      overlaysLeft: [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.offsetParent !== null).length,
    }
  })()`)

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, Buffer.from(data, 'base64'))
  report.steps.push({ step: 'shot' })
  console.log(JSON.stringify(report, null, 2))
} finally {
  chrome.kill()
}
