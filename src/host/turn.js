import { randomUUID } from 'node:crypto'

/**
 * Bot 回合驱动：把「某个 agent 说一句话」变成一个可等待的函数。
 *
 * 走的是 DSH 自己的原生会话，不是另起一个模型调用：
 *   1. 拿到（或建出）这个 Bot 的原生 Session 对应的 Agent；
 *   2. `agent.followup(createUserMessage(...))` 把房间里的上下文作为一条用户消息递进去；
 *   3. `agent.whenIdle()` 等这一轮跑完；
 *   4. 从会话持久化里读回最后一条 assistant 消息的文本。
 *
 * 这么做换来两件事：每个 Bot 的记忆天然就是它自己的会话历史（关掉 DSH 也在），
 * 以及消息、用量、审批都还归 DSH 自己管——插件不绕过宿主的权限模型。
 */

/**
 * 用户消息的形状与 @deepseek-ai/dsh-llm 的 createUserMessage 完全一致：
 *   { id, role:'user', content:[{type:'text',text}], source }
 * 自己拼而不 import 那个包，理由同 plugin.js 里的信封校验：插件必须自包含。
 */
function userMessage({ content, source }) {
  return { id: randomUUID(), role: 'user', content, source }
}

const textOf = (event) =>
  event?.data?.message?.content
    ?.filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim() ?? ''

const replyOf = (events) =>
  events
    .filter((event) => event.type === 'assistant/message' && !event?.data?.interrupted && textOf(event))
    .at(-1) ?? null

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

export function createBotRunner(ctx, { log = () => {} } = {}) {
  /** sessionId → agent：同一进程里复用，避免每次都 resume。 */
  const agents = new Map()

  function requireService(key) {
    const service = ctx.get?.(key) ?? ctx[key]
    if (!service) fail(`${key}_unavailable`, `DSH 服务 ${key} 不可用，无法让 agent 发言。`)
    return service
  }

  function modelSelection() {
    const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
    try {
      const selection = service?.currentSelection?.()
      if (selection && typeof selection === 'object') return selection
    } catch (error) {
      log('model-selection-failed', error)
    }
    return {}
  }

  async function ensureAgent(bot) {
    const live = agents.get(bot.sessionId)
    if (live) return live
    const registry = requireService('agents')
    const already = registry.get?.(bot.sessionId)
    if (already) {
      agents.set(bot.sessionId, already)
      return already
    }
    const selection = modelSelection()
    const agentOptions = {}
    if (selection.provider) agentOptions.provider = selection.provider
    if (selection.model) agentOptions.model = selection.model
    if (Number.isSafeInteger(selection.maxTokens)) agentOptions.maxTokens = selection.maxTokens
    const meta = { cwd: bot.cwd || defaultCwd() }
    let agent
    try {
      const handle = await registry.resume({ resumeSessionId: bot.sessionId, agentOptions })
      agent = handle.agent ?? handle
    } catch (error) {
      log('resume-missed', error)
      const handle = await registry.create({ sessionId: bot.sessionId, meta, agentOptions })
      agent = handle.agent ?? handle
    }
    agents.set(bot.sessionId, agent)
    return agent
  }

  function defaultCwd() {
    const directory = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
    try {
      if (directory?.defaultDirectory) return directory.defaultDirectory
    } catch {
      /* 取不到就退回进程目录 */
    }
    return process.cwd()
  }

  async function readReply(sessionId) {
    const persistence = requireService('sessionPersistence')
    const handle = await persistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(0, undefined, {})
      return { reply: replyOf(events ?? []), events: events ?? [] }
    } finally {
      await handle.close?.()
    }
  }

  /**
   * 让一个 Bot 说一句话。
   * @returns {Promise<{text: string, sessionId: string}>}
   */
  async function say(bot, prompt, { signal } = {}) {
    const agent = await ensureAgent(bot)
    const message = userMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'dsh-chatroom', botId: bot.id, sessionId: bot.sessionId },
    })
    const before = agent.session?.seq ?? 0
    if (typeof agent.followup === 'function') agent.followup(message)
    else if (typeof agent.prompt === 'function') agent.prompt(message)
    else fail('agent_drive_unsupported', '这个 DSH 版本的 Agent 没有 followup/prompt，无法驱动发言。')

    if (typeof agent.whenIdle === 'function') await agent.whenIdle(signal)
    else await waitStatus(agent, signal)

    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    await sessions?.flush?.(agent.session)

    const { reply } = await readReply(bot.sessionId)
    const text = textOf(reply)
    if (!text) {
      const after = agent.session?.seq ?? 0
      fail('empty_reply', after === before ? '模型这一轮没有产生任何事件。' : '这一轮没有可用的文本回复。')
    }
    return { text, sessionId: bot.sessionId }
  }

  async function waitStatus(agent, signal) {
    for (let i = 0; i < 600; i += 1) {
      if (signal?.aborted) fail('cancelled')
      if (agent.status !== 'running') return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    fail('turn_timeout')
  }

  return { say, ensureAgent, readReply }
}
