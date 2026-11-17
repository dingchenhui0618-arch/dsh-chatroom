import { networkInterfaces } from 'node:os'

/**
 * LAN 两半共用的东西：常量、局域网地址、一个能看懂 {ok,value} 的 HTTP 小客户端。
 *
 * 为什么不用 DSH 自己那条 connection 通道跨机器：
 * 它是 loopback + cookie + 每进程随机 token，天生不能给局域网用（见 ARCHITECTURE §2）。
 * 所以宿主自己开一个 node:http 监听，凭据是房间码 —— 威胁模型是「同一 WiFi 下可信的人」。
 */

export const DEFAULT_PORT = 4399
export const WAIT_MS = 25_000
export const ASSIGN_TIMEOUT = 45_000
export const PEER_IDLE = 45_000
export const MAX_BODY = 256 * 1024

export const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

/**
 * 我这份插件有哪些接口能力。跟着 /lan/join 上报给宿主。
 *
 * 老版本不会带这个字段，而它既没有「加入之后补报 agent」的接口、也没有那个界面 ——
 * 于是那台机器进来时屋里就是只有一个人。宿主拿到能力位就能直接说清
 * 「这台是旧版本，重启它的桌面端」，而不是让人对着一张缺了 agent 的成员列猜。
 */
export const BUILD = { agents: 1 }

/**
 * 虚拟网卡的名字特征：这些地址本机自己通，隔壁那台物理机器到不了。
 *
 * 踩过的坑：Windows 上 os.networkInterfaces() 的返回顺序没有保证，装了 WSL2 的机器
 * 里 `vEthernet (WSL (Hyper-V firewall))` 经常排在 WLAN/以太网前面。界面只取
 * addresses[0] 的话，递给对方的邀请地址就是 172.22.x.x —— 抄过去只会一直超时，
 * 而人看着「地址明明是对的」。所以排序时把虚拟网卡压到后面，并带一个 virtual 标记
 * 让界面能直说「这张是虚拟网卡」。
 */
const VIRTUAL_NIC =
  /(vethernet|hyper-v|wsl|vmware|virtualbox|vbox|docker|podman|br-|veth|tap|tun|npcap|loopback|hamachi|tailscale|zerotier|utun)/i

/** 真正的局域网地址排在前面：私网按「最常见」排，其余靠后。 */
function rank(name, address) {
  let score = 0
  if (VIRTUAL_NIC.test(name)) score += 10
  if (/^192\.168\./.test(address)) score += 0
  else if (/^10\./.test(address)) score += 1
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 2
  else score += 3
  return score
}

/**
 * 本机在局域网里的 IPv4 地址，按「对方最可能连得上」的顺序排好。
 *
 * 169.254.x.x（APIPA：没拿到 DHCP 时自己编的地址）进不了另一台机器，直接不算候选。
 */
export function lanAddresses(nets = networkInterfaces()) {
  const out = []
  let index = 0
  for (const [name, list] of Object.entries(nets ?? {})) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (/^169\.254\./.test(net.address) || net.address === '0.0.0.0') continue
      out.push({ address: net.address, name, virtual: VIRTUAL_NIC.test(name), at: index++ })
    }
  }
  // 稳定排序：同分保留系统给的顺序，测试与截图才可复现。
  out.sort((a, b) => rank(a.name, a.address) - rank(b.name, b.address) || a.at - b.at)
  return out.map(({ address, name, virtual }) => ({ address, name, virtual }))
}

export function parseTarget(host, port) {
  let raw = String(host ?? '').trim()
  if (!raw) fail('host_required', '要填对方的地址。')
  raw = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  let parsedPort = Number(port)
  const withPort = /^(.*):(\d{1,5})$/.exec(raw)
  if (!withPort) {
    if (!Number.isSafeInteger(parsedPort) || parsedPort <= 0) parsedPort = DEFAULT_PORT
    return { host: raw, port: parsedPort }
  }
  if (!Number.isSafeInteger(parsedPort) || parsedPort <= 0) parsedPort = Number(withPort[2])
  return { host: withPort[1], port: parsedPort }
}

export function baseUrl(host, port) {
  return `http://${host}:${port}`
}

function unwrap(payload) {
  if (payload && payload.ok === true) return payload.value
  const error = (payload && payload.error) || {}
  throw Object.assign(new Error(error.message || 'LAN 请求没成功'), { code: error.code || 'lan_failed' })
}

async function request(url, { method = 'GET', body, timeoutMs = 20_000, signal } = {}) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  init.signal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR') {
      fail('lan_timeout', '对方的机器没有按时回应。')
    }
    fail('lan_unreachable', `连不上 ${url}（${String(error?.cause?.code ?? error?.message ?? error)}）。`)
  }
  // 老版本没有这个端点：404 归成「对方插件版本太旧」，上层才能说清原因，
  // 而不是报一句笼统的 lan_bad_response。
  if (response.status === 404) fail('not_found', '对方那台机器的插件版本没有这个接口。')
  let payload
  try {
    payload = await response.json()
  } catch {
    fail('lan_bad_response', `对方的回应不是 JSON（HTTP ${response.status}）。`)
  }
  return unwrap(payload)
}

export const getJson = (url, options) => request(url, options)
export const postJson = (url, body, options = {}) => request(url, { ...options, method: 'POST', body })
