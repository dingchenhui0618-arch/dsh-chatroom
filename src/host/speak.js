import { botsOf, getMember, getRoom, isRemoteMember, mentionedBots, postMessage, transcriptOf } from './rooms.js'

/**
 * 三条发言规则并行存在 —— 这就是它们的调度器。
 *
 * 规则不是三选一，而是三个同时生效的开关：
 *   mention   被 @ 的 agent 一定回（永远开的兜底）
 *   chair     有主持人时，先把话交给主持人；主持人回复里 @ 了谁，就继续接给谁
 *   roundRobin 人发言后，所有 agent 依次各说一句（「让全员说一轮」走的也是这条）
 *
 * 三条同时开会撞车，所以有一个总预算：一条人消息最多引出 rules.maxSpeakers
 * 个 agent 回合，agent 之间接力最多 rules.maxDepth 层。预算烧完就停 ——
 * 这是防止一屋子 agent 互相客套把 token 烧光的唯一闸门。
 */

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

/**
 * 派发出去等对面机器时也得能喊停：本机点「停下这一轮」就不要再等。
 * 宿主那边的 assignment 会在超时后自己收尾，所以这里丢下它不会留下半个回合。
 */
function withAbort(promise, signal) {
  if (!signal) return promise
  const aborted = new Promise((_, reject) => {
    const stop = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([promise, aborted])
}

function buildPrompt({ room, bot, at }) {
  const memberLine = room.members
    .map((member) => {
      const kind = member.kind === 'human' ? '人' : 'agent'
      const where = member.origin?.kind === 'lan' ? `，从 LAN 进来（${member.origin.peer ?? '远程'}）` : '，本机'
      const role = member.role ? `，${member.role}` : ''
      return `- ${member.name}（${kind}${role}${where}）`
    })
    .join('\n')
  const transcript = transcriptOf(room, { limit: 24 })
  const rules = []
  if (room.rules.mention) rules.push('被 @ 时回话')
  if (room.rules.roundRobin) rules.push('轮到全员时各说一句')
  if (room.rules.chairId) {
    const chair = getMember(room, room.rules.chairId)
    if (chair) rules.push(`主持人是 ${chair.name}`)
  }
  return [
    `你正在 DeepSeek Harness 的一间群聊房间里，以「${bot.name}」的身份参与对话。`,
    bot.role ? `你的职责：${bot.role}` : '',
    '',
    `房间：${room.name}${room.topic ? `\n主题：${room.topic}` : ''}`,
    '成员：',
    memberLine,
    '',
    rules.length ? `房间规则：${rules.join('；')}` : '',
    '',
    '最近的对话（#序号 作者：内容）：',
    transcript || '（还没有人说话）',
    '',
    at === 'chair'
      ? '现在轮到你这个主持人发言：先把大家的分歧点出来，给出你的判断；需要谁补充，就在话里 @ 他的名字。'
      : at === 'round'
        ? '现在轮到你发言：就上面的话题说你自己的看法，可以顺着别人的话补充或反驳。'
        : '现在轮到你了：回应上面提到你或与你有关的内容。',
    `要求：中文；不超过 ${room.rules.maxChars} 字；只输出你要说的那段话本身，不要前缀、不要解释、不要「作为 X」这类元信息。`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function createSpeaker({ store, runner, dispatchRemote = null, log = () => {} }) {
  const running = new Set()
  const aborts = new Map()

  function roomOrFail(roomId) {
    const room = store.inspect((state) => getRoom(state, roomId))
    if (!room) fail('room_not_found')
    return room
  }

  function setActivity(roomId, patch) {
    store.commit((state) => {
      const room = getRoom(state, roomId)
      if (!room) return
      room.activity = patch === null ? null : { ...(room.activity ?? {}), ...patch }
    })
  }

  async function speakOne({ roomId, botId, at, depth, budget }) {
    if (budget.left <= 0) return
    const room = roomOrFail(roomId)
    const bot = getMember(room, botId)
    if (!bot || bot.kind !== 'bot') return
    // 远程 agent 的目录不在本机：它的 session、模型、记忆都在它自己那台机器上，
    // 本机只负责「这一轮轮到你了」把 prompt 派过去。
    const remote = isRemoteMember(bot)
    const directoryBot = remote ? null : store.inspect((state) => state.bots.find((row) => row.id === bot.botId))
    if (!remote && !directoryBot) {
      log('bot_missing', botId)
      return
    }
    budget.left -= 1
    setActivity(roomId, { speaking: [...(store.inspect((state) => getRoom(state, roomId)?.activity?.speaking) ?? []), bot.name] })
    const controller = new AbortController()
    aborts.set(roomId, controller)
    try {
      const prompt = buildPrompt({ room: roomOrFail(roomId), bot, at })
      let text
      if (remote) {
        if (typeof dispatchRemote !== 'function') {
          fail('lan_unavailable', '这台机器没有连上局域网，无法请远程 agent 发言。')
        }
        const result = await withAbort(
          dispatchRemote({ roomId, member: bot, prompt, signal: controller.signal }),
          controller.signal,
        )
        text = result?.text
      } else {
        text = (await runner.say({ ...directoryBot, cwd: directoryBot.cwd ?? undefined }, prompt, { signal: controller.signal })).text
      }
      complete(roomId, directoryBot, botId, text)
      const fresh = roomOrFail(roomId)
      const created = fresh.messages.at(-1)
      if (depth < fresh.rules.maxDepth && budget.left > 0) {
        for (const target of mentionedBots(fresh, created)) {
          if (budget.left <= 0) break
          await speakOne({ roomId, botId: target.id, at: 'mention', depth: depth + 1, budget })
        }
      }
    } catch (error) {
      log('bot_turn_failed', { botId, error })
      store.commit((state) => {
        const room = getRoom(state, roomId)
        const directory = state.bots.find((row) => row.id === bot.botId)
        if (directory) directory.lastError = String(error?.code ?? error?.message ?? error).slice(0, 200)
        if (!room) return
        postMessage(state, {
          roomId,
          authorId: botId,
          text: `（${bot.name} 这次没回上来：${String(error?.code ?? error?.message ?? error).slice(0, 120)}）`,
          status: 'error',
        })
      })
    } finally {
      aborts.delete(roomId)
      const speaking = store.inspect((state) => getRoom(state, roomId)?.activity?.speaking ?? [])
      const rest = speaking.filter((name) => name !== bot.name)
      if (rest.length) setActivity(roomId, { speaking: rest })
    }
  }

  function complete(roomId, directoryBot, memberId, text) {
    store.commit((state) => {
      const room = getRoom(state, roomId)
      if (!room) return
      if (directoryBot) {
        directoryBot.lastSpokeAt = new Date().toISOString()
        if (state.bots.includes(directoryBot)) directoryBot.lastError = null
      }
      // 不传 origin：postMessage 会用发言人自己的 origin，远程 agent 的话不会被标成本机。
      postMessage(state, { roomId, authorId: memberId, text })
    })
  }

  /** 收尾：把 room.activity 归零。 */
  function settle(roomId) {
    setActivity(roomId, null)
    running.delete(roomId)
  }

  /**
   * 一条人消息进来后，按当前规则决定谁说话。
   * 不 await：房间面板先看到人那条，agent 的回复随 watch 一帧一帧出现。
   */
  function afterHumanMessage({ roomId, messageId }) {
    if (running.has(roomId)) return
    const room = roomOrFail(roomId)
    const message = room.messages.find((row) => row.id === messageId)
    if (!message) return
    const rules = room.rules
    const queue = []
    const push = (member) => {
      if (member && member.kind === 'bot' && !queue.some((row) => row.id === member.id)) queue.push(member)
    }
    if (rules.chairId) push(getMember(room, rules.chairId))
    if (rules.mention) for (const member of mentionedBots(room, message)) push(member)
    if (rules.roundRobin) for (const member of botsOf(room)) push(member)
    if (!queue.length) return
    void run(roomId, queue, { kind: rules.chairId && queue[0]?.id === rules.chairId ? 'chair' : 'mention' })
  }

  /** 「让全员说一轮」：不看 @，所有 agent 依次各说一句。 */
  function runRound({ roomId }) {
    const room = roomOrFail(roomId)
    const queue = botsOf(room)
    if (!queue.length) fail('no_agents')
    return run(roomId, queue, { kind: 'round' }, true)
  }

  /** 某条 agent 回复失败后重来一次 —— 只重跑那一个 agent，不惊动别人。 */
  function retryBot({ roomId, memberId }) {
    const room = roomOrFail(roomId)
    const member = getMember(room, memberId)
    if (!member || member.kind !== 'bot') fail('not_agent_message')
    return run(roomId, [member], { kind: 'round' }, true)
  }

  function run(roomId, queue, { kind }, awaitIt = false) {
    if (running.has(roomId)) fail('room_busy', '这间屋子正在发言，等这一轮结束。')
    running.add(roomId)
    setActivity(roomId, { speaking: [], kind, startedAt: new Date().toISOString() })
    const budget = { left: Math.max(1, roomOrFail(roomId).rules.maxSpeakers) }
    const task = (async () => {
      try {
        for (const [index, member] of queue.entries()) {
          if (budget.left <= 0) break
          await speakOne({ roomId, botId: member.id, at: index === 0 ? kind : 'round', depth: 0, budget })
        }
      } finally {
        settle(roomId)
      }
    })().catch((error) => {
      log('round_failed', { roomId, error })
      settle(roomId)
    })
    return awaitIt ? task : task
  }

  function stop(roomId) {
    aborts.get(roomId)?.abort()
    settle(roomId)
  }

  return { afterHumanMessage, runRound, retryBot, stop, buildPrompt }
}
