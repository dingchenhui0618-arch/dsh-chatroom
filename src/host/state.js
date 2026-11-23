import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { freeWhale, isWhaleColor } from './palette.js'

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
    // 人本身不带颜色：虎鲸的色是「在这间屋里坐哪一档」，存在 room.members 上。
    self: { id: 'me', name: '我' },
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
  // 虎鲸颜色是后加的，而且一开始是「身份」：存在 self 与 bots 上，再映到屋里。
  // 现在它改成「每间屋里的一个座位」：真源只有 room.members[].color。
  // 这两处旧字段留着只会变成第二个真相（改了一处另一处不动），所以读进来就抹掉。
  delete value.self.color
  delete value.self.colorPicked
  for (const bot of value.bots) {
    if (!bot) continue
    delete bot.color
    delete bot.colorPicked
  }
  for (const room of value.rooms) {
    if (!room || !Array.isArray(room.members)) continue
    const used = new Set()
    for (const member of room.members) {
      if (!member) continue
      // 老存档里的成员色是上一个版本写的，认得就照原样留着 —— 那是当时的选择。
      // 认不出来（更老的存档、手改过的 state.json）才按屋里第几个铺一种，
      // 一屋子人不会全是同一个色。
      if (!isWhaleColor(member.color)) member.color = freeWhale(used)
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
