import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
    self: { id: 'me', name: '我' },
    rooms: [],
    bots: [],
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
