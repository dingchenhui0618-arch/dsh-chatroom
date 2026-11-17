import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用真实 Chrome（无头）截 lib/client.js 的真实渲染。
 *
 * 不手画 mockup、不靠 DOM 断言交差：页面里跑的就是插件自己的客户端 bundle，
 * 数据来自 tools/preview/server.mjs 里那份真状态机。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const outDir = join(root, 'docs')
const port = Number(process.env.PREVIEW_PORT ?? 3491)
const guestPort = Number(process.env.PREVIEW_GUEST_PORT ?? port + 1)
const cdpPort = Number(process.env.PREVIEW_CDP_PORT ?? 9333)

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((path) => path && existsSync(path))

if (!CHROME) throw new Error('找不到 Chrome 可执行文件')

// 一张截图可以带多条断言：面板那张既要验「看了就算已读」，也要验「agent 的职责能改」。
const wants = (shot, name) => (Array.isArray(shot.verify) ? shot.verify.includes(name) : shot.verify === name)

const shots = [
  {
    name: 'panel',
    view: 'panel',
    waitFor: '.cr-msg',
    verify: ['panel-read', 'agent-edit'],
    caption: '房间面板：房间列表 / 群聊 / 成员与规则入口；从 LAN 加入的人和他的 agent 带远程 chip',
  },
  {
    name: 'agent-edit',
    view: 'panel',
    waitFor: '.cr-msg',
    open: '改',
    caption: 'agent 的名字与职责随时可改：职责决定它怎么说话，所以建完之后还得能接着改',
  },
  {
    name: 'invite',
    view: 'panel',
    waitFor: '.cr-msg',
    open: '邀请',
    verify: ['invite-address', 'name-edit'],
    caption: '邀请另一台机器：局域网地址 + 房间码就是全部凭据；装 WSL/Hyper-V 的机器把真实网卡排前面，其余的列在下面并标出虚拟网卡',
  },
  {
    name: 'join-error',
    view: 'panel',
    waitFor: '.cr-msg',
    before: 'join-fail',
    verify: 'join-error',
    caption: '加入失败时：直说连不上哪台、填过的地址和房间码留着能改；失败的加入不会在列表里留下半间屋子',
  },
  {
    name: 'rules',
    view: 'rules',
    waitFor: '.cr-msg',
    open: '规则',
    caption: '三条发言规则并行开关：被 @ 必回、全员轮次、主持人指派，共用发言预算',
  },
  {
    name: 'guest',
    port: guestPort,
    view: 'panel',
    waitFor: '.cr-msg',
    settle: 'read',
    caption: '同一间屋子，加入那台机器看到的视角：自己的人是本机，宿主的成员标 LAN · 由 <机器名> 主持',
  },
  {
    name: 'float',
    view: 'session',
    waitFor: '.cr-float-pill',
    open: '.cr-float-pill',
    verify: 'float-bounds',
    caption: '会话界面里的独立悬浮窗：标题栏开关、拖动、折叠都在这一个入口',
  },
  {
    name: 'notify',
    view: 'session',
    waitFor: '.cr-float-pill',
    nudge: true,
    waitForAfter: '.cr-toast',
    verify: 'read',
    caption: '新消息提醒：折叠胶囊上的未读数 + 右上角 toast，标题栏前缀同步',
  },
  {
    name: 'three-machines',
    view: 'panel',
    setup: '/preview/third',
    waitFor: '.cr-msg',
    settle: 'read',
    verify: 'three-parties',
    caption: '三台机器同屋：本机 + 两台 LAN 机器各带自己的 agent，成员与消息都按机器名区分',
  },
  {
    name: 'bring-agent',
    view: 'panel',
    setup: '/preview/bring',
    waitFor: '.cr-msg',
    settle: 'read',
    verify: 'bring-agent',
    caption: '加入之后才建的 agent：那台机器把名单报上来，宿主这边立刻多一个人，@ 它还能跨机跑一轮',
  },
  {
    name: 'old-peer',
    view: 'panel',
    setup: '/preview/old-peer',
    waitFor: '.cr-peer',
    settle: 'read',
    verify: 'old-peer',
    caption: '版本不一致：进来的那台是旧版本，界面直说「报不了 agent 名单、重启那台的桌面端」，而不是让人猜',
  },
  {
    name: 'retry',
    view: 'panel',
    setup: '/preview/fail',
    waitFor: '.cr-msg-actions',
    settle: 'read',
    verify: 'retry',
    caption: 'agent 没回上来时：占位消息留在房里，底下一个「重试」只重跑它一个，不惊动别人',
  },
  {
    name: 'gone',
    port: guestPort,
    view: 'panel',
    setup: '/preview/dissolve',
    waitFor: 'textarea[disabled]',
    caption: '宿主解散后加入方看到的样子：历史还在、输入锁住、右栏写下原因并只留「从列表移除」',
  },
  {
    name: 'no-reply',
    view: 'panel',
    setup: '/preview/no-reply',
    waitFor: '.cr-hint',
    verify: 'no-reply',
    caption: '说了一句、谁都没接的时候：界面直接说是「没叫到人」，而不是让人对着一片安静以为插件坏了',
  },
  {
    name: 'history',
    view: 'panel',
    setup: '/preview/history',
    waitFor: '.cr-older-btn',
    before: 'history-top',
    verify: 'history',
    caption: '说满 200 句之后：更早的话还能一句一句翻回来，而不是只剩一句「只显示最近 200 条」',
  },
  {
    name: 'history-live',
    view: 'panel',
    setup: '/preview/history-live',
    waitFor: '.cr-older-btn',
    before: 'history-live-top',
    verify: 'history-live',
    caption: '翻着历史时屋里又进来话：出口上写清「几条新的」，人没被拽到底部，投影滑动留下的那道接缝也补上了',
  },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(250)
  }
  throw new Error(`CDP 没有就绪：${url}`)
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

async function waitForSelector(cdp, sessionId, selector, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const count = await evaluate(cdp, sessionId, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
    if (count > 0) return count
    await sleep(100)
  }
  throw new Error(`等不到元素：${selector}`)
}

/** 元素在视口里的位置，连视口大小一起取回来，好判断它是不是跑出去了。 */
async function boundsOf(cdp, sessionId, selector) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        left: Math.round(rect.left), top: Math.round(rect.top),
        right: Math.round(rect.right), bottom: Math.round(rect.bottom),
        width: Math.round(rect.width), height: Math.round(rect.height),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })()`,
  )
}

/**
 * 真的让插件去连一个连不上的地址：「刚占过又放掉」的那个端口号，确定没人监听。
 * 走的是宿主那台真实的 `lan.join`，所以界面上那句报错是真的，不是摆拍出来的。
 *
 * 端口要可复现：取一个固定的候选号（这一屏的文案里就带着这个号，随机会让每次
 * 重跑都得到一张像素不同的图，「只改了别处」也会显得 join-error 全红）。
 * 候选号都被占了才退回系统挑的空闲端口。
 */
const CANDIDATE_PORTS = [4599, 4598, 4597, 4596]
let joinFailRooms = 0
let joinFailTarget = ''

async function closedPort() {
  for (const port of CANDIDATE_PORTS) {
    const probe = createServer()
    const free = await new Promise((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => resolve(true))
    })
    await new Promise((resolve) => probe.close(resolve))
    if (free) return port
  }
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * 从页面里直接走命令通道发几句话进当前屋子。
 *
 * 用的是界面自己那条 `/api/dsh.chatroom/<端点>`（信封、Cookie 都一样），所以宿主真落库、
 * 长轮询真把新投影推回页面 —— 用来把「人翻着历史时屋里又进来话」这个中间态做出来，
 * 而不是往界面里塞假数据。
 */
async function sayInRoom(cdp, sessionId, texts) {
  const answer = await evaluate(
    cdp,
    sessionId,
    `(async () => {
      const call = (method, payload, rpcId) =>
        fetch('/api/dsh.chatroom/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: 'dsh.chatroom/' + method, payload: payload }),
        }).then((res) => res.json())
      const snapshot = await call('snapshot', {}, 'say-snapshot')
      const roomId = snapshot.result.value.activeRoomId
      const lines = ${JSON.stringify(texts)}
      const sent = []
      for (let i = 0; i < lines.length; i += 1) {
        const result = await call('command', { action: 'msg.send', input: { roomId: roomId, text: lines[i], mentions: [], opKey: 'say_' + i } }, 'say-' + i)
        sent.push(result.result && result.result.ok ? 'ok' : JSON.stringify(result.result && result.result.error))
      }
      return { roomId: roomId, sent: sent }
    })()`,
  )
  if (!answer || !answer.roomId) throw new Error('那几句没发进去')
  const failed = answer.sent.find((row) => row !== 'ok')
  if (failed) throw new Error(`发消息被宿主打回来了：${failed}`)
  return answer
}

async function attemptFailingJoin(cdp, sessionId) {
  joinFailTarget = `127.0.0.1:${await closedPort()}`
  joinFailRooms = await evaluate(cdp, sessionId, `document.querySelectorAll('.cr-room').length`)
  const opened = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = [...document.querySelectorAll('.cr-link-btn')].find((node) =>
        node.textContent.includes('加入 LAN 房间'),
      )
      if (!button) return false
      button.click()
      return true
    })()`,
  )
  if (!opened) throw new Error('点不开「+ 加入 LAN 房间」')
  await sleep(200)
  const filled = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const inputs = [...document.querySelectorAll('input.cr-field')]
      const address = inputs.find((node) => String(node.placeholder || '').includes('对方地址'))
      const code = inputs.find((node) => String(node.placeholder || '').includes('房间码'))
      if (!address || !code) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      const put = (el, value) => {
        el.focus()
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      put(address, ${JSON.stringify(joinFailTarget)})
      put(code, 'ZZZZZZ')
      return true
    })()`,
  )
  if (!filled) throw new Error('填不进加入表单')
  const submitted = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = [...document.querySelectorAll('button.cr-primary')].find(
        (node) => node.textContent.trim() === '加入',
      )
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`,
  )
  if (!submitted) throw new Error('「加入」点不动（要么没找到，要么还是禁用的）')
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(cdp, sessionId, `Boolean(document.querySelector('.cr-error-bar'))`)) return
    await sleep(100)
  }
  throw new Error('加入失败了，界面却没有报错')
}

function assertInside(box, message) {
  if (!box) throw new Error(`${message}：找不到元素`)
  const outside =
    box.left < 0 || box.top < 0 || box.right > box.viewport.width || box.bottom > box.viewport.height
  if (outside) throw new Error(`${message}：${JSON.stringify(box)}`)
}

// 预览服务器里那份状态机是活的：上一轮截图会往里补消息、把屋子解散。
// 拿同一份用过的状态再截一遍，图和断言都会偏，而且看起来还挺像那么回事 —— 所以先确认它是刚起来的。
async function assertFreshServer() {
  let info
  try {
    const response = await fetch(`http://127.0.0.1:${port}/preview/writes`)
    if (!response.ok) throw Object.assign(new Error('stale server'), { stale: true })
    info = await response.json()
  } catch (error) {
    if (error?.stale) throw new Error(`预览服务器是旧版本（没有 /preview/writes）：重启 npm run preview:serve`)
    throw new Error(`预览服务器没起来：先跑 npm run preview:serve（期望端口 ${port}）`)
  }
  if (Number(info.writes) > 0) {
    throw new Error(
      `预览服务器的状态已经被写过 ${info.writes} 次：重启 npm run preview:serve 再截，图才和 docs/ 对得上`,
    )
  }
  return info
}

const fresh = await assertFreshServer()
console.log(`preview server fresh — room code ${fresh.roomCode}, LAN port ${fresh.lanPort}`)

const profileDir = await mkdtemp(join(tmpdir(), 'chatroom-shot-'))
const chrome = spawn(
  CHROME,
  [
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
  ],
  { stdio: 'ignore' },
)

try {
  const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`)
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  await mkdir(outDir, { recursive: true })

  // 调某一屏时可以只跑它：--only=history（多屏用逗号）。整轮验收还是不带参数全跑。
  const only = process.argv
    .filter((row) => row.startsWith('--only='))
    .flatMap((row) => row.slice('--only='.length).split(','))
    .map((row) => row.trim())
    .filter(Boolean)
  const targets = only.length ? shots.filter((shot) => only.includes(shot.name)) : shots
  for (const shot of targets) {
    // 有的状态得先把屋子演进到那一步（例如宿主解散）再截，不能靠假数据摆拍。
    // 这类准备动作作用在宿主那份状态机上，所以固定走宿主端口。
    if (shot.setup) await fetch(`http://127.0.0.1:${port}${shot.setup}`)
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
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${shot.port ?? port}/?view=${shot.view}` }, sessionId)
    await waitForSelector(cdp, sessionId, shot.waitFor)
    if (shot.nudge) {
      await fetch(`http://127.0.0.1:${shot.port ?? port}/preview/nudge`)
      await waitForSelector(cdp, sessionId, shot.waitForAfter)
    }
    if (shot.open) {
      const opened = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const target = ${JSON.stringify(shot.open)}
          const bySelector = target.startsWith('.') ? document.querySelector(target) : null
          const byText = !bySelector && [...document.querySelectorAll('button, [role="button"]')]
            .find((node) => node.textContent.trim() === target)
          const node = bySelector || byText
          if (!node) return false
          node.click()
          return true
        })()`,
      )
      if (!opened) throw new Error(`点不到：${shot.open}`)
      await sleep(350)
    }
    // 有的状态是「用户操作之后才出现」的（例如加入失败），得在拍照之前把它做出来，
    // 否则截图拍的是操作前那张，断言却在操作后跑 —— 图和结论对不上。
    if (shot.before === 'join-fail') await attemptFailingJoin(cdp, sessionId)
    // 翻页入口在列表顶端：先把消息区滚到最上面，截到的才是「列表的起点」。
    if (shot.before === 'history-top') {
      const atTop = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const flow = document.querySelector('.cr-flow')
          if (!flow) return false
          flow.scrollTop = 0
          // 滚到顶上之后，「回到最新」才会出现（scroll 事件异步派发，这里补一次，
          // 免得拍出来的图里没这个出口、断言却在断言它）。
          flow.dispatchEvent(new Event('scroll'))
          return true
        })()`,
      )
      if (!atTop) throw new Error('找不到消息区，滚不到顶部')
      await sleep(200)
    }
    // 「翻着历史时来了新消息」那一屏：先翻出一整段历史、滚到顶上（人停在上面读），
    // 再让屋里真的进来两句 —— 拍的是「新消息已经进来、人还没动」的那一刻，不是操作前的样子。
    if (shot.before === 'history-live-top') {
      await evaluate(cdp, sessionId, `document.querySelector('.cr-older-btn').click()`)
      let paged = 0
      for (let i = 0; i < 80; i += 1) {
        paged = await evaluate(cdp, sessionId, `document.querySelectorAll('.cr-msg').length`)
        if (paged >= 240) break
        await sleep(100)
      }
      if (paged < 240) throw new Error(`翻不出一整段历史：${paged} 条`)
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const flow = document.querySelector('.cr-flow')
          if (!flow) return false
          flow.scrollTop = 0
          flow.dispatchEvent(new Event('scroll'))
          return true
        })()`,
      )
      await sleep(200)
      await sayInRoom(cdp, sessionId, ['这两句是翻着历史时进来的', '第二句也一样'])
      let label = null
      for (let i = 0; i < 80; i += 1) {
        label = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const node = document.querySelector('.cr-jump')
            return {
              text: node ? String(node.textContent).trim() : null,
              rows: document.querySelectorAll('.cr-msg').length,
            }
          })()`,
        )
        if (label && label.rows === 242 && /条新的/.test(label.text || '')) break
        await sleep(100)
      }
      if (!label || label.rows !== 242 || !/2 条新的/.test(label.text || '')) {
        throw new Error(`拍之前那个状态没做出来：${JSON.stringify(label)}`)
      }
      await sleep(250)
    }
    // 截图要截「稳定下来的界面」，不是「刚好路过的中间态」：三台机器那张图里，
    // 远程 agent 的回复会在页面加载之后才落库，未读徽标会在面板可见的情况下
    // 自动清零 —— 等它清完再拍，否则同一份代码两次会拍出带徽标和不带徽标两张。
    if (shot.settle === 'read') {
      for (let i = 0; i < 40; i += 1) {
        const left = await evaluate(
          cdp,
          sessionId,
          `document.querySelectorAll('.cr-badge, .cr-nav-badge').length`,
        )
        if (left === 0) break
        await sleep(100)
      }
    }
    await sleep(250)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const file = join(outDir, `${shot.name}.png`)
    await writeFile(file, Buffer.from(data, 'base64'))
    console.log(`saved ${file} — ${shot.caption}`)

    // 反面：面板就摆在眼前时，新消息应该直接算已读（用户已经看到了）。
    // 和上面那条一起，才说明「该提醒时提醒、看过了就消」两半都在。
    if (wants(shot, 'panel-read')) {
      await fetch(`http://127.0.0.1:${shot.port ?? port}/preview/nudge`)
      let cleared = false
      for (let i = 0; i < 40; i += 1) {
        const state = await evaluate(
          cdp,
          sessionId,
          `({ badges: document.querySelectorAll('.cr-badge, .cr-nav-badge').length, title: document.title })`,
        )
        if (state.badges === 0 && !String(state.title).startsWith('(')) {
          cleared = true
          break
        }
        await sleep(100)
      }
      if (!cleared) throw new Error('面板可见时新消息没有自动算已读')
      console.log('verified — 面板可见时新消息直接算已读（未读不会涨）')
    }

    // 加入失败：这是第二台机器的人最可能撞上的状态（地址写错、那台没开、码不对）。
    // 界面必须说人话、把填过的内容留着，而且不能在列表里留下半间屋子让人以为进去了。
    if (wants(shot, 'join-error')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          return {
            error: text(document.querySelector('.cr-error-bar')),
            inputs: [...document.querySelectorAll('input.cr-field')].map((node) => node.value),
            rooms: document.querySelectorAll('.cr-room').length,
            joinButton: [...document.querySelectorAll('button.cr-primary')].some(
              (node) => node.textContent.trim() === '加入',
            ),
          }
        })()`,
      )
      if (!/连不上/.test(state.error)) throw new Error(`报错没说清是连不上：${JSON.stringify(state.error)}`)
      if (!state.error.includes(joinFailTarget)) {
        throw new Error(`报错里没有对方地址（${joinFailTarget}），用户不知道该改哪：${JSON.stringify(state.error)}`)
      }
      // 「（fetch failed）」这种底层消息对用户等于没说：原因得翻成人话。
      if (/fetch failed|ECONNREFUSED|lan_unreachable|rpc_failed|Error:/.test(state.error)) {
        throw new Error(`报错里漏了内部错误码，人看不懂：${JSON.stringify(state.error)}`)
      }
      if (!/没在监听这个端口|连接超时|网络到不了|地址查不到|连接被对面断掉/.test(state.error)) {
        throw new Error(`报错没说清是哪一类原因：${JSON.stringify(state.error)}`)
      }
      if (!state.inputs.includes(joinFailTarget) || !state.inputs.includes('ZZZZZZ')) {
        throw new Error(`填过的地址/房间码被清掉了，得从零再敲一遍：${JSON.stringify(state.inputs)}`)
      }
      if (!state.joinButton) throw new Error('加入失败后表单自己收起来了')
      if (state.rooms !== joinFailRooms) {
        throw new Error(`加入失败却在房间列表里留下了屋子：${joinFailRooms} → ${state.rooms}`)
      }
      console.log(`verified — 加入失败：「${state.error}」，地址与码都还在，房间列表没变`)
    }

    // agent 的职责决定它怎么说话，所以它必须能改，而且要改得掉、改得回来。
    // 这条走真实渲染 + 真实命令：点成员行的「改」→ 表单原地展开 → 改职责 → 保存 →
    // 成员列上的职责当场换掉；再改回原值，别把后面的截图带脏。
    if (wants(shot, 'agent-edit')) {
      const roleOf = (name) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const row = [...document.querySelectorAll('.cr-member')]
              .find((el) => (el.querySelector('.cr-member-name') || {}).textContent === ${JSON.stringify(name)})
            if (!row) return null
            const role = row.querySelector('.cr-member-role')
            return role ? role.textContent : null
          })()`,
        )
      const openEditor = (name) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const row = [...document.querySelectorAll('.cr-member')]
              .find((el) => (el.querySelector('.cr-member-name') || {}).textContent === ${JSON.stringify(name)})
            if (!row) return false
            const button = [...row.querySelectorAll('.cr-icon-btn')].find((el) => el.textContent.trim() === '改')
            if (!button) return false
            button.click()
            return true
          })()`,
        )
      const setRole = (value) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const input = [...document.querySelectorAll('.cr-agent-form input')]
              .find((el) => (el.getAttribute('aria-label') || '').startsWith('职责'))
            if (!input) return false
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(input, ${JSON.stringify(value)})
            input.dispatchEvent(new Event('input', { bubbles: true }))
            const save = [...document.querySelectorAll('.cr-agent-form button')].find((el) => el.textContent.trim() === '保存')
            if (!save) return false
            save.click()
            return true
          })()`,
        )
      const waitRole = async (name, expected) => {
        for (let i = 0; i < 60; i += 1) {
          if ((await roleOf(name)) === expected) return true
          await sleep(100)
        }
        return false
      }

      const original = await roleOf('账期 agent')
      if (!original) throw new Error('成员列里找不到「账期 agent」，这条断言没法成立')
      if (!(await openEditor('账期 agent'))) throw new Error('点不开 agent 的「改」')
      const changed = '盯 45 天账期、返点与对账单'
      if (!(await setRole(changed))) throw new Error('agent 表单里改不了职责')
      if (!(await waitRole('账期 agent', changed))) {
        throw new Error(`改完职责成员列没跟着换：${await roleOf('账期 agent')}`)
      }
      if (!(await openEditor('账期 agent'))) throw new Error('第二次点不开 agent 的「改」')
      if (!(await setRole(original))) throw new Error('agent 表单里改不回原职责')
      if (!(await waitRole('账期 agent', original))) {
        throw new Error(`职责没改回去，后面的截图会带着脏状态：${await roleOf('账期 agent')}`)
      }
      console.log('verified — agent 的职责可改：表单原地展开，成员列当场换，再改回来')
    }

    // 名字是身份的一部分：输入框里必须是坐在键盘前的这个人，改完要真的落到宿主
    // （成员列换成新名字），再改回去，别把后面的截图带脏。
    // 断言只认成员列，不认输入框：输入框里还有你正在打的草稿，看它等于什么都没证明。
    if (wants(shot, 'name-edit')) {
      const memberNames = () =>
        evaluate(
          cdp,
          sessionId,
          `Array.from(document.querySelectorAll('.cr-member-name')).map((el) => el.textContent)`,
        )
      const readName = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const el = document.querySelector('.cr-name-row input')
            return el ? el.value : null
          })()`,
        )
      const typeName = (value) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const el = document.querySelector('.cr-name-row input')
            if (!el) return false
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            el.focus()
            setter.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.blur()
            return true
          })()`,
        )
      const waitForMember = async (label, gone) => {
        for (let i = 0; i < 60; i += 1) {
          const seen = await memberNames()
          if (seen.includes(label) && !seen.includes(gone)) return true
          await sleep(100)
        }
        return false
      }

      const before = await readName()
      if (before !== '林岸') throw new Error(`名字输入框里应该是本机这个人的名字，实际是 ${JSON.stringify(before)}`)

      await typeName('林岸·改')
      if (!(await waitForMember('林岸·改', '林岸'))) {
        throw new Error(`改完名字没落到宿主，成员列是 ${JSON.stringify(await memberNames())}`)
      }
      // 等成员列先变，再改回去：提交时比的是「和当前名字一样就不发请求」，
      // 拿着旧快照去改会正好撞上这条。
      await typeName('林岸')
      if (!(await waitForMember('林岸', '林岸·改'))) {
        throw new Error(`名字没改回去，后面的截图会带着脏状态：${JSON.stringify(await memberNames())}`)
      }
      if ((await readName()) !== '林岸') throw new Error('改完之后输入框没有回到当前名字')
      console.log('verified — 名字可改：成员列当场换名字，再改回来')
    }

    // 邀请条上那句地址是对方唯一要抄的东西，得和宿主此刻的真实网卡排出来的一致：
    // 虚拟网卡不能占着第一个（本机能通、隔壁那台永远超时），其余的必须列出来并标明。
    if (wants(shot, 'invite-address')) {
      const truth = await (await fetch(`http://127.0.0.1:${port}/preview/lan`)).json()
      const shown = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const row = document.querySelector('.cr-invite .cr-invite-row code')
          const notes = [...document.querySelectorAll('.cr-invite .cr-invite-note')].map((node) => String(node.textContent).trim())
          return { address: row ? String(row.textContent).trim() : '', notes }
        })()`,
      )
      if (!/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(shown.address)) {
        throw new Error(`邀请条上的地址不成形：${JSON.stringify(shown.address)}`)
      }
      const shownHost = shown.address.split(':')[0]
      const candidates = truth.addresses ?? []
      const real = candidates.filter((row) => !row.virtual)
      if (real.length && shownHost !== real[0].address) {
        throw new Error(`邀请条递出去的是 ${shownHost}，而能连上的第一个是 ${real[0].address}`)
      }
      for (const row of candidates.filter((item) => item.virtual && item.address !== shownHost)) {
        const listed = shown.notes.find((note) => note.includes(row.address))
        if (!listed) throw new Error(`虚拟网卡地址没列出来，人只能自己去猜：${row.address} / ${JSON.stringify(shown.notes)}`)
        if (!/虚拟/.test(listed)) throw new Error(`虚拟网卡没被标出来：${listed}`)
      }
      console.log(`verified — 邀请地址递的是能连上的那个（${shownHost}），其余地址列在下面并标出虚拟网卡`)
    }

    // 截图只证明「出现了未读」，还得证明它「会消」：展开浮窗就等于看过了，
    // 徽标和标题前缀都该归零。这条断言跑在真实渲染的页面里，和截图同一份代码。
    if (wants(shot, 'read')) {
      // 先确认「该有未读」：没有未读的截图证明不了提醒链路，后一步的清零也就成了空跑。
      const before = await evaluate(
        cdp,
        sessionId,
        `({ badges: document.querySelectorAll('.cr-badge, .cr-nav-badge').length, title: document.title })`,
      )
      if (!(before.badges > 0 || String(before.title).startsWith('('))) {
        throw new Error(`通知没有出现未读：${JSON.stringify(before)}`)
      }
      const opened = await evaluate(cdp, sessionId, `(() => {
        const node = document.querySelector('.cr-float-pill')
        if (!node) return false
        node.click()
        return true
      })()`)
      if (!opened) throw new Error('点不开浮窗，读不到已读路径')
      let cleared = false
      for (let i = 0; i < 60; i += 1) {
        const left = await evaluate(
          cdp,
          sessionId,
          `document.querySelectorAll('.cr-badge, .cr-nav-badge').length`,
        )
        const title = await evaluate(cdp, sessionId, 'document.title')
        if (left === 0 && !String(title).startsWith('(')) {
          cleared = true
          break
        }
        await sleep(100)
      }
      if (!cleared) throw new Error('展开浮窗后未读没有清零')
      console.log('verified — 展开浮窗后未读归零（徽标与标题前缀都落回去）')
    }
    // 三台机器同屋：两台远程机器不能都只显示一个「LAN」——
    // 认不出是哪台机器，用户就会把两台机器的人和 agent 搞混。这条断言跑在真实渲染的页面上。
    if (wants(shot, 'three-parties')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          const rows = [...document.querySelectorAll('.cr-msg')].map((row) => ({
            name: text(row.querySelector('.cr-msg-name')).replace(/（.*?）/g, '').trim(),
            chip: text(row.querySelector('.cr-msg-meta .cr-chip.cr-lan')),
          }))
          const members = [...document.querySelectorAll('.cr-member-name')].map(text)
          return { rows, members }
        })()`,
      )
      const wantMembers = ['林岸', '账期 agent', '退货 agent', '周荻', '尾货 agent', '陈默', '库存 agent']
      const missing = wantMembers.filter((name) => !state.members.includes(name))
      if (missing.length) throw new Error(`成员列少了：${missing.join('、')}（实际 ${state.members.join('、')}）`)

      const byMachine = {
        '周荻的 MacBook': ['周荻', '尾货 agent'],
        '陈默的 ThinkPad': ['陈默', '库存 agent'],
      }
      for (const [machine, authors] of Object.entries(byMachine)) {
        for (const author of authors) {
          const row = state.rows.find((item) => item.name === author)
          if (!row) throw new Error(`消息行里没有 ${author} 的发言，这条验不了跨机器来源`)
          if (!row.chip.includes(machine)) {
            throw new Error(`${author} 的消息没有标出它来自「${machine}」，实际 chip：${JSON.stringify(row.chip)}`)
          }
        }
      }
      // 本机的成员不能被贴 LAN 标签（三台机器时最容易把自家的也标成远程）。
      for (const author of ['林岸', '账期 agent', '退货 agent']) {
        const row = state.rows.find((item) => item.name === author)
        if (row && row.chip) throw new Error(`本机成员 ${author} 被标成了 LAN：${JSON.stringify(row.chip)}`)
      }
      const machines = new Set(state.rows.map((row) => row.chip).filter(Boolean))
      if (machines.size < 2) throw new Error(`两台远程机器没有区分开：${JSON.stringify([...machines])}`)
      console.log(`verified — 三台机器同屋：${wantMembers.length} 个成员、两台远程机器各标自己的机器名`)
    }
    // 「agent 怎么进来」：加入那一刻只带得走本机**已有的** agent，新机器上一个都没有。
    // 这一屏要证明补报那条路是通的：那台机器建完 agent，我这边成员列立刻多一个人、
    // 认得出是哪台机器的、而且 @ 它真的把这一轮派回去跑；左栏「我的 agent」能建能删。
    if (wants(shot, 'bring-agent')) {
      const read = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const text = (node) => (node ? String(node.textContent).trim() : '')
            const members = [...document.querySelectorAll('.cr-member')].map((row) => {
              const chip = row.querySelector('.cr-chip.cr-lan')
              return {
                name: text(row.querySelector('.cr-member-name')),
                lan: Boolean(chip),
                title: chip ? String(chip.getAttribute('title') || '') : '',
              }
            })
            const rows = [...document.querySelectorAll('.cr-msg')].map((row) => ({
              name: text(row.querySelector('.cr-msg-name')).replace(/（.*?）/g, '').trim(),
              chip: text(row.querySelector('.cr-msg-meta .cr-chip.cr-lan')),
            }))
            const chips = [...document.querySelectorAll('.cr-agent-chip .cr-agent-name')].map(text)
            return { members, rows, chips }
          })()`,
        )
      const find = (state, name) => state.members.find((row) => row.name === name)

      const state = await read()
      for (const name of ['陈默', '库存 agent']) {
        const row = find(state, name)
        if (!row) throw new Error(`成员列里没有「${name}」：${JSON.stringify(state.members.map((item) => item.name))}`)
        if (!row.lan) throw new Error(`「${name}」是别的机器上的，却没标 LAN`)
      }
      if (!/陈默的 ThinkPad/.test(find(state, '库存 agent').title)) {
        throw new Error(`认不出「库存 agent」是哪台机器带的：${JSON.stringify(find(state, '库存 agent').title)}`)
      }
      if (find(state, '林岸') && find(state, '林岸').lan) throw new Error('本机的人被贴成了 LAN')
      const reply = state.rows.find((row) => row.name === '库存 agent')
      if (!reply) throw new Error('消息里没有「库存 agent」的回复，这一轮没派回那台机器')
      if (!/陈默的 ThinkPad/.test(reply.chip)) throw new Error(`回复的来源没标出机器：${JSON.stringify(reply.chip)}`)

      // 左栏「我的 agent」：自己带的 agent 都在这儿，而且能建、能删。
      for (const name of ['账期 agent', '退货 agent']) {
        if (!state.chips.includes(name)) throw new Error(`「我的 agent」里少了 ${name}：${JSON.stringify(state.chips)}`)
      }
      const opened = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = [...document.querySelectorAll('.cr-col-foot .cr-link-btn')].find((node) =>
            node.textContent.includes('新建一个 agent'),
          )
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      if (!opened) throw new Error('点不开「我的 agent」里的新建入口')
      const filled = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const inputs = [...document.querySelectorAll('.cr-my-form input')]
          if (inputs.length < 2) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          const put = (el, value) => {
            el.focus()
            setter.call(el, value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          put(inputs[0], '临时 agent')
          put(inputs[1], '断言建的，建完就删')
          return true
        })()`,
      )
      if (!filled) throw new Error('「我的 agent」的表单没展开出名字与职责两栏')
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = [...document.querySelectorAll('.cr-my-form button')].find((node) => node.textContent.trim() === '保存')
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      let created = null
      for (let i = 0; i < 60; i += 1) {
        created = await read()
        if (created.chips.includes('临时 agent') && find(created, '临时 agent')) break
        await sleep(100)
      }
      if (!created.chips.includes('临时 agent')) {
        throw new Error(`建完的 agent 没进「我的 agent」：${JSON.stringify(created.chips)}`)
      }
      if (!find(created, '临时 agent')) throw new Error('建完的 agent 没进这间屋子')

      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const chip = [...document.querySelectorAll('.cr-agent-chip')].find((row) =>
            String(row.textContent).includes('临时 agent'),
          )
          const button = chip && chip.querySelector('.cr-agent-x')
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      let removed = null
      for (let i = 0; i < 60; i += 1) {
        removed = await read()
        if (!removed.chips.includes('临时 agent') && !find(removed, '临时 agent')) break
        await sleep(100)
      }
      if (removed.chips.includes('临时 agent') || find(removed, '临时 agent')) {
        throw new Error('删掉的 agent 还留在「我的 agent」或成员列里')
      }
      // 这一屏专开的演示例房间收掉：后面的截图不该带着上一屏的故事。
      await fetch(`http://127.0.0.1:${port}/preview/tidy`)
      console.log('verified — 空手加入的机器补建 agent：成员列当场多一个 LAN·陈默的 ThinkPad，@ 它能跑一轮；左栏能建能删')
    }
    // 两台机器的插件版本不一样：老机器报不了 agent 名单，界面必须说清是哪台、该做什么。
    // 「每台机器带了谁」是宿主这边唯一的反馈回路 —— 少了它，用户只能看到 agent 没进来。
    if (wants(shot, 'old-peer')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          return {
            peers: [...document.querySelectorAll('.cr-peer')].map((row) => ({
              machine: text(row.querySelector('.cr-peer-machine')),
              state: text(row.querySelector('.cr-peer-state, .cr-warn')),
              old: Boolean(row.querySelector('.cr-warn')),
            })),
            members: [...document.querySelectorAll('.cr-member-name')].map(text),
          }
        })()`,
      )
      const peer = state.peers.find((row) => row.machine === '阿青的 Surface')
      if (!peer) throw new Error(`没有列出那台机器：${JSON.stringify(state.peers)}`)
      if (!peer.old) throw new Error('旧版本那台没被标出来：界面会让人以为「它只是还没建 agent」')
      if (!/旧版本/.test(peer.state)) throw new Error(`提示没说清是版本问题：${JSON.stringify(peer.state)}`)
      if (!/重启/.test(peer.state)) throw new Error(`提示没给出该做的事：${JSON.stringify(peer.state)}`)
      if (!state.members.includes('阿青')) throw new Error(`屋里应该有这个人：${JSON.stringify(state.members)}`)
      if (state.members.some((name) => /agent/.test(name) && !/账期|退货/.test(name))) {
        throw new Error(`旧版本那台不可能带着 agent 成员：${JSON.stringify(state.members)}`)
      }
      await fetch(`http://127.0.0.1:${port}/preview/tidy`)
      console.log('verified — 版本不一致：列出「阿青的 Surface · 旧版本，报不了 agent 名单 —— 重启那台的桌面端」')
    }
    // 浮窗既然能拖到任何地方，就得证明它拖不丢：记住的坐标要真的用上、越界的坐标要夹回、
    // 拖到屏幕外要夹住、窗口变窄以后还得在视口里。四条都跑在真实渲染的页面里。
    if (wants(shot, 'float-bounds')) {
      const openCard = async () => {
        await waitForSelector(cdp, sessionId, '.cr-float-pill')
        await evaluate(cdp, sessionId, `(() => {
          const node = document.querySelector('.cr-float-pill')
          if (!node) return false
          node.click()
          return true
        })()`)
        await waitForSelector(cdp, sessionId, '.cr-float-card')
      }

      // 1. 记住的位置要真的被用上 —— 存到一个跟默认角落明显不同的地方再重开页面。
      await evaluate(
        cdp,
        sessionId,
        `localStorage.setItem('dsh-chatroom:float-pos:v1', JSON.stringify({ x: 100, y: 120 }))`,
      )
      await cdp.send('Page.reload', {}, sessionId)
      await openCard()
      const remembered = await boundsOf(cdp, sessionId, '.cr-float-card')
      if (!remembered || Math.abs(remembered.left - 100) > 2 || Math.abs(remembered.top - 120) > 2) {
        throw new Error(`重开页面后没有回到记住的位置：${JSON.stringify(remembered)}`)
      }

      // 2. 存的坐标在屏幕外（上次窗口更大时拖出去的）时，要夹回视口。
      await evaluate(
        cdp,
        sessionId,
        `localStorage.setItem('dsh-chatroom:float-pos:v1', JSON.stringify({ x: 99999, y: 99999 }))`,
      )
      await cdp.send('Page.reload', {}, sessionId)
      await openCard()
      assertInside(await boundsOf(cdp, sessionId, '.cr-float-card'), '存下来的越界坐标没有夹回视口')

      // 3. 拖到屏幕外：松手以后就再也没有第二个抓手了，必须在拖动过程中就夹住。
      const dragged = await evaluate(cdp, sessionId, `(() => {
        const head = document.querySelector('.cr-float-head')
        if (!head) return false
        const box = head.getBoundingClientRect()
        const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        head.dispatchEvent(new PointerEvent('pointerdown', at(box.left + 16, box.top + 8)))
        window.dispatchEvent(new PointerEvent('pointermove', at(9999, 9999)))
        window.dispatchEvent(new PointerEvent('pointerup', at(9999, 9999)))
        return true
      })()`)
      if (!dragged) throw new Error('抓不到浮窗标题栏，拖动这条验不了')
      await sleep(200)
      assertInside(await boundsOf(cdp, sessionId, '.cr-float-card'), '拖到屏幕外没有被夹住')

      // 4. 窗口被拖窄：记住的坐标不变，但浮窗得留在看得见的地方。
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1024, height: 700, deviceScaleFactor: 2, mobile: false },
        sessionId,
      )
      await sleep(300)
      assertInside(await boundsOf(cdp, sessionId, '.cr-float-card'), '窗口变窄后浮窗跑到视口外')
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        sessionId,
      )
      await sleep(300)

      // 5. 收起成胶囊以后那颗胶囊也得能拖。收起态是另一个 DOM（.cr-float-pill），
      //    拖动监听要是跟着 floatOpen 一起关掉，这里就一步也拖不动。
      await evaluate(cdp, sessionId, `(() => {
        const close = document.querySelector('.cr-float-head .cr-icon-btn')
        if (!close) return false
        close.click()
        return true
      })()`)
      await waitForSelector(cdp, sessionId, '.cr-float-pill')
      const pillDrag = await evaluate(cdp, sessionId, `(() => {
        const pill = document.querySelector('.cr-float-pill')
        if (!pill) return 'no-pill'
        const box = pill.getBoundingClientRect()
        const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 })
        // 只抖 2px 不能算拖：那一下松手要按点击处理，点一下才是展开。
        const wobble = { x: box.left + 20, y: box.top + 16 }
        pill.dispatchEvent(new PointerEvent('pointerdown', at(wobble.x, wobble.y)))
        window.dispatchEvent(new PointerEvent('pointermove', at(wobble.x + 2, wobble.y + 2)))
        window.dispatchEvent(new PointerEvent('pointerup', at(wobble.x + 2, wobble.y + 2)))
        if (document.querySelector('.cr-float-card')) return 'wobble-opened'
        const held = pill.getBoundingClientRect()
        if (Math.abs(held.left - box.left) > 1 || Math.abs(held.top - box.top) > 1) return 'wobble-moved'
        // 真正的拖动：抓住胶囊拖到 (320, 300)，抓手偏移是 (20, 16)。
        pill.dispatchEvent(new PointerEvent('pointerdown', at(held.left + 20, held.top + 16)))
        window.dispatchEvent(new PointerEvent('pointermove', at(held.left + 24, held.top + 20)))
        window.dispatchEvent(new PointerEvent('pointermove', at(320, 300)))
        window.dispatchEvent(new PointerEvent('pointerup', at(320, 300)))
        return 'ok'
      })()`)
      if (pillDrag !== 'ok') throw new Error(`收起态的胶囊拖不动：${pillDrag}`)
      await sleep(250)
      const pillBox = await boundsOf(cdp, sessionId, '.cr-float-pill')
      if (!pillBox) throw new Error('拖完以后找不到胶囊')
      if (Math.abs(pillBox.left - 300) > 2 || Math.abs(pillBox.top - 284) > 2) {
        throw new Error(`胶囊没有跟着手指走：${JSON.stringify(pillBox)}`)
      }
      assertInside(pillBox, '胶囊被拖到视口外')
      const savedPill = JSON.parse(
        (await evaluate(cdp, sessionId, `localStorage.getItem('dsh-chatroom:float-pos:v1')`)) || 'null',
      )
      if (!savedPill || Math.abs(savedPill.x - 300) > 2 || Math.abs(savedPill.y - 284) > 2) {
        throw new Error(`胶囊的位置没有存下来：${JSON.stringify(savedPill)}`)
      }
      // 从拖过去的胶囊展开：窗口要开在原地，不能跳回右下角。
      await evaluate(cdp, sessionId, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, sessionId, '.cr-float-card')
      const openedAt = await boundsOf(cdp, sessionId, '.cr-float-card')
      if (!openedAt || Math.abs(openedAt.left - 300) > 2 || Math.abs(openedAt.top - 284) > 2) {
        throw new Error(`从拖过去的胶囊展开后没留在原地：${JSON.stringify(openedAt)}`)
      }

      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        sessionId,
      )
      await evaluate(cdp, sessionId, `localStorage.removeItem('dsh-chatroom:float-pos:v1')`)
      console.log('verified — 位置记得住、越界夹回、拖动不出界、窗口变窄仍在视口内、收起成胶囊也拖得动')
    }

    // 「没回上来」不能只是一行灰字：得有入口把那一个 agent 单独重跑一次。
    // 这条走真实渲染 + 真实命令：点「重试」→ 客户端发 msg.retry → 宿主只重跑它一个 → 回复落库。
    if (wants(shot, 'retry')) {
      const before = await evaluate(cdp, sessionId, `(() => {
        const rows = [...document.querySelectorAll('.cr-msg')]
        const failed = rows.find((row) => row.classList.contains('cr-error'))
        if (!failed) return null
        const buttons = [...failed.querySelectorAll('.cr-msg-actions button')]
        return {
          count: rows.length,
          text: failed.querySelector('.cr-msg-text').textContent,
          buttons: buttons.length,
          label: buttons[0] ? buttons[0].textContent.trim() : null,
          disabled: buttons[0] ? buttons[0].disabled : null,
        }
      })()`)
      if (!before) throw new Error('这一屏里没有「没回上来」那条')
      if (!/没回上来/.test(before.text)) throw new Error(`失败占位的内容不对：${before.text}`)
      if (before.buttons !== 1) throw new Error(`失败那条该正好一个重试按钮，实际 ${before.buttons} 个`)
      if (before.label !== '重试') throw new Error(`重试按钮的文字不对：${before.label}`)
      if (before.disabled) throw new Error('这一轮已经结束了，重试按钮不该是禁用的')

      // 同一份状态在会话界面里再开一页：浮窗本来会把失败消息过滤掉（只留最近六条），
      // 这条要证明「失败不会被折叠掉」，并且浮窗里那个「重试」真的点得动。
      const { targetId: floatTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: floatSession } = await cdp.send('Target.attachToTarget', { targetId: floatTarget, flatten: true })
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        floatSession,
      )
      await cdp.send('Page.enable', {}, floatSession)
      await cdp.send('Runtime.enable', {}, floatSession)
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?view=session` }, floatSession)
      await waitForSelector(cdp, floatSession, '.cr-float-pill')
      await evaluate(cdp, floatSession, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, floatSession, '.cr-float-failed')
      const inFloat = await evaluate(cdp, floatSession, `(() => {
        const row = document.querySelector('.cr-float-failed')
        const buttons = [...row.querySelectorAll('button')]
        return {
          text: row.textContent,
          buttons: buttons.length,
          label: buttons[0] ? buttons[0].textContent.trim() : null,
        }
      })()`)
      if (!/没回上来/.test(inFloat.text)) throw new Error(`浮窗里没显示失败：${inFloat.text}`)
      if (inFloat.buttons !== 1 || inFloat.label !== '重试') {
        throw new Error(`浮窗里的重试入口不对：${JSON.stringify(inFloat)}`)
      }
      await evaluate(cdp, floatSession, `document.querySelector('.cr-float-failed button').click()`)
      let floated = null
      for (let i = 0; i < 60; i += 1) {
        floated = await evaluate(cdp, floatSession, `(() => {
          const rows = [...document.querySelectorAll('.cr-float-msg')]
          const last = rows[rows.length - 1]
          return {
            failed: document.querySelectorAll('.cr-float-failed').length,
            lastText: last ? last.textContent : '',
          }
        })()`)
        if (floated.failed === 0 && /缺口 82 万/.test(floated.lastText)) break
        await sleep(100)
      }
      await cdp.send('Target.closeTarget', { targetId: floatTarget })
      if (floated.failed !== 0) throw new Error('重试成功后浮窗里还挂着那条失败')
      if (!/缺口 82 万/.test(floated.lastText)) throw new Error(`浮窗里没等到重试的回复：${floated.lastText}`)

      // 回到面板这一页：同一间屋子里的新回复也得跟着长出来（不是只在浮窗里）。
      let after = null
      for (let i = 0; i < 60; i += 1) {
        after = await evaluate(cdp, sessionId, `(() => {
          const rows = [...document.querySelectorAll('.cr-msg')]
          const last = rows[rows.length - 1]
          return {
            count: rows.length,
            lastText: last ? last.querySelector('.cr-msg-text').textContent : '',
            errorRows: rows.filter((row) => row.classList.contains('cr-error')).length,
          }
        })()`)
        if (after.count > before.count && !/没回上来/.test(after.lastText)) break
        await sleep(100)
      }
      if (after.count <= before.count) throw new Error('重试以后面板里没有新消息进来')
      if (after.errorRows !== 1) throw new Error(`失败占位不该被抹掉或翻倍：${after.errorRows} 条`)
      if (!/缺口 82 万/.test(after.lastText)) throw new Error(`重试后落库的不是那个 agent 的话：${after.lastText}`)
      console.log('verified — 失败留占位，点重试只重跑那一个 agent，回复接在后面（面板与浮窗都验过）')
    }

    // 说了一句、谁都没接：默认只有「被 @ 才回」，新用户第一句话就是这个处境。
    // 界面必须当场说清「没叫到人、怎么写才叫到」；而一旦真点到名，agent 接上话，
    // 那句解释也得自己消失 —— 否则它就变成永远挂着的噪音。
    if (wants(shot, 'no-reply')) {
      const said = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const rows = [...document.querySelectorAll('.cr-msg')]
          const hint = document.querySelector('.cr-hint')
          return {
            hint: hint ? String(hint.textContent).trim() : null,
            rows: rows.length,
            lastMine: rows.length ? rows[rows.length - 1].classList.contains('cr-mine') : false,
          }
        })()`,
      )
      if (!said.hint) throw new Error('说完一句没人接，界面上一个字都没解释')
      if (!/@/.test(said.hint)) throw new Error(`解释里没告诉人怎么写才能叫到 agent：${said.hint}`)
      if (/undefined|null|NaN/.test(said.hint)) throw new Error(`解释里有没填上的占位：${said.hint}`)
      if (!said.lastMine) throw new Error('这条解释不是挂在我刚说的那句下面')
      console.log(`verified — 没人接话时把原因说出来了：${said.hint}`)

      // 浮窗里也有输入框，也会撞上同一片安静：同一句解释得在那儿也说一遍。
      const { targetId: floatTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: floatSession } = await cdp.send('Target.attachToTarget', {
        targetId: floatTarget,
        flatten: true,
      })
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        floatSession,
      )
      await cdp.send('Page.enable', {}, floatSession)
      await cdp.send('Runtime.enable', {}, floatSession)
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?view=session` }, floatSession)
      await waitForSelector(cdp, floatSession, '.cr-float-pill')
      await evaluate(cdp, floatSession, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, floatSession, '.cr-float-hint')
      const inFloat = await evaluate(
        cdp,
        floatSession,
        `String(document.querySelector('.cr-float-hint').textContent).trim()`,
      )
      await cdp.send('Target.closeTarget', { targetId: floatTarget })
      if (!/@/.test(inFloat)) throw new Error(`浮窗里那句解释不对：${inFloat}`)
      // 浮窗里没有「让全员说一轮」这个按钮，说法就不能照着面板抄。
      if (/全员说一轮/.test(inFloat)) throw new Error(`浮窗里指了一个它点不到的按钮：${inFloat}`)
      console.log(`verified — 浮窗里同样把原因说清楚：${inFloat}`)

      const filled = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const box = document.querySelector('textarea.cr-textarea')
          if (!box) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          box.focus()
          setter.call(box, '@账期 agent 缺口按哪天的账期算的？')
          box.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`,
      )
      if (!filled) throw new Error('填不进输入框')
      await sleep(200)
      const clicked = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = [...document.querySelectorAll('button.cr-primary')].find(
            (node) => node.textContent.trim() === '发送',
          )
          if (!button || button.disabled) return false
          button.click()
          return true
        })()`,
      )
      if (!clicked) throw new Error('点不出那句点名的话')
      let after = null
      for (let i = 0; i < 80; i += 1) {
        after = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const rows = [...document.querySelectorAll('.cr-msg')]
            return {
              rows: rows.length,
              hint: document.querySelectorAll('.cr-hint').length,
              lastText: rows.length ? rows[rows.length - 1].querySelector('.cr-msg-text').textContent : '',
            }
          })()`,
        )
        if (after.rows > said.rows && after.hint === 0) break
        await sleep(100)
      }
      if (after.rows <= said.rows) throw new Error(`点名之后 agent 没有接话：${JSON.stringify(after)}`)
      if (after.hint !== 0) throw new Error('agent 接话之后那句解释还挂着')
      console.log('verified — 点名之后 agent 真接上了，那句解释自己消失')
    }

    // 长房间往回翻：投影只有最近 200 条，更早那 40 句必须真的能翻回来。
    // 这一屏的判据不是「有个按钮」：点下去要真的多出 40 条、第一条变最早那句、
    // 翻到底之后入口自己消失，而且视口没被跳走（用户还在原来那句上）。
    if (wants(shot, 'history')) {
      const readTimeline = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const flow = document.querySelector('.cr-flow')
            const button = document.querySelector('.cr-older-btn')
            const jump = document.querySelector('.cr-jump')
            const rows = [...document.querySelectorAll('.cr-msg')]
            return {
              rows: rows.length,
              button: button ? String(button.textContent).trim() : null,
              jump: jump ? String(jump.textContent).trim() : null,
              gap: flow ? Math.round(flow.scrollHeight - flow.scrollTop - flow.clientHeight) : null,
              first: rows.length ? String(rows[0].querySelector('.cr-msg-text').textContent).trim() : '',
              last: rows.length ? String(rows[rows.length - 1].querySelector('.cr-msg-text').textContent).trim() : '',
              scrollTop: flow ? Math.round(flow.scrollTop) : null,
              error: document.querySelector('.cr-error-bar') ? String(document.querySelector('.cr-error-bar').textContent).trim() : null,
            }
          })()`,
        )
      const before = await readTimeline()
      if (!before.button) throw new Error('长房间没有「加载更早的消息」入口：说过的话翻不回去')
      if (!/加载更早/.test(before.button)) throw new Error(`入口文案不对：${before.button}`)
      if (before.rows !== 200) throw new Error(`投影应该是最近 200 条，实际 ${before.rows}`)
      console.log(`verified — 240 句的屋子只显示最后一屏，顶端有入口：${before.button}`)

      await evaluate(cdp, sessionId, `document.querySelector('.cr-older-btn').click()`)
      let after = null
      for (let i = 0; i < 60; i += 1) {
        after = await readTimeline()
        if (after.rows > before.rows) break
        await sleep(100)
      }
      if (after.error) throw new Error(`翻历史时报错了：${after.error}`)
      if (after.rows !== 240) throw new Error(`翻完应该是 240 条，实际 ${after.rows}`)
      if (after.button) throw new Error('已经翻到最早一条，入口还挂着')
      if (!/11\/01/.test(after.first)) throw new Error(`翻到的不是最早那句：${after.first}`)
      if (!/11\/24/.test(after.last)) throw new Error(`最新那句不该被翻页换掉：${after.last}`)
      if (!(after.scrollTop > 0)) throw new Error('翻完视口被跳回顶部：用户读的那句会掉下去')
      if (!after.jump || !/回到最新/.test(after.jump)) {
        throw new Error(`翻到上头之后没有回到最新的出口：${after.jump}`)
      }
      console.log(`verified — 点一下真翻回最早那 40 句（${after.rows} 条，首句「${after.first}」），入口自己消失`)

      // 往上翻完人停在顶上，最新那句在几百行之外：出口得真把人送回去。
      await evaluate(cdp, sessionId, `document.querySelector('.cr-jump').click()`)
      let back = null
      for (let i = 0; i < 30; i += 1) {
        back = await readTimeline()
        if (back.jump === null) break
        await sleep(100)
      }
      if (back.jump !== null) throw new Error('点了「回到最新」，出口还挂在上面')
      if (!(back.gap <= 2)) throw new Error(`点了「回到最新」却没到底：还差 ${back.gap}px`)
      if (back.rows !== after.rows) throw new Error('回到最新不该丢掉翻出来的历史')
      console.log(`verified — 「回到最新」一步回到这句（离底部 ${back.gap}px，${back.rows} 条仍在）`)

      // 停在上面读历史的时候，屋里又进来话 —— 那两句在屏幕上根本看不见。
      // 出口上必须写清「几条新的」，否则这枚按钮和一直挂着没区别。
      const parkedOk = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const flow = document.querySelector('.cr-flow')
          if (!flow) return false
          flow.scrollTop = 0
          flow.dispatchEvent(new Event('scroll'))
          return true
        })()`,
      )
      if (!parkedOk) throw new Error('滚不回上面')
      let parked = null
      for (let i = 0; i < 40; i += 1) {
        parked = await readTimeline()
        if (parked.jump) break
        await sleep(100)
      }
      if (!parked.jump) throw new Error('停在上面之后没有回到最新的出口')
      if (/条新的/.test(parked.jump)) throw new Error(`还没人说话，出口就报数了：${parked.jump}`)

      // 走页面自己的命令通道（和界面发消息同一条路），宿主真落库、长轮询真推回来。
      const liveRoom = await sayInRoom(cdp, sessionId, ['这两句是翻着历史时进来的', '第二句也一样'])
      let live = null
      for (let i = 0; i < 80; i += 1) {
        live = await readTimeline()
        if (live.rows === parked.rows + 2 && /条新的/.test(live.jump || '')) break
        await sleep(100)
      }
      if (live.rows !== parked.rows + 2) throw new Error(`新来的两句没到界面上：${parked.rows} → ${live.rows}`)
      if (live.last !== '第二句也一样') throw new Error(`最新那句不对：${live.last}`)
      if (!/回到最新 · 2 条新的/.test(live.jump)) throw new Error(`出口没写清几条新的：${live.jump}`)
      if (live.scrollTop !== parked.scrollTop) throw new Error(`来新消息把人拽走了：${parked.scrollTop} → ${live.scrollTop}`)
      console.log(`verified — 停在上头时进来的两句记在出口上：${live.jump}（${live.rows} 条，接缝补上了）`)

      await evaluate(cdp, sessionId, `document.querySelector('.cr-jump').click()`)
      let cleared = null
      for (let i = 0; i < 40; i += 1) {
        cleared = await readTimeline()
        if (cleared.jump === null) break
        await sleep(100)
      }
      if (cleared.jump !== null) throw new Error('点过之后出口还挂着')
      if (!(cleared.gap <= 2)) throw new Error(`点了「回到最新」却没到底：还差 ${cleared.gap}px`)
      console.log(`verified — 点一下回到最新，计数自己消失（离底部 ${cleared.gap}px）`)
    }

    // 「翻着历史时屋里又进来话」这一屏：出口记数、人没被拽走、接缝补上；
    // 点一下回到最新、计数清零。断言的是截图里那个冻结状态本身。
    if (wants(shot, 'history-live')) {
      const readLive = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const flow = document.querySelector('.cr-flow')
            const jump = document.querySelector('.cr-jump')
            const rows = [...document.querySelectorAll('.cr-msg')]
            return {
              rows: rows.length,
              jump: jump ? String(jump.textContent).trim() : null,
              gap: flow ? Math.round(flow.scrollHeight - flow.scrollTop - flow.clientHeight) : null,
              last: rows.length ? String(rows[rows.length - 1].querySelector('.cr-msg-text').textContent).trim() : '',
              error: document.querySelector('.cr-error-bar') ? String(document.querySelector('.cr-error-bar').textContent).trim() : null,
            }
          })()`,
        )
      const live = await readLive()
      if (live.error) throw new Error(`这一屏报错了：${live.error}`)
      if (!live.jump || !/回到最新 · 2 条新的/.test(live.jump)) throw new Error(`出口没写清几条新的：${live.jump}`)
      if (live.rows !== 242) throw new Error(`时间线该是 242 条（240 + 新来的两句），实际 ${live.rows}`)
      if (live.last !== '第二句也一样') throw new Error(`最新那句不对：${live.last}`)
      if (!(live.gap > 200)) throw new Error(`这张图该是「人停在上头」：离底部只有 ${live.gap}px`)
      console.log(`verified — 翻着历史时进来的两句记在出口上：${live.jump}（${live.rows} 条，离底部 ${live.gap}px）`)
      await evaluate(cdp, sessionId, `document.querySelector('.cr-jump').click()`)
      let cleared = null
      for (let i = 0; i < 40; i += 1) {
        cleared = await readLive()
        if (cleared.jump === null) break
        await sleep(100)
      }
      if (cleared.jump !== null) throw new Error('点过之后出口还挂着')
      if (!(cleared.gap <= 2)) throw new Error(`点了「回到最新」却没到底：还差 ${cleared.gap}px`)
      console.log(`verified — 点一下回到最新，计数自己消失（离底部 ${cleared.gap}px）`)
    }
    await cdp.send('Target.closeTarget', { targetId })
  }

  cdp.close()
} finally {
  chrome.kill()
}
