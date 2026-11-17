# 架构与决策

这份文档只写「为什么这么做」和「下一步怎么接」。代码里的注释写具体实现。

## 1. 一句话架构

```
浏览器（lib/client.js）                Host 进程（src/host/*）
  面板 / 悬浮窗 / 未读         ⇄       房间状态机 · 命令分发 · agent 回合
        │                                     │
        └── connection.rpc.call('/api', ...) ──┴── 原生 Session（每个 agent 一条）
```

浏览器**不持有房间状态**。它只有一份投影（snapshot）和一条长轮询（watch）。
所有写操作都是 `command`。这样「谁的界面都是同一间屋子」由 Host 保证，而不是靠前端对齐。

## 2. 为什么插件必须自包含

第一版 import 了 `@deepseek-ai/dsh-client-connection`（校验信封）和 `@deepseek-ai/dsh-llm`
（`createUserMessage`）。装进 profile 直接失败：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-client-connection'
```

原因：profile 里装的是 `link:D:\Projects\dsh-chatroom`，DSH 的核心包并不在 profile 的
`node_modules` 里（只有 `cosmokit`、`schemastery` 两个），Node 从插件目录向上找不到它们。
**所有能装进 profile 的插件都是零 `@deepseek-ai/*` import 的**（dsh-doudizhu、dsh-holdem 都如此）。

于是把两处形状自己实现了，形状是从 DSH 提取出的源码里核对过的：

- 信封：`{type:'client-request', rpcId:string, method:string, payload:unknown}` → 回 `{type:'server-response', rpcId, result}`。
- 用户消息：`{id, role:'user', content:[{type:'text',text}], source}` —— 与 `createUserMessage` 等价。

## 3. 数据模型

状态是一份整体快照，落在 `<profile>/dsh-chatroom/state.json`（写 tmp 再 rename）。

```js
state = { schema: 1, revision, self: {id:'me', name}, rooms: [Room], bots: [Bot], activeRoomId }

Room    = { id, code, name, topic, ownerId, createdAt, rules, members[], messages[], nextSeq, reads{}, activity }
Member  = { id, kind:'human'|'bot', name, role, botId, sessionId,
            origin:{kind:'local'|'lan', peer, machine}, joinedAt, reach }
Message = { seq, id, at, authorId, authorName, authorKind, text,
            mentions[], replyTo, origin, status:'sent'|'error', opKey }
Rules   = { mention, roundRobin, chairId, maxSpeakers, maxDepth, maxChars }
```

- `revision` 是「有没有变化」的唯一凭据，watch 靠它。
- `seq` 是房间内严格递增游标，客户端的增量与未读都靠它。
- `opKey` 做幂等：同一个 key 重发不会进两遍（网络抖动时的重试安全）。
- `status:'error'` 的占位消息**不进**喂给模型的对话记录，否则模型会看到一堆「某某没回上来」。
- `activity` 是「正在发言」的瞬时状态，也放在状态里，这样一轮结束/失败都能被界面看到。

### @ 由 Host 认，不由客户端认

第一版让客户端算 `mentions` 传上来，测试立刻暴露问题：不传就没人回。
现在 `postMessage` 自己扫正文里的 `@名字`（名字长的先匹配，避免 `A` 吃掉 `Alice`），
再和声明式 mentions 合并。**接口调用方（LAN 机器、curl）没有 UI，事实必须由 Host 认定。**

## 4. Bot 回合：走原生 Session，不另起模型调用

```js
handle = await ctx.agents.create({sessionId, meta:{cwd}, agentOptions:{provider,model}})
agent.followup(userMessage)      // 房间上下文作为一条 user 消息递进去
await agent.whenIdle()
events = await ctx.sessionPersistence.open(sessionId,'read').read(...)
reply  = events.filter(e => e.type==='assistant/message' && !e.data.interrupted).at(-1)
```

换来三件事：

1. **记忆天然存在**：每个 agent 的房间发言就在它自己的会话历史里，关掉 DSH 也还在。
2. **不绕过宿主**：用量、审批、权限都还是 DSH 自己那套。
3. **可重放**：会话里有完整轨迹，出问题能查。

代价：每个 agent 一次发言 = 一次真实模型调用。所以有预算闸门（见 §5）。

`ensureAgent` 的顺序是 `agents.get` → `agents.resume` → `agents.create`，并在进程内缓存
handle。resume 失败（会话没落盘）时回落 create，是预期路径而不是异常路径。

## 5. 三条规则怎么并行

```
一条人消息进来：
  chair 开着   → 主席先上（它的回复里 @ 谁，就继续接给谁）
  mention 开着 → 被 @ 的 agent 各上一次
  roundRobin 开 → 其余所有 agent 依次各上一次
  统一受 maxSpeakers（本条消息最多几个回合）+ maxDepth（agent 接力层数）约束
```

`speak.js` 里是「预算桶」：每驱动一个 agent 扣一格，扣完就停。这是一屋子 agent 不烧钱
的唯一保障；界面上「正在发言 A、B」来自 `activity.speaking`，「停下这一轮」就是 abort。

## 6. LAN（未实现，设计已定）

**角色**：一台当宿主（Host），其余当加入者（Guest）。两边跑同一个插件。

**监听**：`node:http` 起一个 `0.0.0.0:<port>` 的独立服务器（DSH 自己的端口是 loopback + cookie，
不能拿来给局域网）。房间码 `ABC123` 就是凭据，端口 + 码写在面板上，对方输入这两样加入。

**成员归属**：`Member.origin = {kind:'lan', peer: <peerId>}`，并新增 `Member.owner = 'local' | peerId`。

**关键难点：agent 不可能跨机器执行。** 宿主不能替对方的 agent 说话，所以：

```
宿主决定轮到 member M（M.owner = peer P）
  → 不本地跑，改为入队 assignment {id, roomId, memberId, prompt}
  → P 长轮询 /lan/assignments 领到它
  → P 用自己机器上的 session 跑这个 agent（复用 turn.js）
  → P 回传 {assignmentId, text}
  → 宿主校验 assignment 一次性未过期 → 以 M 的身份落库
```

**失败与断线**：assignment 超时（45s）落一条 `status:'error'` 占位；peer 重连用 `since=seq` 补齐；
宿主重启后 assignment 直接作废（宁可丢一轮，不要错乱）。

**安全取舍**：局域网内明文 HTTP + 房间码，不做 TLS、不做账号。这是**设计取舍不是遗漏**：
它的威胁模型是「同一 WiFi 下可信的人」，不是公网。要跨公网得走隧道（参考 dsh-in-hand-relay 的
白名单中继思路），那是另一个决定。

### 接口（宿主侧，房间码鉴权）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/lan/join` | `{code, machine, agents:[{name,role}]}` → `{peerId, snapshot}` |
| GET | `/lan/state?peerId=&since=` | 长轮询，房间投影 |
| POST | `/lan/message` | `{peerId, text, opKey}` → 以该 peer 的人身份发言 |
| GET | `/lan/assignments?peerId=` | 长轮询，领取待执行的 agent 回合 |
| POST | `/lan/reply` | `{peerId, assignmentId, text}` |

## 7. 明确不做的事

- **不复用 dsh-bot**：它的 `peerDependencies` 钉在 `0.2.0-rc.2`，本机是 `0.2.2-rc.1`，
  硬依赖会把插件绑死在一个版本上。自带轻量 Bot 模型（具名/职责/独立 session），语义相同，
  等它进入正式版本再谈适配层。
- **不做账号 / 公网多租户**：这是插件，不是服务。
- **不做附件、撤回、推送、手机端**：先把「一间屋子里把话说完」做扎实。

## 8. 测试策略

| 层 | 怎么测 | 为什么 |
| --- | --- | --- |
| `rooms.js` | 纯函数单元测试（12 用例） | 状态机是唯一会产生「数据错乱」的地方 |
| `plugin.js` + `turn.js` + `speak.js` | 假 ctx 跑真实 `apply()`，假模型（7 用例） | 验证接线：路由、信封、命令、@ 识别、预算、落库顺序 |
| `lib/client.js` | 在 Node 里按真实加载协议装载 + 假 React 桩 | 客户端装错的后果是整页白屏，必须能离线拦住 |
| 真实模型 | 装进 profile 后手动跑一轮 | 只能真跑，没有替代品 |
| 视觉效果 | 真实渲染截图 | 见 README 的验证状态表 |
