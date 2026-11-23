import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_WHALE, freeWhale, isWhaleColor } from './palette.js'

/**
 * 持久化状态。
 *
 * 为什么是自己写一个 JSON 文件、而不是用 ctx.storage 的 kv：
 * 房间状态是一份整体快照（房间 + 成员 + 消息 + 未读游标），读写都是全量，
 * 用 kv 反而要自己拼表。文件放在 profile 目录下
 * （`<profile>/dsh-chatroom/state.json`），profile 备份/迁移会一起带走。
 *
 * 原子性：先写 `state.json.tmp` 再 rename —— Windows 上 rename 覆盖是原子的，
 * 断电最多留一个 tmp，不会写出半个 state.json。
 */

export const SCHEMA = 1

/** 一个全新的状态。self 代表坐在键盘前的这个人。 */
export function emptyState() {
  return {
    schema: SCHEMA,
    revision: 0,
    createdAt: new Date().toISOString(),
    self: { id: 'me', name: '我', color: DEFAULT_WHALE, colorPicked: false },
    // 本机授权：另一台机器派过来的回合要不要执行。三档见 guard.js。
    // 默认只读 —— 新装的机器不替别人的话动本机的工具权限。
    auth: { level: 'readonly' },
    rooms: [],
    bots: [],
    // 加入过的局域网房间。宿主那边的 peerId 每次握手都换，所以这里只留
    // 「连哪里、用哪个房间码」——重启后拿它重新握手，而不是沿用旧身份。
    links: [],
    activeRoomId: null,
  }
}

/** 只认自己认识的形状；坏文件宁可退出也不猜。 */
export function validateState(value) {
  const fail = (code) => {
    throw Object.assign(new Error(code), { code })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed_state')
  if (value.schema !== SCHEMA) fail('unsupported_schema')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) fail('malformed_state')
  if (!value.self || typeof value.self.name !== 'string') fail('malformed_state')
  if (!Array.isArray(value.rooms) || !Array.isArray(value.bots)) fail('malformed_state')
  // links 是后加的字段：旧 state.json 没有它，读成空数组即可，不必升 schema。
  if (value.links === undefined) value.links = []
  if (!Array.isArray(value.links)) fail('malformed_state')
  // auth 也是后加的：老 state.json 没有它，按最保守的「只读」补上，绝不默认放行。
  if (value.auth === undefined || value.auth === null || typeof value.auth !== 'object') {
    value.auth = { level: 'readonly' }
  }
  if (!['readonly', 'ask', 'full'].includes(value.auth.level)) value.auth.level = 'readonly'
  // 虎鲸颜色也是后加的：老 state.json 里没有它。这里一次补齐三处 ——
  // self、bots、以及屋里的成员。成员的色按「它属于谁」接回去（agent 跟 agent 走，
  // 本机的人跟 self 走），认不出来的才按屋里第几个铺一种，一屋子人不会全是同一个色。
  if (!isWhaleColor(value.self.color)) value.self.color = DEFAULT_WHALE
  // colorPicked = 「这一档是人自己点的」。没点过的默认色进屋时可以被宿主换成
  // 屋里还没人用的那一档（见 lan-host 的 roomColor）；点过的就照他点的来。
  value.self.colorPicked = value.self.colorPicked === true
  // agent 的颜色也按「本机已经用掉哪些」铺：第一个 agent 不会和人撞成同一个色。
  const mine = new Set([value.self.color])
  value.bots.forEach((bot) => {
    if (!bot) return
    if (!isWhaleColor(bot.color)) bot.color = freeWhale(mine)
    bot.colorPicked = bot.colorPicked === true
    mine.add(bot.color)
  })
  for (const room of value.rooms) {
    if (!room || !Array.isArray(room.members)) continue
    const used = new Set()
    for (const member of room.members) {
      if (!member) continue
      const bot = member.botId ? value.bots.find((row) => row.id === member.botId) : null
      if (!isWhaleColor(member.color)) {
        if (bot) member.color = bot.color
        else if (member.kind === 'human' && member.id === value.self.id) member.color = value.self.color
        else member.color = freeWhale(used)
      }
      used.add(member.color)
    }
  }
  return value
}

export class Store {
  #file
  #state
  #listeners = new Set()
  #timer = null
  #saving = null
  #closed = false

  constructor(file, state) {
    this.#file = file
    this.#state = state
  }

  static async open(dir) {
    const file = join(dir, 'state.json')
    await mkdir(dir, { recursive: true })
    let state
    try {
      const raw = await readFile(file, 'utf8')
      state = validateState(JSON.parse(raw))
    } catch (error) {
      if (error && error.code === 'ENOENT') state = emptyState()
      else if (error instanceof SyntaxError) {
        // 坏文件不静默丢弃：改名留档，再从空状态起步，用户还能自己捞回来。
        await rename(file, `${file}.broken-${Date.now()}`).catch(() => {})
        state = emptyState()
      } else throw error
    }
    return new Store(file, state)
  }

  get state() {
    return this.#state
  }

  /** 每次真正改动状态后调用：revision +1 是给客户端做「有没有变化」的唯一凭据。 */
  commit(mutate) {
    if (this.#closed) throw Object.assign(new Error('closed'), { code: 'closed' })
    const before = this.#state.revision
    const result = mutate(this.#state)
    this.#state.revision = before + 1
    this.#scheduleSave()
    for (const listener of this.#listeners) {
      try {
        listener(this.#state.revision)
      } catch {
        /* 监听器自己的错误不该破坏写入 */
      }
    }
    return result
  }

  /** 只读事务：不改 revision、不落盘。 */
  inspect(read) {
    return read(this.#state)
  }

  /**
   * 叫醒等着的界面：有新情况（有人要本机授权），但状态本身没变。
   *
   * 授权队列只活在内存里，不写 state.json —— 一条待授权是「此刻」的事，
   * 重启之后那个回合早就不在了，落盘只会让界面重启后挂着一张点不动的卡片。
   * 但客户端的 watch 只认 revision，所以这里把 revision 推一格：不落盘、
   * 不触发保存，纯粹是给长轮询一个「现在去看看」的信号。
   */
  notify() {
    if (this.#closed) return
    this.#state.revision += 1
    for (const listener of this.#listeners) {
      try {
        listener(this.#state.revision)
      } catch {
        /* 监听器自己的错误不该破坏通知 */
      }
    }
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #scheduleSave() {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#save()
    }, 120)
    this.#timer.unref?.()
  }

  async flush() {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    await this.#save()
  }

  #save() {
    // 串行化写入：后一次一定读到前一次的结果。
    const run = async () => {
      const body = JSON.stringify(this.#state, null, 2)
      const tmp = `${this.#file}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, this.#file)
    }
    const next = (this.#saving ?? Promise.resolve()).then(run, run)
    this.#saving = next.catch(() => {})
    return next
  }

  async close() {
    this.#closed = true
    for (const listener of this.#listeners) void listener
    this.#listeners.clear()
    await this.flush()
    await this.#saving?.catch(() => {})
  }
}

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`

/** 房间码：去掉容易看错的 0/O/1/I，6 位，念得出来、抄得下来。 */
export function newRoomCode(taken = new Set()) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = ''
    for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)]
    if (!taken.has(code)) return code
  }
  return randomUUID().slice(0, 6).toUpperCase()
}
