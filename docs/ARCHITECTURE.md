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

**客户端怎么把信封递给宿主**：优先走客户端连接服务
`ctx.connection.rpc.call('/api', 'dsh.chatroom/<端点>', payload, signal)`。但连接服务在不同版本上
挂的位置不一样（`ctx.connection` 属性 / `ctx.get('connection')`），也不保证每个组合里都取得到，
所以取不到时回落到**同源 POST `/api/dsh.chatroom/<端点>`**，把同一个信封递过去：浏览器自带
Cookie 鉴权，宿主侧看到的东西一模一样。同宿主里别的客户端插件走的就是这条路
（dsh-doudizhu 直接 `fetch('/api/dsh-doudizhu/state')`）。少一个服务不该让整个面板停摆。

插槽这半边同样要在真机上核对：Client Inspect 直接查运行中的页面，四个 slot 里都能看到
`dsh-chatroom` 的登记（id / order / `active: true`），用的 5 个主题变量在当前主题里都存在。
但「注册上了」和「用户看到什么样」是两件事 —— 前者用 Inspect 证明，后者只有 `docs/` 里的
真实渲染截图能证明。

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
- **`bots` 是 agent 本身，成员是它在某一间屋子里的身份**。名字与职责属于 `Bot`（`bot.update`），
  所以改一次，它在所有屋子里的成员行一起换；历史消息保留当时的 `authorName`，
  `@` 认的是成员**当前**名字。远程成员的 `Bot` 在别人那台机器上，本机不提供编辑入口。

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

**读回来的最后一句未必属于这一轮**。`replyOf` 取的是会话里最后一句有文本、且没被标成
interrupted 的 assistant 消息；用户点「停下这一轮」、或者模型这一轮只调了工具没出文本时，
会话里根本没有新台词，读回来的还是上一轮那句。所以 `say` 在开跑前记一条基线
（这个会话上次真正发进房间的回复 id，进程重启后第一次从会话里读），跑完发现最后一句
还是基线那条，就按 `empty_reply` 收尾 —— 房间里落一句「某某这次没回上来」，
而不是把旧台词再发一遍。否则看起来像它又说了一句，实际是重复，还白占一格发言预算。

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
- **重新握手带 `instance`（就是那条 link 的 id，落盘的）**：宿主遇到同一间屋里已经有一个
  `instance` 相同的 peer，就把旧那组的成员**接过来**（`owner` 换成新 peerId，成员 id 不动），
  而不是撤掉再建一套。id 不动是有意的：已读游标（`reads` 按成员 id 记）、`@` 里的成员 id、
  历史消息的 `authorId` 都还连着 —— 重启之后自己过去说的话还是自己说的，也不会把整段历史
  重新标成未读。名字以这次上报为准，机器名/地址跟着更新。没有这一步的话，「加入方自己重启
  桌面端」会在屋里留下两个同名的他，旧那组得等 `idle`（45s）才被扫掉，而这段时间里 @ 到
  旧的那个必然超时（那台机器已经不在了）。旧版本加入方不带这个字段，行为退回「等清扫」，
  不会因此连不进来；
- **重启那一刻正交在它手上的那一轮也换主人**：远程 agent 的回合是「那台机器用自己的 session
  跑完回传」，重启打断了那次运行，但宿主的派发还挂在上一条 `peerId` 上。接手时把这些未完成的
  派发重新指给新 peerId、清掉 `claimedAt`、按完整窗口重新计时，新一代长轮询立刻能领走并跑完；
  否则人明明已经回来了，屋里却会在超时后落一条「对面机器没有回应」，看起来像它没理人；
- 宿主解散房间后，加入方投影里就没有那间屋了。此时镜像不删，改成墓碑（`room.remote.lost`），
  输入锁住、只留「从列表移除」——否则用户会卡在一个发不出话也退不出的房间里。
  解散同时会 `speaker.stop(roomId)`：正在跑的那一轮当场收掉，不再等远程那 45 秒、也不再等模型；
  它的收尾走「屋子已经不在」这条安静路径（只记 `turn_abandoned` 日志），不把 `room_not_found`/`cancelled`
  写进 agent 的 `lastError` —— 否则用户会在 agent 列表里看到一条「上次失败」，其实它只是替一间
  已经不存在的屋子跑完了一次。

**名字与身份**：一个真人在屋里的名字来自 `state.self.name`，客户端左栏底部的「我的名字」就是它的唯一入口
（回车或失焦才提交，不在每次按键上发 RPC）。改它走 `self.rename`：本机房间里的成员记录一起改名；
如果这台机器还是别人屋子的加入方，则同时 `POST /lan/self`（带 `peerId`），宿主把**同一条**成员记录改名 ——
不是新建一个人。握手时也会带上当前的 `self.name`；若加入方的自称与宿主本人同名，宿主用机器名兜底
（`GUEST-A` 之类），屋里不会出现两个「我」。历史消息保留当时的 `authorName`：改名改的是以后怎么称呼你。

**邀请地址**：邀请条上那句 `地址:端口` 是对方唯一要抄的东西，所以它不能只是「网卡表第一项」。
`os.networkInterfaces()` 的返回顺序没有保证，装了 WSL2 / Hyper-V 的 Windows 上
`vEthernet (WSL (Hyper-V firewall))` 经常排在 WLAN 前面 —— 取第一项就等于把一个只有本机能通的
`172.x` 递给对方，对面看到的只是超时。`lanAddresses()` 因此做三件事：按「对方最可能连得上」排序
（192.168 / 10.x 在前，虚拟网卡按名字识别后压到后面并带 `virtual` 标记）、丢掉 APIPA（`169.254.x`）
与回环、同分保持系统顺序以便复现。界面只把排第一的写进邀请行，其余列在下面并标「虚拟网卡」。

**安全取舍**：局域网内明文 HTTP + 房间码，不做 TLS、不做账号。这是**设计取舍不是遗漏**：
威胁模型是「同一 WiFi 下可信的人」，不是公网。peerId 是一次握手的随机凭据，
除 `/lan/join`（需要房间码）与 `/lan/ping` 外，所有端点都要求它。

### 接口（宿主侧，房间码鉴权）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/lan/join` | `{code, machine, self, agents, build, instance}` → `{peerId, selfMemberId, snapshot}`（同 `instance` 视为同一条 link 回来了：成员接手、id 不变） |
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
| `plugin.js` + `turn.js` + `speak.js` | 假 ctx 跑真实 `apply()`，假模型（14 用例） | 验证接线：路由、信封、命令、@ 识别、预算、一轮内不重复、插话不丢、落库顺序；其中一条专测「agent 改名改职责」——名字与职责属于 agent 本身，两间屋子一起换，`@` 认新名字、职责进 prompt、旧名字不再触发；一条专测「每个 agent 有自己的原生会话」——两轮发言各自回到自己的 sessionId、会话里不出现别人的话；一条专测「这一轮被中断时不会把上一句再发一遍」——修复前 2 条重复消息，修复后 1 条 + 一条失败占位 |
| LAN（宿主 + 加入者） | 两个独立实例各起 `node:http`，互相走真实 `/lan/*`（13 用例） | 跨机器这条路没法用单测假装：真 HTTP、真鉴权、真派发、真超时；其中一条专测「进屋之后再改名」——改的必须是同一条成员记录，不能凭空多出一个人；一条专测「对面那间屋子没了别再打紧循环」——宿主撤掉后在同一端口立一个只回 403 的桩，数 2.5 秒里打了多少次（修复前 750 次） |
| 端口被占（`lan-host.start()`） | 真占住一个端口再让插件起在同一个端口上：断言 `apply()` 不抛、本机房间照常、`serving: false` 且带「被占用」原因；再放开端口，断言同一个端口下一次能起来（2 用例） | 4399 被别的程序占住是这个插件在别人机器上最可能遇到的启动失败。那一刻如果让 `apply()` 抛，人连本机房间都没有、界面上也没有任何解释——「局域网没起来」必须是降级，不是装不上 |
| LAN 请求面抗坏包 | 直接往 socket 灌字节：畸形 `Host`、非法请求行、超大 `Content-Length`、非 JSON、未知路径（3 用例） | 这个口对同网段开着，而漏出去的异常会把宿主进程带走 —— 这类缺陷只有「真发包 + 断言进程还活着」才测得出来 |
| 加入失败的那句话 | 真去连一个刚放掉的端口，断言文案里有「哪台」和「为什么」、没有 `fetch failed` 与内部错误码、也没有 `/lan/join` 这种内部端点（1 用例） | Node 的 `fetch` 把原因藏在 `cause`（连被拒时还是个 AggregateError），直接取 `message` 只能得到 `fetch failed`。这是第二台机器最常撞上的状态，报错的质量就是产品本身 |
| 邀请地址排序（`lanAddresses()`） | 给一份「虚拟网卡排在最前」的网表，断言排第一的仍是真实网卡、虚拟的带 `virtual` 标记、APIPA 与回环被丢掉、反复调用顺序不变（3 用例） | 这里错不会报错，只会让对面一直超时，而人看着「地址明明写对了」。装 WSL2 的机器上 `vEthernet` 排 `WLAN` 前面是常态，所以排序必须拿固定网表钉住，不能在本机碰运气 |
| 三台机器同屋 | 三个独立实例：宿主 + 两台加入方，各自带 agent（4 用例） | 两方时归属不可能搞错，三方才会暴露「A 的话在 B 那边被标成本机」这类串台；顺便验一轮里预算正好用满、只派给该派的那台，以及主席在远程时它 @ 到的第三台机器能接上 |
| `lib/client.js` | 在 Node 里按真实加载协议装载 + 假 React 桩（3 用例） | 客户端装错的后果是整页白屏，必须能离线拦住；其中两条专测客户端到宿主的两条运输路：有连接服务时走 `rpc.call` 且一次不碰 `fetch`，取不到连接服务时回落到同源 `/api`，断言信封一致、并且拿到快照之后才进入长轮询（只发请求不算通，接上了才算） |
| 悬浮窗位置 | 真实渲染里存一个越界坐标重开页面、拖到 9999×9999、再把窗口改到 1024×700，末尾把窗收成胶囊再抓一次拖到固定坐标，四处都断言浮窗仍在视口内 | 坐标是能记住的东西，但「记住」和「点得到」是两件事：窗口一变，旧坐标就变成一块抓不住的浮窗。最后那条是补上的漏洞：拖动监听原来跟着 `floatOpen` 一起关，收起成胶囊以后一步也拖不动 |
| 视觉规格 | 样式表里只引用 `--cr-*` 变量（颜色一律先成 token，含 `--cr-danger`，组件里不现调色）；间距 4/8 栅格、字号 11/12/13/14 四档、圆角 8/12 两档；页面级横幅的类名必须与消息行的类名分开（`.cr-error-bar` vs `.cr-msg.cr-error`，撞名会让横幅的底色和缩进套到每一条失败消息上）；本机成员不带来源标，远程只标 `LAN · 机器名`；消息行不再重复 `agent` 标签 | 这一层没有单测能替你审美，但「盒子套盒子、同一件事标两遍、6/10/13 这种散值、类名撞车」是可以机械拦住的，所以把约定写进 token 与截图断言 |
| `package.json` / `icon.svg` / `locale` | 清单自洽（4 用例）：图标能渲染、中英描述齐全、`files` 与 `exports` 对得上、`lib` 与 `src` 里零 `@deepseek-ai/*` 引用 | 这几条错了不会在本机报错，只会在别人的 profile 里炸，或者让插件管理页显示成默认图 + 包名 |
| 代码指纹（`src/host/code.js`） | 4 用例：刚从磁盘装载的实例 `stale` 为 false；把宿主某个文件的时间戳改到未来再换查询串重新求值同一模块，同一判据翻成 true；探针 `codeStatus()` 每次都重读磁盘；**热重载之后 `stale` 落回 false**（判据是 apply 推的 `appliedAt`，不是模块自己的求值时间） | 插件装进 profile 后是拷贝 / junction，**改了文件不等于跑着的进程换了代码**。这一轮就是靠「进程启动时间 + 文件 mtime + 插件安装记录」三样拼出来才推出现在内存里是哪一版（结论是 10:50 那份，13:11 的崩溃修复不在里面），所以把这三样固化成一次请求就能问清的字段。**换代码不必重启整个桌面端**：在设置 → 插件里把 `dsh-chatroom` 关掉再打开，宿主半边重新求值（真实 profile 实测 `appliedAt` 变成那一刻、`stale` 回到 false、`shell.overlay` 里 `chatroom-float` 重新 active）；旧进程那份探针只会报装载那一刻的快照，所以「看起来没变」本身也说明它跑的是旧代码。**热重载只重新求值改过的文件**（同一份 profile 连开三轮：`loadedAt` 一直停在 `11:23:28.880Z`，`appliedAt` 依次往前走），所以判「换没换」只能看 `appliedAt` |
| 真实模型 | 装进 profile 后从局域网 peer 身份发一句 @，读回真回复 | 只能真跑，没有替代品 |
| 视觉效果 | 真实渲染截图（两个进程的 LAN、以及第三台机器按需加入的那张都在里面） | 见 README 的验证状态表 |
| 三台机器同屋的界面 | 真实渲染里让第三个进程加入，断言消息行/成员列的来源标到具体机器名、本机成员一个 LAN 标都没有 | 「多人」不只是协议能通：两台远程机器如果都显示成「LAN」，用户照样分不清谁是谁 |
| 「我的名字」 | 真实渲染里改成另一个名字，等成员列当场换过来，再改回去 | 输入框里那个值同时是「宿主记的名字」和「你还没提交的草稿」，只在 DOM 里看它等于什么都没证明 |
| agent 的名字与职责 | 真实渲染里点成员行的「改」→ 表单原地展开 → 改职责 → 保存 → 成员列当场换，再改回原值 | 职责不是备注，它进每一轮的 prompt；改了却不生效等于没做，所以断言的是「成员列上的职责文字真的换了」 |
