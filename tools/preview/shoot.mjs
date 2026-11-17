import { spawn } from 'node:child_process'
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

const shots = [
  {
    name: 'panel',
    view: 'panel',
    waitFor: '.cr-msg',
    verify: 'panel-read',
    caption: '房间面板：房间列表 / 群聊 / 成员与规则入口；从 LAN 加入的人和他的 agent 带远程 chip',
  },
  {
    name: 'invite',
    view: 'panel',
    waitFor: '.cr-msg',
    open: '邀请',
    verify: 'name-edit',
    caption: '邀请另一台机器：局域网地址 + 房间码就是全部凭据，另一台机器填这两样就能进来',
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
    name: 'gone',
    port: guestPort,
    view: 'panel',
    setup: '/preview/dissolve',
    waitFor: 'textarea[disabled]',
    caption: '宿主解散后加入方看到的样子：历史还在、输入锁住、右栏写下原因并只留「从列表移除」',
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

  for (const shot of shots) {
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
    if (shot.verify === 'panel-read') {
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

    // 名字是身份的一部分：输入框里必须是坐在键盘前的这个人，改完要真的落到宿主
    // （成员列换成新名字），再改回去，别把后面的截图带脏。
    // 断言只认成员列，不认输入框：输入框里还有你正在打的草稿，看它等于什么都没证明。
    if (shot.verify === 'name-edit') {
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

    // 截图只证明「出现了未读」，还得证明它「会消」：展开浮窗就等于看过了，
    // 徽标和标题前缀都该归零。这条断言跑在真实渲染的页面里，和截图同一份代码。
    if (shot.verify === 'read') {
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
    if (shot.verify === 'three-parties') {
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
    // 浮窗既然能拖到任何地方，就得证明它拖不丢：记住的坐标要真的用上、越界的坐标要夹回、
    // 拖到屏幕外要夹住、窗口变窄以后还得在视口里。四条都跑在真实渲染的页面里。
    if (shot.verify === 'float-bounds') {
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
      await evaluate(cdp, sessionId, `localStorage.removeItem('dsh-chatroom:float-pos:v1')`)
      console.log('verified — 位置记得住、越界夹回、拖动不出界、窗口变窄仍在视口内')
    }
    await cdp.send('Target.closeTarget', { targetId })
  }

  cdp.close()
} finally {
  chrome.kill()
}
