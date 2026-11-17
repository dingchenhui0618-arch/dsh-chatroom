import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyState, newRoomCode } from '../src/host/state.js'
import {
  addMember,
  botsOf,
  createRoom,
  DEFAULT_RULES,
  dissolveRoom,
  getMember,
  getRoom,
  markRead,
  mentionedBots,
  postMessage,
  removeMember,
  transcriptOf,
  unreadOf,
  updateRoom,
} from '../src/host/rooms.js'

const setup = () => {
  const state = emptyState()
  const room = createRoom(state, { name: '周四要不要看那份财报', topic: '投委会' })
  return { state, room }
}

const addBot = (state, room, name, role = '') =>
  addMember(state, {
    roomId: room.id,
    member: { id: `m_${name}`, kind: 'bot', name, role, botId: `bot_${name}`, sessionId: `s_${name}` },
  })

test('新房间：起房间的人自动在屋里，房间码是 6 位不歧义字符', () => {
  const { state, room } = setup()
  assert.equal(room.members.length, 1)
  assert.equal(room.members[0].id, state.self.id)
  assert.equal(room.members[0].kind, 'human')
  assert.match(room.code, /^[2-9A-HJ-NP-Z]{6}$/)
  assert.deepEqual(room.rules, DEFAULT_RULES)
  assert.equal(state.activeRoomId, room.id)
  assert.equal(getRoom(state, room.id), room)
})

test('房间码不会撞车', () => {
  const taken = new Set()
  for (let i = 0; i < 500; i += 1) {
    const code = newRoomCode(taken)
    assert.equal(taken.has(code), false)
    taken.add(code)
  }
})

test('成员：agent 与人都能进来，重复加入不产生第二份', () => {
  const { state, room } = setup()
  const bot = addBot(state, room, 'Claude')
  assert.equal(bot.kind, 'bot')
  assert.equal(bot.origin.kind, 'local')
  const again = addBot(state, room, 'Claude')
  assert.equal(again.id, bot.id)
  assert.equal(room.members.length, 2)
  assert.equal(botsOf(room).length, 1)
})

test('LAN 进来的成员带着来源，界面上才分得清本机和远程', () => {
  const { state, room } = setup()
  const guest = addMember(state, {
    roomId: room.id,
    member: { id: 'h_lan', kind: 'human', name: '老王的电脑', origin: { kind: 'lan', peer: '192.168.1.7', machine: 'study-pc' } },
  })
  assert.deepEqual(guest.origin, { kind: 'lan', peer: '192.168.1.7', machine: 'study-pc' })
  assert.equal(guest.reach, 'lan')
})

test('消息：seq 严格递增，@ 按名字也能解析成成员', () => {
  const { state, room } = setup()
  addBot(state, room, 'Grok')
  const first = postMessage(state, { roomId: room.id, authorId: state.self.id, text: '先看现金流' })
  const second = postMessage(state, {
    roomId: room.id,
    authorId: state.self.id,
    text: '@Grok 你说呢',
    mentions: ['Grok'],
  })
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(room.nextSeq, 3)
  assert.deepEqual(second.mentions, ['m_Grok'])
  assert.equal(mentionedBots(room, second).length, 1)
})

test('幂等：同一条 opKey 重发不会进第二遍', () => {
  const { state, room } = setup()
  const a = postMessage(state, { roomId: room.id, authorId: state.self.id, text: 'hi', opKey: 'k1' })
  const b = postMessage(state, { roomId: room.id, authorId: state.self.id, text: 'hi again', opKey: 'k1' })
  assert.equal(a.id, b.id)
  assert.equal(room.messages.length, 1)
})

test('未读：自己发的不算未读，别人发的算', () => {
  const { state, room } = setup()
  const grok = addBot(state, room, 'Grok')
  postMessage(state, { roomId: room.id, authorId: state.self.id, text: '一' })
  postMessage(state, { roomId: room.id, authorId: grok.id, text: '二' })
  assert.equal(unreadOf(room, state.self.id), 1)
  markRead(state, { roomId: room.id, memberId: state.self.id })
  assert.equal(unreadOf(room, state.self.id), 0)
  // 读游标只前进不后退
  const before = room.reads[state.self.id]
  markRead(state, { roomId: room.id, memberId: state.self.id, seq: 0 })
  assert.equal(room.reads[state.self.id], before)
})

test('失败占位不进对话记录，模型看不到', () => {
  const { state, room } = setup()
  const grok = addBot(state, room, 'Grok')
  postMessage(state, { roomId: room.id, authorId: grok.id, text: '（Grok 这次没回上来：empty_reply）', status: 'error' })
  postMessage(state, { roomId: room.id, authorId: grok.id, text: '能看' })
  const transcript = transcriptOf(room)
  assert.equal(transcript.includes('没回上来'), false)
  assert.equal(transcript.includes('能看'), true)
})

test('主持人必须是屋里的 agent，移除主持人后自动卸任', () => {
  const { state, room } = setup()
  const bot = addBot(state, room, 'Claude')
  updateRoom(state, { roomId: room.id, rules: { chairId: bot.id } })
  assert.equal(room.rules.chairId, bot.id)
  assert.throws(() => updateRoom(state, { roomId: room.id, rules: { chairId: state.self.id } }), /chair_must_be_agent/)
  removeMember(state, { roomId: room.id, memberId: bot.id })
  assert.equal(room.rules.chairId, null)
  assert.equal(getMember(room, bot.id), null)
})

test('不能把自己踢出去', () => {
  const { state, room } = setup()
  assert.throws(() => removeMember(state, { roomId: room.id, memberId: state.self.id }), /cannot_remove_self/)
})

test('三条规则是并列开关，不是三选一', () => {
  const { state, room } = setup()
  updateRoom(state, {
    roomId: room.id,
    rules: { mention: true, roundRobin: true, chairId: null, maxSpeakers: 5, maxDepth: 1 },
  })
  assert.equal(room.rules.mention, true)
  assert.equal(room.rules.roundRobin, true)
  assert.equal(room.rules.maxSpeakers, 5)
  assert.equal(room.rules.maxDepth, 1)
})

test('解散房间：状态里留不下残渣，活动房间回退', () => {
  const { state, room } = setup()
  const second = createRoom(state, { name: '第二个屋子' })
  dissolveRoom(state, { roomId: second.id })
  assert.equal(getRoom(state, second.id), null)
  assert.equal(state.activeRoomId, room.id)
})
