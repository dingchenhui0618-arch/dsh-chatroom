import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { baseUrl, fail, getJson, parseTarget, postJson } from './lan.js'
import { project } from './project.js'

/**
 * LAN 加入者：我这台机器加入别人机器上的房间。
 *
 * 关键取舍：**不把别人的房间当成本地房间**。
 *   - 本地只保留一份镜像（room.remote 非空），所有写操作转发给宿主；
 *   - 我的人与 agent 在宿主那边是 owner=peerId 的成员，轮到他们时宿主派发过来，
 *     我用自己机器上的原生 session 跑完再回传（记忆长在我这台机器上，这才是「带着自己的 agent」）；
 *   - 镜像写进同一个 state 与同一个投影，所以客户端的界面代码一行都不用分叉。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`

/**
 * 把宿主投影里的一间屋子变成本地镜像。
 * 视角要翻过来：宿主眼里的「本机」在这台机器上是「远程」，反之亦然 ——
 * 否则两边都以为自己是本地，界面就分不出消息从哪来。
 */
function mirrorRoom(record, snapshot) {
  const source = (snapshot?.rooms ?? []).find((room) => room.id === record.roomId)
  if (!source) return null
  // 两边各有一个「自己」：宿主那边的 self 成员 id 固定是 'me'，我这边的 self 也是 'me'。
  // 镜像里只能有一个 'me'（否则消息会被认成自己发的），所以把宿主的换成 host_xxx。
  const hostSelfId = `host_${record.peerId.slice(-6)}`
  const remap = (id) => {
    if (id === record.selfMemberId) return 'me'
    if (id === 'me') return hostSelfId
    return id
  }
  // 「我们这边」包括我的人和我带的 agent：他们说的话在本地视角都是本机，
  // 只有别人的话才标 LAN（否则自己的 agent 一发言就被标成远程，看着像串台）。
  const myMemberIds = new Set(
    (source.members ?? []).filter((member) => member.owner === record.peerId).map((member) => member.id),
  )
  const members = (source.members ?? []).map((member) => {
    const mine = member.owner === record.peerId
    if (mine) {
      return { ...member, id: remap(member.id), origin: { kind: 'local', peer: null, machine: record.machine }, owner: 'local' }
    }
    const machine = member.origin?.machine || member.origin?.peer || record.hostMachine
    return { ...member, id: remap(member.id), origin: { kind: 'lan', peer: machine, machine }, owner: 'remote' }
  })
  const messages = (source.messages ?? []).map((message) => {
    const mine = message.authorId === record.selfMemberId || myMemberIds.has(message.authorId)
    const machine = mine ? record.machine : message.origin?.machine || record.hostMachine
    return {
      ...message,
      authorId: remap(message.authorId),
      mentions: (message.mentions ?? []).map(remap),
      origin: mine ? { kind: 'local', peer: null, machine: record.machine } : { kind: 'lan', peer: machine, machine },
    }
  })
  return {
    id: record.localRoomId,
    code: source.code,
    name: source.name,
    topic: source.topic,
    createdAt: source.createdAt,
    ownerId: 'remote',
    remote: {
      host: record.host,
      port: record.port,
      peerId: record.peerId,
      machine: record.hostMachine,
      roomId: record.roomId,
    },
    rules: { ...source.rules },
    activity: source.activity ?? null,
    nextSeq: source.nextSeq,
    reads: {},
    members,
    messages,
    unread: source.unread ?? 0,
    truncated: Boolean(source.truncated),
  }
}

export function createLanGuest({ store, runner, log = () => {} } = {}) {
  /** linkId → {stopped, controller, rejoining} —— 只放运行时，不落盘。 */
  const runtimes = new Map()

  const links = () => store.state.links ?? []
  const linkById = (id) => links().find((link) => link.id === id) ?? null
  const linkByRoom = (roomId) => links().find((link) => link.localRoomId === roomId) ?? null

  function runtimeOf(linkId) {
    let runtime = runtimes.get(linkId)
    if (!runtime) {
      runtime = { stopped: false, controller: new AbortController(), rejoining: 0, failedAt: 0 }
      runtimes.set(linkId, runtime)
    }
    return runtime
  }

  /** 已在本地留下墓碑：房间还在列表里，标成已解散，用户能自己清理。 */
  function paintGone(draft, record) {
    const room = draft.rooms.find((row) => row.id === record.localRoomId)
    if (!room) return
    room.remote = { ...room.remote, lost: true }
    room.unread = 0
    room.activity = null
  }

  function upsertMirror(draft, record, snapshot) {
    draft.links = (draft.links ?? []).filter((link) => link.id !== record.id).concat(record)
    const next = mirrorRoom(record, snapshot)
    if (!next) {
      paintGone(draft, record)
      return
    }
    draft.rooms = draft.rooms.filter((room) => room.id !== record.localRoomId)
    draft.rooms.push(next)
    // 刚加入就把视图切过去：用户下一步一定是想说话，而不是回到本机空房间。
    draft.activeRoomId = next.id
  }

  function markStatus(linkId, { status, error = null, peerId, selfMemberId }) {
    store.commit((draft) => {
      const link = (draft.links ?? []).find((row) => row.id === linkId)
      if (!link) return
      if (status) link.status = status
      link.error = error
      if (peerId) link.peerId = peerId
      if (selfMemberId) link.selfMemberId = selfMemberId
    })
  }

  /** 停掉一条链接的两个长轮询（离开、或屋子已经没了）。 */
  function stopRuntime(linkId) {
    const runtime = runtimes.get(linkId)
    if (!runtime) return
    runtime.stopped = true
    runtime.controller.abort()
    runtimes.delete(linkId)
  }

  function applyRemote(linkId, snapshot) {
    const record = linkById(linkId)
    if (!record) return null
    const next = mirrorRoom(record, snapshot)
    // 宿主那边把这间屋子解散了：投影里没有它了。
    // 不能就此把镜像悄悄删掉 —— 那会让加入方卡在一个「发不出去、也没有离开入口」的状态里。
    // 留一张墓碑：房间还在列表里，标成已解散，用户能自己把它清掉。
    const gone = !next && Boolean(store.state.rooms.find((room) => room.id === record.localRoomId))
    store.commit((draft) => {
      const link = (draft.links ?? []).find((row) => row.id === linkId)
      if (link) {
        link.status = gone ? 'gone' : 'online'
        link.error = gone ? '这间屋子已经在宿主那台机器上解散了。' : null
      }
      if (next) {
        draft.rooms = draft.rooms.filter((room) => room.id !== record.localRoomId)
        draft.rooms.push(next)
        return
      }
      paintGone(draft, record)
    })
    if (gone) {
      stopRuntime(linkId)
      log('lan_room_gone', { link: linkId })
    }
    return next
  }

  /**
   * 宿主重启 / 它那侧进程换了，peerId 立刻失效（这是有意的：宁可让对面重连，
   * 也不拿旧身份错认人）。所以任何一次转发撞上 peer_unknown 时，自己重新握手
   * 再来一次 —— 用户不该因为对面刚重启就看到一句「凭据失效」。
   */
  async function withPeer(record, run) {
    const fresh = linkByRoom(record.localRoomId) ?? record
    if (fresh.status === 'gone') fail('remote_room_gone', '这间屋子已经在宿主那台机器上解散了。')
    try {
      return await run(fresh)
    } catch (error) {
      if (error?.code !== 'peer_unknown') throw error
      const value = await rejoin(fresh.id).catch(() => null)
      if (!value) throw error
      const next = linkByRoom(fresh.localRoomId)
      if (!next) throw error
      return run(next)
    }
  }

  async function join(input = {}) {
    const { host, port } = parseTarget(input.host ?? input.address, input.port)
    const code = String(input.code ?? '').trim().toUpperCase()
    if (!code) fail('code_required', '房间码不能为空。')
    const existing = links().find((link) => link.host === host && link.port === port && link.code === code)
    const linkId = existing?.id ?? shortId('ln')
    const localRoomId = existing?.localRoomId ?? shortId('rm_lan')
    const machine = String(input.machine ?? '').trim().slice(0, 64) || hostname()
    const value = await postJson(
      `${baseUrl(host, port)}/lan/join`,
      {
        code,
        machine,
        self: { id: store.state.self.id, name: store.state.self.name },
        agents: store.state.bots.map((bot) => ({ id: bot.id, name: bot.name, role: bot.role })),
      },
      { timeoutMs: 15_000 },
    )
    const record = {
      id: linkId,
      host,
      port,
      code,
      machine,
      peerId: value.peerId,
      hostMachine: value.hostMachine ?? null,
      roomId: value.roomId,
      localRoomId,
      selfMemberId: value.selfMemberId,
      status: 'online',
      error: null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    store.commit((draft) => upsertMirror(draft, record, value.snapshot))
    start(linkId)
    return record
  }

  /**
   * 换一个新的 peerId 重新握手。
   *
   * 并发去重：长轮询和「用户正在发言」很可能同时撞上旧凭据，两边各自 join 一次
   * 就会在宿主那边建出两套成员（屋里出现两个「周荻」）。所以同一时刻只允许一次握手，
   * 后来的人等同一个 promise。失败后压 3 秒再试，避免对着关掉的机器刷请求。
   */
  async function rejoin(linkId) {
    const record = linkById(linkId)
    if (!record) return null
    const runtime = runtimeOf(linkId)
    if (runtime.rejoining) return runtime.rejoining
    if (runtime.failedAt && Date.now() - runtime.failedAt < 3000) return null
    const run = (async () => {
      try {
        const value = await postJson(
          `${baseUrl(record.host, record.port)}/lan/join`,
          {
            code: record.code,
            machine: record.machine,
            self: { id: store.state.self.id, name: store.state.self.name },
            agents: store.state.bots.map((bot) => ({ id: bot.id, name: bot.name, role: bot.role })),
          },
          { timeoutMs: 15_000 },
        )
        runtime.failedAt = 0
        store.commit((draft) => {
          const next = { ...record, peerId: value.peerId, selfMemberId: value.selfMemberId, status: 'online', error: null }
          upsertMirror(draft, next, value.snapshot)
        })
        return value
      } catch (error) {
        runtime.failedAt = Date.now()
        markStatus(linkId, { status: 'offline', error: String(error?.message ?? error).slice(0, 200) })
        return null
      }
    })()
    runtime.rejoining = run
    try {
      return await run
    } finally {
      runtime.rejoining = 0
    }
  }

  function start(linkId) {
    const runtime = runtimeOf(linkId)
    if (runtime.started) return
    runtime.started = true
    void stateLoop(linkId, runtime)
    void assignmentLoop(linkId, runtime)
  }

  async function stateLoop(linkId, runtime) {
    let since = -1
    while (!runtime.stopped) {
      const record = linkById(linkId)
      if (!record) break
      try {
        const value = await getJson(
          `${baseUrl(record.host, record.port)}/lan/state?peerId=${encodeURIComponent(record.peerId)}&since=${since}`,
          { timeoutMs: 40_000, signal: runtime.controller.signal },
        )
        since = Number(value.revision ?? since)
        applyRemote(linkId, value.snapshot)
      } catch (error) {
        if (runtime.stopped) break
        if (error?.code === 'peer_unknown') {
          since = -1
          await rejoin(linkId)
          if (runtime.stopped) break
          continue
        }
        markStatus(linkId, { status: 'offline', error: String(error?.message ?? error).slice(0, 200) })
        await sleep(1500)
      }
    }
  }

  async function assignmentLoop(linkId, runtime) {
    while (!runtime.stopped) {
      const record = linkById(linkId)
      if (!record) break
      let value
      try {
        value = await getJson(
          `${baseUrl(record.host, record.port)}/lan/assignments?peerId=${encodeURIComponent(record.peerId)}`,
          { timeoutMs: 40_000, signal: runtime.controller.signal },
        )
      } catch (error) {
        if (runtime.stopped) break
        if (error?.code === 'peer_unknown') {
          await rejoin(linkId)
          continue
        }
        await sleep(1500)
        continue
      }
      const assignment = value?.assignment
      if (!assignment) continue
      await runAssignment(record, assignment)
      if (runtime.stopped) break
    }
  }

  /** 宿主把「轮到某个 agent」派过来：用它自己机器上的原生 session 跑。 */
  async function runAssignment(record, assignment) {
    const bot = store.state.bots.find((row) => row.id === assignment.agentId)
    const send = (body) =>
      postJson(
        `${baseUrl(record.host, record.port)}/lan/reply`,
        { peerId: record.peerId, assignmentId: assignment.id, ...body },
        { timeoutMs: 15_000 },
      )
    if (!bot) {
      await send({ error: `本机没有「${assignment.memberName}」这个 agent` }).catch((error) =>
        log('lan_reply_failed', error),
      )
      return
    }
    try {
      const { text } = await runner.say({ ...bot, cwd: bot.cwd ?? undefined }, assignment.prompt)
      await send({ text })
    } catch (error) {
      log('lan_assignment_failed', { botId: bot.id, error })
      await send({ error: String(error?.code ?? error?.message ?? error).slice(0, 160) }).catch(() => {})
    }
  }

  async function send({ roomId, text, mentions, replyTo, opKey }) {
    const record = linkByRoom(roomId)
    if (!record) fail('remote_room_unknown', '这个房间不是从别的机器同步来的。')
    return withPeer(record, async (peer) => {
      // 本地的 'me' 在宿主那边是它自己的成员，必须换回我这台机器的成员 id，
      // 否则「@我自己」会点到对面的人。
      const declared = (Array.isArray(mentions) ? mentions : []).map((id) => (id === 'me' ? peer.selfMemberId : id))
      const value = await postJson(
        `${baseUrl(peer.host, peer.port)}/lan/message`,
        { peerId: peer.peerId, text, mentions: declared, replyTo, opKey },
        { timeoutMs: 20_000 },
      )
      applyRemote(peer.id, value.snapshot)
      return value
    })
  }

  async function read({ roomId, seq }) {
    const record = linkByRoom(roomId)
    if (!record) return null
    return withPeer(record, async (peer) => {
      const value = await postJson(`${baseUrl(peer.host, peer.port)}/lan/read`, {
        peerId: peer.peerId,
        seq,
      })
      if (value?.snapshot) {
        applyRemote(peer.id, value.snapshot)
        return value
      }
      store.commit((draft) => {
        const room = draft.rooms.find((row) => row.id === roomId)
        if (!room) return
        room.unread = room.messages.filter((message) => message.seq > seq && message.authorId !== 'me').length
      })
      return value
    })
  }

  async function rename(name) {
    const label = String(name ?? '').trim().slice(0, 60)
    if (!label) return null
    for (const record of links()) {
      await postJson(
        `${baseUrl(record.host, record.port)}/lan/self`,
        { peerId: record.peerId, name: label },
        { timeoutMs: 8000 },
      ).catch((error) => log('lan_rename_failed', error))
    }
    return { renamed: true }
  }

  async function leave(linkId) {
    const record = linkById(linkId)
    const runtime = runtimes.get(linkId)
    if (runtime) {
      runtime.stopped = true
      runtime.controller.abort()
      runtimes.delete(linkId)
    }
    if (record && record.status !== 'gone') {
      await postJson(
        `${baseUrl(record.host, record.port)}/lan/leave`,
        { peerId: record.peerId },
        { timeoutMs: 8000 },
      ).catch((error) => log('lan_leave_failed', error))
    }
    store.commit((draft) => {
      draft.links = (draft.links ?? []).filter((link) => link.id !== linkId)
      if (!record) return
      draft.rooms = draft.rooms.filter((room) => room.id !== record.localRoomId)
      if (draft.activeRoomId === record.localRoomId) draft.activeRoomId = draft.rooms[0]?.id ?? null
    })
    return { left: true }
  }

  /** 进程重启后把上次加入的房间接回来：宿主那边的 peerId 已经失效，重新握手。 */
  async function resume() {
    for (const record of links()) {
      // 已经解散的屋子没有再握手的意思：重新 join 只会拿到 room_not_found，
      // 白白把「已解散」这条状态覆盖成「离线」。
      if (record.status === 'gone') continue
      try {
        await join({ host: record.host, port: record.port, code: record.code, machine: record.machine })
      } catch (error) {
        log('lan_resume_failed', { link: record.id, error })
        markStatus(record.id, { status: 'offline', error: String(error?.message ?? error).slice(0, 200) })
      }
    }
  }

  function snapshotView() {
    return project(store.state, { viewerId: store.state.self.id })
  }

  async function stop() {
    for (const [linkId, runtime] of runtimes) {
      runtime.stopped = true
      runtime.controller.abort()
      runtimes.delete(linkId)
    }
  }

  return { join, leave, send, read, rename, resume, stop, snapshotView, linkByRoom, links }
}
