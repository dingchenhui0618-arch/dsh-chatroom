import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/host/state.js'
import { addMember, createRoom, getRoom, markRead, postMessage, unreadOf, updateRoom } from '../src/host/rooms.js'

/**
 * 落盘不是实现细节，是这个插件的承诺本身：关掉桌面端再打开，屋子和聊天记录还在。
 * 所以这些用例一律走真文件、真 rename、真重开，不 mock fs。
 */

const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-state-'))

test('重启后房间、消息、成员、已读游标都还在（真写盘再打开）', async () => {
  const dir = await tempDir()
  const store = await Store.open(dir)
  let roomId = null
  store.commit((draft) => {
    const room = createRoom(draft, { name: '周六爬山', topic: '三台机器同屋' })
    roomId = room.id
    addMember(draft, {
      roomId,
      member: { id: 'm_amo', kind: 'bot', name: '阿墨', role: '查路线', botId: 'bot_amo', sessionId: 's_amo' },
    })
    postMessage(draft, { roomId, authorId: draft.self.id, text: '周六去爬山？' })
    postMessage(draft, { roomId, authorId: 'm_amo', text: '@我 7:20 有一班公交' })
    markRead(draft, { roomId, memberId: draft.self.id, seq: 1 })
  })
  await store.flush()
  await store.close()

  const again = await Store.open(dir)
  const room = getRoom(again.state, roomId)
  assert.ok(room, '重开之后房间应该还在')
  assert.equal(room.name, '周六爬山')
  assert.equal(room.topic, '三台机器同屋')
  assert.equal(room.nextSeq, 3)
  assert.deepEqual(room.messages.map((message) => message.seq), [1, 2])
  // 中文与 emoji 走 JSON 落盘不能变形
  assert.equal(room.messages[1].text, '@我 7:20 有一班公交')
  assert.equal(room.members.length, 2)
  assert.equal(room.members[1].role, '查路线')
  assert.equal(room.members[1].sessionId, 's_amo')
  // 已读游标 1 → 第 2 条还没读
  assert.equal(unreadOf(room, again.state.self.id), 1)
  assert.equal(again.state.activeRoomId, roomId)
  assert.equal(again.state.revision, 1)
  await again.close()
})

test('state.json 坏了不挡启动：坏文件改名留档，从空状态起步', async () => {
  const dir = await tempDir()
  const file = join(dir, 'state.json')
  // 断电最可能留下的形状：写到一半的 JSON
  const broken = '{"schema":1,"revision":3,"self":{"id":"me","na'
  await writeFile(file, broken, 'utf8')

  const store = await Store.open(dir)
  assert.equal(store.state.revision, 0)
  assert.deepEqual(store.state.rooms, [])

  const kept = (await readdir(dir)).filter((name) => name.startsWith('state.json.broken-'))
  assert.equal(kept.length, 1, '坏文件应该改名留档，而不是删掉')
  assert.equal(await readFile(join(dir, kept[0]), 'utf8'), broken)

  // 起得来也写得回去：下一次改动会写出新的 state.json
  store.commit((draft) => {
    createRoom(draft, { name: '坏文件之后的新屋子' })
  })
  await store.flush()
  await store.close()

  const again = await Store.open(dir)
  assert.equal(again.state.rooms.length, 1)
  assert.equal(again.state.rooms[0].name, '坏文件之后的新屋子')
  await again.close()
})

test('版本比自己新的 state.json 不会被当成坏文件吞掉', async () => {
  const dir = await tempDir()
  const file = join(dir, 'state.json')
  const future = JSON.stringify({
    schema: 99,
    revision: 7,
    self: { id: 'me', name: '我' },
    rooms: [],
    bots: [],
    links: [],
    activeRoomId: null,
  })
  await writeFile(file, future, 'utf8')

  // 认不出的形状宁可退出，也不猜 —— 但绝不能把它改名或覆盖掉：
  // 用户可能只是装回了旧版本，降级不该吃掉新版本的数据。
  await assert.rejects(() => Store.open(dir), (error) => error.code === 'unsupported_schema')
  assert.equal(await readFile(file, 'utf8'), future)
  assert.equal((await readdir(dir)).filter((name) => name.includes('.broken-')).length, 0)
})

test('commit 之后不手动 flush 也会自己落盘；落盘不留 tmp', async () => {
  const dir = await tempDir()
  const store = await Store.open(dir)
  store.commit((draft) => {
    createRoom(draft, { name: '自动落盘' })
  })
  // 去抖是 120ms，等它跑完
  await new Promise((resolve) => setTimeout(resolve, 400))

  const raw = await readFile(join(dir, 'state.json'), 'utf8')
  assert.match(raw, /自动落盘/)
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [], 'tmp 应该已经 rename 掉')

  await store.close()
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [])
})

test('连续多次改动只留最后一份完整状态，重开读到的就是最后那份', async () => {
  const dir = await tempDir()
  const store = await Store.open(dir)
  let roomId = null
  for (let index = 0; index < 5; index += 1) {
    store.commit((draft) => {
      if (roomId === null) {
        roomId = createRoom(draft, { name: '连改五次' }).id
      } else {
        updateRoom(draft, { roomId, name: '连改五次 · ' + String(index) })
      }
    })
  }
  await store.flush()
  await store.close()

  const again = await Store.open(dir)
  assert.equal(again.state.revision, 5)
  assert.equal(again.state.rooms.length, 1)
  assert.equal(again.state.rooms[0].name, '连改五次 · 4')
  await again.close()
})
