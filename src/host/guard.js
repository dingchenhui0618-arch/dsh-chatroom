import { newId } from './state.js'

/**
 * 本机授权：另一台机器（或那台机器上的人/agent）让这台机器跑一个 agent 回合时，
 * 先问这台机器的人一句。
 *
 * 由来：房间里任何能触发派发的人，实际上都能驱动一台**拥有本机工具权限**的 agent。
 * 「被 @ 必回」这条规则让这件事变得顺手 —— 顺手到没人意识到自己在请求别人的机器执行。
 * 所以三个档位，默认最保守的那一档：
 *
 *   readonly  只读：别处的指挥一律不执行，只回一句话说明为什么（默认）
 *   ask       授权后执行：弹一个窗口问本机的人，这一次允许才跑
 *   full      完全授权：直接跑（还是本机自己的 agent、自己的会话，只是不问）
 *
 * 三条硬规矩：
 *   · **默认只读**：不确认就什么都不跑。新装的机器不该替别人的话动工具权限。
 *   · **fail closed**：拒绝、超时、循环被停、插件被关，一律按「不执行」收尾。
 *   · **只拦非本机的指挥**：本机的人自己 @ 自己的 agent 不问 —— 否则每句话都要点一次。
 *
 * 待授权队列只在内存里：它描述的是「此刻有一个回合在等人点按钮」，
 * 重启后那个回合早没了，落盘只会留下点不动的卡片。界面靠 store.notify() 被唤醒。
 */

export const LEVELS = ['readonly', 'ask', 'full']
export const DEFAULT_LEVEL = 'readonly'

/** 卡片里最多展示多少字原文：够看清对方要它做什么，又不至于把一行正文塞爆。 */
const PROMPT_SHOWN = 2000

export function normalizeLevel(value) {
  return LEVELS.includes(value) ? value : DEFAULT_LEVEL
}

/**
 * 「多久没人点就按拒绝」。
 *
 * 90 秒是「人就在电脑前、但手上正在做别的事」的量级。太短会误拒（人刚走开泡杯茶），
 * 太长会让对面那台机器的一轮卡上好几分钟。可用 DSH_CHATROOM_APPROVAL_MS 覆盖，
 * 测试与截图就是靠它把窗口压到几百毫秒。
 */
function approvalTimeout() {
  const raw = Number(process.env.DSH_CHATROOM_APPROVAL_MS)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 90_000
}

export function createGate({ store, notify = () => {}, log = () => {} } = {}) {
  /** id → 定下来之前的行；这条 Map 就是「此刻屏幕上那张卡」。 */
  const pending = new Map()
  let closed = false

  const level = () => normalizeLevel(store.state.auth?.level)

  function setLevel(next) {
    const value = normalizeLevel(next)
    store.commit((draft) => {
      draft.auth = { ...(draft.auth ?? {}), level: value }
    })
    // 改成「只读」时，还挂着的待授权就没有意义了：它们是在旧档位下问的。
    // 按拒绝收尾，而不是让它们悬在那儿等一个已经变了的答案。
    if (value === 'readonly') {
      for (const row of [...pending.values()]) finish(row, false, 'readonly')
    }
    log('auth_level', { level: value })
    return value
  }

  /** 给界面的公开形状：谁、在哪间屋、要让哪个 agent 做什么。 */
  function publicOf(row) {
    return {
      id: row.id,
      roomId: row.roomId,
      roomName: row.roomName,
      agentName: row.agentName,
      fromName: row.from?.name ?? '',
      fromMachine: row.from?.machine ?? '',
      fromKind: row.from?.kind === 'bot' ? 'bot' : 'human',
      asked: row.from?.text ?? '',
      prompt: row.prompt.slice(0, PROMPT_SHOWN),
      createdAt: row.createdAt,
      deadline: row.deadline,
      level: row.level,
    }
  }

  function list() {
    return [...pending.values()].map(publicOf)
  }

  function finish(row, allow, reason) {
    if (!row || row.settled) return false
    row.settled = true
    if (row.timer) clearTimeout(row.timer)
    row.signal?.removeEventListener?.('abort', row.onAbort)
    pending.delete(row.id)
    notify()
    row.resolve({ ok: allow, reason })
    return true
  }

  /**
   * 问一句「这个回合让不让跑」。返回 {ok, reason}：
   *   full → ok:true / readonly → ok:false / ask → 等人点按钮、超时或回合被停。
   */
  async function check({ roomId = null, roomName = '', agentName = '', prompt = '', from = null, signal = null } = {}) {
    if (closed) return { ok: false, reason: 'closed' }
    const at = level()
    if (at === 'full') return { ok: true, reason: 'full' }
    if (at === 'readonly') return { ok: false, reason: 'readonly' }
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }

    const row = {
      id: newId('ap'),
      roomId,
      roomName: String(roomName ?? '').slice(0, 80),
      agentName: String(agentName ?? '').slice(0, 60),
      prompt: String(prompt ?? ''),
      from: from
        ? {
            name: String(from.name ?? '').slice(0, 60),
            machine: String(from.machine ?? '').slice(0, 60),
            kind: from.kind === 'bot' ? 'bot' : 'human',
            text: String(from.text ?? '').slice(0, 400),
          }
        : null,
      createdAt: new Date().toISOString(),
      deadline: Date.now() + approvalTimeout(),
      level: at,
      settled: false,
      signal,
      onAbort: null,
      timer: null,
      resolve: null,
    }
    const verdict = new Promise((resolve) => {
      row.resolve = resolve
    })
    pending.set(row.id, row)
    row.timer = setTimeout(() => finish(row, false, 'timeout'), approvalTimeout())
    row.timer.unref?.()
    // 「停下这一轮」或屋子被解散：这张卡对应的一轮已经结束，留着只会让人点一个没有去处的按钮。
    row.onAbort = () => finish(row, false, 'cancelled')
    signal?.addEventListener?.('abort', row.onAbort, { once: true })
    notify()
    log('approval_waiting', { id: row.id, roomId, agentName, from: row.from?.name ?? null })

    const decided = await verdict
    log(decided.ok ? 'approval_granted' : 'approval_declined', { id: row.id, reason: decided.reason })
    return decided
  }

  /** 界面上点了「允许一次」/「拒绝」。找不到（别人已经点过、或已超时）返回 null。 */
  function answer({ id, allow } = {}) {
    const row = pending.get(String(id ?? ''))
    if (!row) return null
    const value = Boolean(allow)
    finish(row, value, value ? 'allowed' : 'denied')
    return { id: row.id, allow: value }
  }

  function dispose() {
    closed = true
    for (const row of [...pending.values()]) finish(row, false, 'closed')
  }

  return { level, setLevel, list, check, answer, dispose, pendingCount: () => pending.size, waitMs: approvalTimeout }
}
