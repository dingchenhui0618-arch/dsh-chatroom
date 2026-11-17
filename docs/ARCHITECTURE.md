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
state = { schema: 1, revision, self: {id:'me', name}, rooms: [Room], bots: [Bot],
          links: [Link], activeRoomId }

Room    = { id, code, name, topic, ownerId, createdAt, rules, members[], messages[],
            nextSeq, reads{}, activity, remote? }
Member  = { id, kind:'human'|'bot', name, role, botId, sessionId,
            owner:'local'|peerId, origin:{kind:'local'|'lan', peer, machine},
            joinedAt, reach }
Message = { seq, id, at, authorId, authorName, authorKind, text,
            mentions[], replyTo, origin, status:'sent'|'error', opKey }
Link    = { id, host, port, code, peerId, hostMachine, roomId, localRoomId,
            selfMemberId, machine, status, error }   // 加入别人屋子时的那条连接
Rules   = { mention, roundRobin, chairId, maxSpeakers, maxDepth, maxChars }
```

- `revision` 是「有没有变化」的唯一凭据，watch 靠它。
- `seq` 是房间内严格递增游标，客户端的增量与未读都靠它。
- `opKey` 做幂等：同一个 key 重发不会进两遍（网络抖动时的重试安全）。
- `status:'error'` 的占位消息**不进**喂给模型的对话记录，否则模型会看到一堆「某某没回上来」。
- `activity` 是「正在发言」的瞬时状态，也放在状态里，这样一轮结束/失败都能被界面看到。
- `owner` 是「这个成员由哪台机器负责」。`'local'` = 本机驱动；`peerId` = 它的人和 agent
  都在那台机器上，本机不能替它说话。
- `remote` 非空的房间是**镜像**：状态由宿主同步过来，本地只读，写操作转发出去。

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

预算之外还有两条不变式（一轮一个作用域的 `spoke` 集合 + 一个 `pending` 队列）：

- **一轮之内同一个人只说一次**。`chair` 的接力、`mention` 的队列、`roundRobin` 的全员队列
  会指向同一个人，`spoke` 让后到的那次直接跳过 —— 否则这个人说两句、吃掉两份预算，
  排在后面的人永远轮不到，「全员一轮」就只剩名字。
- **发言中人插的话不丢**。`afterHumanMessage` 撞到 `running` 时把 messageId 存进 `pending`，
  这一轮自然收尾（`settle({ drain: true })`）时按同一条路径重新调度。点「停下这一轮」则清空
  `pending` —— 停了就不该立刻又开一轮。

收尾用 `epochs`（roomId → 本轮 token）区分「收尾的是不是我」：用户停下后旧回合姗姗来迟，
不能把已经接手的新回合一起收掉。

## 6. LAN：两台机器进同一间屋子

**角色**：一台当宿主（Host），其余当加入者（Guest）。两边跑同一个插件。

**监听**：`node:http` 起一个 `0.0.0.0:<port>`（默认 4399，`DSH_CHATROOM_PORT` 可改）的独立服务器。
DSH 自己的端口是 loopback + cookie + 每进程随机 token，**不能**拿来给局域网用。房间码就是凭据。

**为什么宿主不能直接跑对方的 agent**：agent 的 session、模型选择、记忆都在它自己那台机器上。
所以「轮到谁 → 在哪跑」必须分开：

```
宿主决定轮到 member M（M.owner = peer P）
  → 不本地跑，改为入队 assignment {id, roomId, memberId, agentId, prompt}
  → P 长轮询 /lan/assignments 领走它（一次性领取，不重复派发）
  → P 用自己机器上的原生 session 跑这个 agent（复用 turn.js）
  → P 回传 {assignmentId, text}
  → 宿主校验「是我的、还没被用掉」→ 以 M 的身份落库（origin 仍是 lan）
```

`speak.js` 里就一处分支：`isRemoteMember(bot)` 走 `dispatchRemote`，否则走 `runner.say`。
三条规则的排队、预算闸门、失败占位**两边共用同一套**，不因为远程多一条路径。

**加入方的镜像**：加入方把宿主的房间投影**映**到自己 state 里（`room.remote` 非空），
写操作全部转发（`msg.send` / `read.mark` / `self.rename`），规则与成员类操作直接拒绝（`remote_room`）。
镜像要处理三件容易错的事：

1. **视角翻转**：宿主眼里的「本机」在加入方是「远程」，反之亦然。否则两边都以为自己是本地。
2. **self 撞名**：两边自己的人 id 都是 `'me'`。镜像里只留一个 `'me'`（我的），
   宿主的 `'me'` 换成 `host_xxxxxx`，否则消息会被认成「我发的」。
3. **未读归属**：宿主的投影按 `viewerId`（这个 peer 的人）算未读，随投影一起带过来；
   加入方不本地重算 —— 它没有宿主的 reads 表，重算只会得到「全都没读」。

**失败与断线**：assignment 超时（45s，测试可用 `DSH_CHATROOM_ASSIGN_TIMEOUT` 压短）落一条
`status:'error'` 占位。

「这台机器还在不在」不能只看 `lastSeen`，有两种沉默但活着的情况：长轮询正挂着（25s 内不发下一个请求），
以及正在跑模型（几十秒不轮询）。所以存活判定是 `inflight > 0 || 有未结束的 assignment || lastSeen < idle`：

- 长轮询在飞时 `inflight` 记数，且请求一断（关窗口 / 进程被杀）就立刻醒，不再空等 25s；
- 宿主每 `idle/3`（≤15s）扫一次，真的掉线的机器整组成员撤掉；
- 加入方任何一次转发撞上 `peer_unknown` 就自己重新握手再来一次（并发去重，只握一次）；
  进程重启时 `state.links` 由 `resume()` 接回；
- 宿主解散房间后，加入方投影里就没有那间屋了。此时镜像不删，改成墓碑（`room.remote.lost`），
  输入锁住、只留「从列表移除」——否则用户会卡在一个发不出话也退不出的房间里。

**安全取舍**：局域网内明文 HTTP + 房间码，不做 TLS、不做账号。这是**设计取舍不是遗漏**：
威胁模型是「同一 WiFi 下可信的人」，不是公网。peerId 是一次握手的随机凭据，
除 `/lan/join`（需要房间码）与 `/lan/ping` 外，所有端点都要求它。

### 接口（宿主侧，房间码鉴权）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/lan/join` | `{code, machine, self, agents}` → `{peerId, selfMemberId, snapshot}` |
| GET | `/lan/state?peerId=&since=` | 长轮询（25s），房间投影 + revision |
| POST | `/lan/message` | `{peerId, text, opKey}` → 以该 peer 的人身份发言，回投影 |
| GET | `/lan/assignments?peerId=` | 长轮询（25s），领取一条待执行的 agent 回合 |
| POST | `/lan/reply` | `{peerId, assignmentId, text\|error}` |
| POST | `/lan/read` | `{peerId, seq}` → 标记已读，回投影（避免旧快照把未读闪回来） |
| POST | `/lan/self` | `{peerId, name}` → 改这个 peer 的人名 |
| POST | `/lan/leave` | `{peerId}` → 撤掉它的人和 agent |
| GET | `/lan/ping` | 无鉴权，只回答「这台机器在不在监听」 |

**请求面的铁律**：这个口对同网段所有人开着，所以「坏包不许把进程带走」是硬要求，不是讲究。

- 解析请求地址时**不看 `Host` 头**（base 写死）：Host 完全由对方决定，`Host: [` 就会让
  `new URL` 抛 `ERR_INVALID_URL`。origin-form 的请求本来也不需要 Host。
- 请求行确实没法解析（如 `GET http://[`）→ 明确回 400，不是挂住。
- 处理函数外面再包一层：`route()` 的同步异常和 promise 拒绝都在最外层收住并回 500。
  漏出去的异常就是未处理的拒绝，Node 按未捕获异常处理 → **整个 DSH 进程退出**。
- `MAX_BODY`（256 KB）在声明与实收两处都查；非 JSON → 400；未知路径 → 404。

## 7. 明确不做的事

- **不复用 dsh-bot**：它的 `peerDependencies` 钉在 `0.2.0-rc.2`，本机是 `0.2.2-rc.1`，
  硬依赖会把插件绑死在一个版本上。自带轻量 Bot 模型（具名/职责/独立 session），语义相同，
  等它进入正式版本再谈适配层。
- **不做账号 / 公网多租户**：这是插件，不是服务。跨公网要走隧道（白名单中继），另做决定。
- **不做附件、撤回、推送、手机端**：先把「一间屋子里把话说完」做扎实。

## 8. 测试策略

| 层 | 怎么测 | 为什么 |
| --- | --- | --- |
| `rooms.js` | 纯函数单元测试（12 用例） | 状态机是唯一会产生「数据错乱」的地方 |
| `plugin.js` + `turn.js` + `speak.js` | 假 ctx 跑真实 `apply()`，假模型（9 用例） | 验证接线：路由、信封、命令、@ 识别、预算、一轮内不重复、插话不丢、落库顺序 |
| LAN（宿主 + 加入者） | 两个独立实例各起 `node:http`，互相走真实 `/lan/*`（8 用例） | 跨机器这条路没法用单测假装：真 HTTP、真鉴权、真派发、真超时 |
| LAN 请求面抗坏包 | 直接往 socket 灌字节：畸形 `Host`、非法请求行、超大 `Content-Length`、非 JSON、未知路径（3 用例） | 这个口对同网段开着，而漏出去的异常会把宿主进程带走 —— 这类缺陷只有「真发包 + 断言进程还活着」才测得出来 |
| 三台机器同屋 | 三个独立实例：宿主 + 两台加入方，各自带 agent（4 用例） | 两方时归属不可能搞错，三方才会暴露「A 的话在 B 那边被标成本机」这类串台；顺便验一轮里预算正好用满、只派给该派的那台，以及主席在远程时它 @ 到的第三台机器能接上 |
| `lib/client.js` | 在 Node 里按真实加载协议装载 + 假 React 桩 | 客户端装错的后果是整页白屏，必须能离线拦住 |
| 悬浮窗位置 | 真实渲染里存一个越界坐标重开页面、拖到 9999×9999、再把窗口改到 1024×700，三处都断言浮窗仍在视口内 | 坐标是能记住的东西，但「记住」和「点得到」是两件事：窗口一变，旧坐标就变成一块抓不住的浮窗 |
| `package.json` / `icon.svg` / `locale` | 清单自洽（4 用例）：图标能渲染、中英描述齐全、`files` 与 `exports` 对得上、`lib` 与 `src` 里零 `@deepseek-ai/*` 引用 | 这几条错了不会在本机报错，只会在别人的 profile 里炸，或者让插件管理页显示成默认图 + 包名 |
| 真实模型 | 装进 profile 后从局域网 peer 身份发一句 @，读回真回复 | 只能真跑，没有替代品 |
| 视觉效果 | 真实渲染截图（两个进程的 LAN、以及第三台机器按需加入的那张都在里面） | 见 README 的验证状态表 |
| 三台机器同屋的界面 | 真实渲染里让第三个进程加入，断言消息行/成员列的来源标到具体机器名、本机成员一个 LAN 标都没有 | 「多人」不只是协议能通：两台远程机器如果都显示成「LAN」，用户照样分不清谁是谁 |
