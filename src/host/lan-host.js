import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  addMember,
  getMember,
  getRoom,
  markRead,
  membersOfPeer,
  postMessage,
  removePeer,
} from './rooms.js'
import { ASSIGN_TIMEOUT, MAX_BODY, PEER_IDLE, WAIT_MS, fail, lanAddresses } from './lan.js'
import { project } from './project.js'

/**
 * LAN 宿主：这台机器上的房间让局域网里另一台机器加入。
 *
 * 它只解决一件事 —— **agent 不能跨机器执行**：
 * 宿主决定轮到某台机器上的 agent 时，不本地跑模型，而是把这一轮塞进
 * assignment 队列，对方长轮询领走、用它自己机器上的 session 跑完再回传。
 * 宿主校验「这条 assignment 是我的、还没被用掉」之后，才以那个成员的身份落库。
 *
 * 鉴权：房间码进 /lan/join，换到一个随机 peerId；之后每个请求都要带 peerId。
 * peerId 就是这台机器在这间屋子里的临时身份，宿主重启即失效（宁可让对面重连，
 * 也不要拿旧身份错认人）。明文 HTTP 是设计取舍，威胁模型是「同一 WiFi 下可信的人」。
 */

/** 等对面机器回一个回合的上限。测试用环境变量压短，量的是失败路径而不是耐心。 */
function assignTimeout() {
  const raw = Number(process.env.DSH_CHATROOM_ASSIGN_TIMEOUT)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : ASSIGN_TIMEOUT
}

const logDefault = () => {}

/** 端口 0 是有意义的（让系统挑一个空闲端口，测试与截图走这条），所以不能写成 `|| 4399`。 */
function defaultPort() {
  const raw = process.env.DSH_CHATROOM_PORT
  if (raw === undefined || raw === '') return 4399
  const port = Number(raw)
  return Number.isSafeInteger(port) && port >= 0 ? port : 4399
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      reject(Object.assign(new Error('请求体太大'), { code: 'too_large' }))
      return
    }
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        reject(Object.assign(new Error('请求体太大'), { code: 'too_large' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(Object.assign(new Error('请求体不是 JSON'), { code: 'bad_json' }))
      }
    })
    request.on('error', reject)
  })
}

const ipOf = (request) => String(request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')

export function createLanHost({ store, onHumanMessage = () => {}, log = logDefault, machine = hostname(), port } = {}) {
  /** peerId → {id, machine, address, roomId, selfMemberId, since, lastSeen, agents} */
  const peers = new Map()
  /** assignmentId → {id, peerId, roomId, memberId, agentId, memberName, prompt, ...} */
  const assignments = new Map()
  /** 长轮询的唤醒器：有人加入、有新 assignment、状态变了，都推一下。 */
  const wakers = new Set()
  let server = null
  let bound = { port: null }
  let closed = false
  let lastError = null

  const wake = () => {
    for (const fn of [...wakers]) {
      try {
        fn()
      } catch {
        /* 唤醒器自己的错误不该影响别人 */
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        wakers.delete(finish)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      wakers.add(finish)
    })
  }

  function waitRevision(since, ms) {
    if (store.state.revision !== since) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        wakers.delete(finish)
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      const unsubscribe = store.subscribe(finish)
      wakers.add(finish)
    })
  }

  function status() {
    const now = Date.now()
    return {
      serving: Boolean(server && bound.port),
      port: bound.port,
      machine,
      addresses: lanAddresses(),
      error: lastError,
      pending: [...assignments.values()].filter((row) => !row.done).length,
      peers: [...peers.values()]
        .filter((peer) => now - peer.lastSeen < PEER_IDLE)
        .map((peer) => ({
          id: peer.id,
          machine: peer.machine,
          address: peer.address,
          roomId: peer.roomId,
          agents: peer.agents.map((agent) => agent.name),
          since: peer.since,
          lastSeen: peer.lastSeen,
        })),
    }
  }

  function requirePeer(peerId) {
    const peer = peers.get(String(peerId ?? ''))
    if (!peer) fail('peer_unknown', '这台机器的加入凭据已失效，请重新加入房间。')
    peer.lastSeen = Date.now()
    return peer
  }

  function joinRoom({ code, machine: guestMachine, self, agents }, address) {
    const wanted = String(code ?? '').trim().toUpperCase()
    if (!wanted) fail('code_required', '房间码不能为空。')
    const room = store.state.rooms.find((row) => String(row.code ?? '').toUpperCase() === wanted)
    if (!room) fail('room_not_found', '房间码不对，或这台机器上没有这间屋子。')
    if (room.remote) fail('remote_room', '这是从别的机器同步过来的房间，不能在这里再当宿主。')

    const peerId = `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const label = String(guestMachine ?? '').trim().slice(0, 64) || address
    const peer = {
      id: peerId,
      machine: label,
      address,
      roomId: room.id,
      selfMemberId: null,
      since: Date.now(),
      lastSeen: Date.now(),
      agents: [],
    }
    const origin = { kind: 'lan', peer: address, machine: label }
    // 对面没报名字（或跟本机同名）时用机器名兜底：屋里出现两个「我」，
    // 成员列和 @ 都会认错人。
    const declaredName = String(self?.name ?? '').trim().slice(0, 60)
    const humanName = !declaredName || declaredName === store.state.self.name ? label : declaredName

    store.commit((draft) => {
      const human = addMember(draft, {
        roomId: room.id,
        member: {
          id: `h_${peerId.slice(2, 12)}`,
          kind: 'human',
          name: humanName,
          role: '',
          origin,
          owner: peerId,
          reach: 'lan',
        },
      })
      peer.selfMemberId = human.id
      const declared = Array.isArray(agents) ? agents.slice(0, 12) : []
      for (const agent of declared) {
        const key = String(agent?.id ?? '').trim().slice(0, 64)
        if (!key) continue
        const row = addMember(draft, {
          roomId: room.id,
          member: {
            id: `m_${key}`,
            kind: 'bot',
            name: agent?.name,
            role: agent?.role,
            botId: key,
            sessionId: null,
            origin,
            owner: peerId,
            reach: 'lan',
          },
        })
        peer.agents.push({ memberId: row.id, agentId: key, name: row.name })
      }
    })

    peers.set(peerId, peer)
    wake()
    return {
      peerId,
      roomId: room.id,
      selfMemberId: peer.selfMemberId,
      hostMachine: machine,
      snapshot: project(store.state, { lan: status(), viewerId: peer.selfMemberId }),
    }
  }

  /**
   * 把一个 agent 回合派发给它所在的机器。
   * 45s 没回音就落一条失败占位（speak.js 负责写），不让整轮卡死。
   */
  function enqueue({ roomId, member, prompt }) {
    if (!member?.owner || member.owner === 'local') {
      return Promise.reject(Object.assign(new Error('not_remote'), { code: 'not_remote' }))
    }
    const peer = peers.get(member.owner)
    if (!peer || Date.now() - peer.lastSeen > PEER_IDLE) {
      return Promise.reject(Object.assign(new Error(`${member.name} 所在的机器不在线。`), { code: 'peer_offline' }))
    }
    const id = `as_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    return new Promise((resolve, reject) => {
      const row = {
        id,
        peerId: member.owner,
        roomId,
        memberId: member.id,
        agentId: member.botId,
        memberName: member.name,
        prompt,
        createdAt: Date.now(),
        claimedAt: null,
        done: false,
        resolve,
        reject,
      }
      row.timer = setTimeout(() => {
        if (row.done) return
        row.done = true
        assignments.delete(id)
        wake()
        reject(Object.assign(new Error('对面机器没有回应。'), { code: 'lan_timeout' }))
      }, assignTimeout())
      row.timer.unref?.()
      assignments.set(id, row)
      wake()
    })
  }

  async function nextAssignment(peerId) {
    const deadline = Date.now() + WAIT_MS
    for (;;) {
      const row = [...assignments.values()].find((item) => !item.done && !item.claimedAt && item.peerId === peerId)
      if (row) {
        row.claimedAt = Date.now()
        return {
          id: row.id,
          roomId: row.roomId,
          memberId: row.memberId,
          agentId: row.agentId,
          memberName: row.memberName,
          prompt: row.prompt,
        }
      }
      const left = deadline - Date.now()
      if (left <= 0) return null
      await sleep(left)
    }
  }

  function settleAssignment({ peerId, assignmentId, text, error }) {
    const row = assignments.get(String(assignmentId ?? ''))
    if (!row || row.done) fail('assignment_expired', '这一轮已经结束了。')
    if (row.peerId !== peerId) fail('assignment_denied', '这条派发不属于这台机器。')
    row.done = true
    clearTimeout(row.timer)
    assignments.delete(row.id)
    wake()
    if (error) {
      row.reject(Object.assign(new Error(String(error).slice(0, 200) || '对面没能回上来'), { code: 'lan_failed' }))
    } else {
      row.resolve({ text: String(text ?? '') })
    }
    return { ok: true }
  }

  function viewFor(peer) {
    return project(store.state, { lan: status(), viewerId: peer.selfMemberId })
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'host'}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    let value
    try {
      if (closed) fail('disabled', '这只宿主已经停了。')

      if (path === '/lan/join' && request.method === 'POST') {
        value = joinRoom(await readJson(request), ipOf(request))
      } else if (path === '/lan/state' && request.method === 'GET') {
        const peer = requirePeer(url.searchParams.get('peerId'))
        const since = Number(url.searchParams.get('since') ?? -1)
        await waitRevision(since, WAIT_MS)
        peer.lastSeen = Date.now()
        value = { revision: store.state.revision, snapshot: viewFor(peer), hostMachine: machine, selfMemberId: peer.selfMemberId }
      } else if (path === '/lan/message' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const room = getRoom(store.state, peer.roomId)
        if (!room) fail('room_not_found', '这间屋子已经不在了。')
        let posted = null
        store.commit((draft) => {
          posted = postMessage(draft, {
            roomId: peer.roomId,
            authorId: peer.selfMemberId,
            text: input.text,
            mentions: input.mentions,
            replyTo: input.replyTo,
            origin: { kind: 'lan', peer: peer.address, machine: peer.machine },
            opKey: input.opKey,
          })
        })
        if (posted) onHumanMessage({ roomId: peer.roomId, messageId: posted.id })
        value = { messageId: posted?.id ?? null, seq: posted?.seq ?? null, snapshot: viewFor(peer) }
      } else if (path === '/lan/assignments' && request.method === 'GET') {
        const peer = requirePeer(url.searchParams.get('peerId'))
        const assignment = await nextAssignment(peer.id)
        peer.lastSeen = Date.now()
        value = { assignment, revision: store.state.revision }
      } else if (path === '/lan/reply' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        value = settleAssignment({
          peerId: peer.id,
          assignmentId: input.assignmentId,
          text: input.text,
          error: input.error,
        })
      } else if (path === '/lan/read' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        store.commit((draft) => {
          markRead(draft, { roomId: peer.roomId, memberId: peer.selfMemberId, seq: Number(input.seq) })
        })
        // 顺手把已读后的投影带回去：否则加入方本地先清零，又会被一条在途的
        // 长轮询旧快照覆盖回去，界面上未读数会「闪回来」。
        value = { snapshot: viewFor(peer) }
      } else if (path === '/lan/self' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const name = String(input.name ?? '').trim().slice(0, 60)
        if (name) {
          store.commit((draft) => {
            const room = getRoom(draft, peer.roomId)
            const member = room ? getMember(room, peer.selfMemberId) : null
            if (member) member.name = name
          })
        }
        value = { renamed: Boolean(name) }
      } else if (path === '/lan/leave' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        peers.delete(peer.id)
        store.commit((draft) => {
          removePeer(draft, { roomId: peer.roomId, peerId: peer.id })
        })
        wake()
        value = { left: true }
      } else if (path === '/lan/ping') {
        value = { ok: true, hostMachine: machine, serving: Boolean(bound.port) }
      } else {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: '没有这个端点。' } }))
        return
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal_error'
      const status = code === 'peer_unknown' || code === 'room_not_found' || code === 'code_required' ? 403 : 400
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: { code, message: String(error?.message ?? code).slice(0, 300) } }))
      return
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    response.end(JSON.stringify({ ok: true, value }))
  }

  /**
   * 新进程起来时把上一轮残留的 LAN 成员清掉。
   *
   * peerId 是每个进程现发的，进程一死它就没有任何意义了；可成员是落盘的。
   * 不清的话，宿主重启后屋里会留着一批「幽灵」—— 永远不回话，看着还像在线。
   */
  function pruneStalePeers() {
    let removed = 0
    store.commit((draft) => {
      for (const room of draft.rooms) {
        if (room.remote) continue
        const stale = room.members.filter((member) => member.owner && member.owner !== 'local')
        if (!stale.length) continue
        removed += stale.length
        room.members = room.members.filter((member) => !member.owner || member.owner === 'local')
        for (const member of stale) {
          if (room.rules.chairId === member.id) room.rules.chairId = null
          delete room.reads[member.id]
        }
      }
    })
    if (removed) log('lan_pruned_stale', removed)
  }

  async function start(wantPort = port ?? defaultPort()) {
    if (server) return status()
    closed = false
    lastError = null
    pruneStalePeers()
    const next = createServer((request, response) => {
      void route(request, response)
    })
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          next.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          next.off('error', onError)
          resolve()
        }
        next.once('error', onError)
        next.once('listening', onListening)
        next.listen(wantPort, '0.0.0.0')
      })
    } catch (error) {
      lastError = error?.code === 'EADDRINUSE' ? `端口 ${wantPort} 被占用了。` : String(error?.message ?? error)
      log('lan_listen_failed', lastError)
      await new Promise((resolve) => next.close(() => resolve()))
      return status()
    }
    server = next
    bound = { port: next.address()?.port ?? wantPort }
    log('lan_listening', bound.port)
    return status()
  }

  async function stop() {
    closed = true
    for (const row of assignments.values()) {
      row.done = true
      clearTimeout(row.timer)
      row.reject(Object.assign(new Error('宿主已停止。'), { code: 'lan_closed' }))
    }
    assignments.clear()
    peers.clear()
    wake()
    const current = server
    server = null
    bound = { port: null }
    if (current) {
      current.closeAllConnections?.()
      await new Promise((resolve) => current.close(() => resolve()))
    }
    return status()
  }

  return { start, stop, status, enqueue, peers, assignments, membersOfPeer, get address() { return bound.port ? `${hostname()}:${bound.port}` : null } }
}
