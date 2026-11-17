import { newId, newRoomCode } from './state.js'

/**
 * 房间状态机：纯函数，全部直接改传进来的 state。
 *
 * 「纯」在这里很重要 —— 这层是唯一需要认真测的东西：房间、成员、消息序号、
 * 未读游标、三条发言规则。Bot 回合（要真调模型）不在这里，见 turn.js / speak.js。
 */

/** 发言规则默认值。三条规则是并列存在的开关，不是互斥的三选一。 */
export const DEFAULT_RULES = {
  mention: true, // 被 @ 的 agent 一定回
  roundRobin: false, // 人发言后所有 agent 依次各说一句
  chairId: null, // 主持人 memberId：先把话交给它，它可以 @ 别人接力
  maxSpeakers: 3, // 一条人消息最多引出几个 agent 回复（含接力）
  maxDepth: 2, // agent 之间接力的最大层数
  maxChars: 1200, // 单条消息上限
}

const LIMITS = { name: 60, topic: 400, role: 200, text: 8000, members: 60, messages: 4000 }

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

export function clean(value, max) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (text.length > max) return text.slice(0, max)
  return text
}

export const getRoom = (state, roomId) => state.rooms.find((room) => room.id === roomId) ?? null

function requireRoom(state, roomId) {
  const room = getRoom(state, roomId)
  if (!room) fail('room_not_found')
  return room
}

export const getMember = (room, memberId) => room.members.find((member) => member.id === memberId) ?? null

export function createRoom(state, { name, topic, selfName } = {}) {
  const label = clean(name, LIMITS.name)
  if (!label) fail('room_name_required')
  const taken = new Set(state.rooms.map((room) => room.code))
  const room = {
    id: newId('rm'),
    code: newRoomCode(taken),
    name: label,
    topic: clean(topic, LIMITS.topic),
    createdAt: new Date().toISOString(),
    ownerId: state.self.id,
    rules: { ...DEFAULT_RULES },
    members: [],
    messages: [],
    nextSeq: 1,
    reads: {},
  }
  // 起房间的人自动在屋里，身份是「人」。
  room.members.push({
    id: state.self.id,
    kind: 'human',
    name: clean(selfName ?? state.self.name, LIMITS.name) || '我',
    role: '',
    botId: null,
    sessionId: null,
    origin: { kind: 'local', peer: null, machine: null },
    joinedAt: new Date().toISOString(),
    reach: 'here',
  })
  state.rooms.push(room)
  state.activeRoomId = room.id
  return room
}

export function updateRoom(state, { roomId, name, topic, rules } = {}) {
  const room = requireRoom(state, roomId)
  if (name !== undefined) {
    const label = clean(name, LIMITS.name)
    if (!label) fail('room_name_required')
    room.name = label
  }
  if (topic !== undefined) room.topic = clean(topic, LIMITS.topic)
  if (rules && typeof rules === 'object') {
    if (rules.mention !== undefined) room.rules.mention = Boolean(rules.mention)
    if (rules.roundRobin !== undefined) room.rules.roundRobin = Boolean(rules.roundRobin)
    if (rules.chairId !== undefined) {
      if (rules.chairId === null) room.rules.chairId = null
      else {
        const member = getMember(room, rules.chairId)
        if (!member || member.kind !== 'bot') fail('chair_must_be_agent')
        room.rules.chairId = member.id
      }
    }
    if (rules.maxSpeakers !== undefined) room.rules.maxSpeakers = clampInt(rules.maxSpeakers, 1, 8, room.rules.maxSpeakers)
    if (rules.maxDepth !== undefined) room.rules.maxDepth = clampInt(rules.maxDepth, 0, 3, room.rules.maxDepth)
    if (rules.maxChars !== undefined) room.rules.maxChars = clampInt(rules.maxChars, 120, 4000, room.rules.maxChars)
  }
  return room
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export function dissolveRoom(state, { roomId } = {}) {
  const room = requireRoom(state, roomId)
  state.rooms = state.rooms.filter((row) => row.id !== room.id)
  if (state.activeRoomId === room.id) state.activeRoomId = state.rooms[0]?.id ?? null
  return room
}

export function addMember(state, { roomId, member } = {}) {
  const room = requireRoom(state, roomId)
  if (room.members.length >= LIMITS.members) fail('room_full')
  if (room.members.some((row) => row.id === member.id)) return getMember(room, member.id)
  const origin = normalizeOrigin(member.origin)
  const row = {
    id: member.id,
    kind: member.kind === 'bot' ? 'bot' : 'human',
    name: clean(member.name, LIMITS.name) || (member.kind === 'bot' ? 'agent' : '访客'),
    role: clean(member.role, LIMITS.role),
    botId: member.botId ?? null,
    sessionId: member.sessionId ?? null,
    origin,
    joinedAt: new Date().toISOString(),
    // 来源决定初始在线态：LAN 进来的人在「别的机器上」，不能标成本机在线。
    reach: member.reach ?? (member.kind === 'bot' ? 'local' : origin.kind === 'lan' ? 'lan' : 'here'),
  }
  room.members.push(row)
  return row
}

export function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return { kind: 'local', peer: null, machine: null }
  if (origin.kind === 'lan') {
    return {
      kind: 'lan',
      peer: typeof origin.peer === 'string' ? origin.peer.slice(0, 64) : null,
      machine: typeof origin.machine === 'string' ? origin.machine.slice(0, 64) : null,
    }
  }
  return { kind: 'local', peer: null, machine: null }
}

export function removeMember(state, { roomId, memberId } = {}) {
  const room = requireRoom(state, roomId)
  if (memberId === state.self.id) fail('cannot_remove_self')
  const member = getMember(room, memberId)
  if (!member) fail('member_not_found')
  room.members = room.members.filter((row) => row.id !== memberId)
  if (room.rules.chairId === memberId) room.rules.chairId = null
  delete room.reads[memberId]
  return member
}

export function updateMember(state, { roomId, memberId, patch = {} } = {}) {
  const room = requireRoom(state, roomId)
  const member = getMember(room, memberId)
  if (!member) fail('member_not_found')
  if (patch.name !== undefined) {
    const label = clean(patch.name, LIMITS.name)
    if (!label) fail('member_name_required')
    member.name = label
  }
  if (patch.role !== undefined) member.role = clean(patch.role, LIMITS.role)
  if (patch.reach !== undefined && typeof patch.reach === 'string') member.reach = patch.reach.slice(0, 32)
  if (patch.origin !== undefined) member.origin = normalizeOrigin(patch.origin)
  return member
}

/**
 * 往房间里放一条消息。
 *
 * seq 是房间内的严格递增游标，客户端用它做增量与未读；id 用来做幂等
 * （客户端重发同一条不会进两遍）。
 */
export function postMessage(state, { roomId, authorId, text, mentions, replyTo, origin, status = 'sent', opKey } = {}) {
  const room = requireRoom(state, roomId)
  const body = clean(text, LIMITS.text)
  if (!body && status !== 'error') fail('message_empty')
  if (opKey) {
    const existing = room.messages.find((message) => message.opKey === opKey)
    if (existing) return existing
  }
  let author = getMember(room, authorId)
  if (!author && authorId === state.self.id) {
    // 自愈：房间从旧版本带过来的、没有 self 成员的情况。
    author = addMember(state, {
      roomId,
      member: { id: state.self.id, kind: 'human', name: state.self.name, origin: { kind: 'local' } },
    })
  }
  if (!author) fail('author_not_in_room')
  const seq = room.nextSeq
  room.nextSeq = seq + 1
  const message = {
    seq,
    id: newId('ms'),
    at: new Date().toISOString(),
    authorId: author.id,
    authorName: author.name,
    authorKind: author.kind,
    text: body,
    mentions: mergeMentions(room, normalizeMentions(room, mentions), body),
    replyTo: Number.isSafeInteger(replyTo) ? replyTo : null,
    origin: normalizeOrigin(origin ?? author.origin),
    status,
    opKey: opKey ?? null,
  }
  room.messages.push(message)
  if (room.messages.length > LIMITS.messages) room.messages.splice(0, room.messages.length - LIMITS.messages)
  // 发言人自己的游标跟着走；别人的未读因此才准。
  room.reads[author.id] = seq
  return message
}

function normalizeMentions(room, mentions) {
  if (!Array.isArray(mentions)) return []
  const ids = []
  for (const raw of mentions) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const member =
      getMember(room, text) ??
      room.members.find((row) => row.name === text || row.name.toLowerCase() === text.toLowerCase())
    if (member && !ids.includes(member.id)) ids.push(member.id)
  }
  return ids
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 从正文里认出 @名字。
 *
 * 为什么不让客户端算：客户端的 UI 可能漏、接口调用方（LAN / curl）根本没有 UI。
 * 「谁被 @ 了」是房间的事实，得由 Host 自己认。名字长的先匹配，避免 A 把 Alice 吃掉。
 */
export function mentionsInText(room, text) {
  const names = room.members
    .map((member) => member.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort((left, right) => right.length - left.length)
  if (!names.length) return []
  const pattern = new RegExp('@(' + names.map(escapeRegExp).join('|') + ')', 'g')
  const ids = []
  let match
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    const member = room.members.find((row) => row.name === match[1])
    if (member && !ids.includes(member.id)) ids.push(member.id)
  }
  return ids
}

function mergeMentions(room, declared, text) {
  const merged = [...declared]
  for (const id of mentionsInText(room, text)) if (!merged.includes(id)) merged.push(id)
  return merged
}

export function markRead(state, { roomId, memberId, seq } = {}) {
  const room = requireRoom(state, roomId)
  const member = getMember(room, memberId)
  if (!member) fail('member_not_found')
  const top = Number.isSafeInteger(seq) ? seq : room.nextSeq - 1
  room.reads[memberId] = Math.max(room.reads[memberId] ?? 0, Math.min(top, room.nextSeq - 1))
  return room
}

export function unreadOf(room, memberId) {
  const cursor = room.reads[memberId] ?? 0
  return room.messages.filter((message) => message.seq > cursor && message.authorId !== memberId).length
}

/** 给模型看的对话记录：跳过失败占位与房间外的东西。 */
export function transcriptOf(room, { limit = 24, selfId = 'me' } = {}) {
  return room.messages
    .filter((message) => message.status !== 'error')
    .slice(-limit)
    .map((message) => {
      const who = message.authorId === selfId ? `${message.authorName}（人）` : `${message.authorName}（agent）`
      const origin = message.origin?.kind === 'lan' ? '〔远程〕' : ''
      return `#${message.seq} ${origin}${who}：${message.text}`
    })
    .join('\n')
}

/** 从一条消息里找出被点名、且在屋里的 agent。 */
export function mentionedBots(room, message) {
  const ids = message?.mentions ?? []
  return ids
    .map((id) => getMember(room, id))
    .filter((member) => member && member.kind === 'bot')
}

export function botsOf(room) {
  return room.members.filter((member) => member.kind === 'bot')
}
