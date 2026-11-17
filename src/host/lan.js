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

/** 本机在局域网里的 IPv4 地址。公网/回环/虚拟网卡不在这里筛，界面自己决定怎么显示。 */
export function lanAddresses() {
  const out = []
  const nets = networkInterfaces()
  for (const [name, list] of Object.entries(nets ?? {})) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ address: net.address, name })
    }
  }
  return out
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
