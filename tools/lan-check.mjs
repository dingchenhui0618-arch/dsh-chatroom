import { argv, env, exit } from 'node:process'
import { bootFixture, bootGuest } from './preview/fixture.mjs'

/**
 * 两台真机器之间的联通自检。
 *
 * 它验的不是「代码逻辑」，而是**这台机器到那台机器的网络通不通**：
 * 防火墙放不放 4399、两台机器在不在同一个网段、房间码抄对了没有。
 * 模型是假的（这里不烧 token），但 HTTP、鉴权、派发、回传都是真的。
 *
 * 机器 A：node tools/lan-check.mjs host
 * 机器 B：node tools/lan-check.mjs guest --host 192.168.1.5:4399 --code ABC123
 */

const log = (...args) => console.log(...args)

function argOf(name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  return fallback
}

const mode = argv[2]

if (mode === 'host') {
  const port = Number(argOf('port', env.DSH_CHATROOM_PORT || '4399'))
  const host = await bootFixture({ port })
  const status = host.lan.status()
  if (!status.serving) {
    log(`✗ 监听没起来：${status.error ?? '未知原因'}`)
    exit(1)
  }
  /**
   * 和邀请条同一套口径：第一个是「对方连得上」的那个，其余列在下面并标虚拟网卡。
   * 这里如果平铺所有网卡，人很可能从列表里挑到 172.x 的 WSL 网卡抄过去。
   */
  const cands = Array.isArray(status.addresses) ? status.addresses : []
  const primary = cands[0] ?? null
  const label = (row) => `${row.address}:${status.port}  (${row.name}${row.virtual ? '，虚拟网卡' : ''})`
  log('') // 换行：下面的块方便直接抄给对方
  log('── 这台机器（宿主）────────────────────────────')
  log(`  房间码   ${host.code}`)
  log(`  地址     ${primary ? label(primary) : '没找到网卡地址'}`)
  for (const other of cands.slice(1)) log(`  其他     ${label(other)}`)
  log(`  本机地址 ${status.port ? `127.0.0.1:${status.port}` : '—'}`)
  log('')
  if (!primary || primary.virtual) log('  ! 这台机器只有虚拟网卡（WSL / Hyper-V / Docker 之类），对方连不上；先连 WiFi 或网线。')
  log('  在另一台机器上运行（地址用上面第一个，其余地址对方连不上）：')
  log(`  node tools/lan-check.mjs guest --host ${primary?.address ?? '127.0.0.1'}:${status.port} --code ${host.code}`)
  log('──────────────────────────────────────────────')
  log('等另一台机器加入…（Ctrl+C 结束）')

  let seen = 0
  setInterval(() => {
    const peers = host.lan.status().peers
    if (peers.length !== seen) {
      seen = peers.length
      if (seen) log(`✓ 有一台机器加入了：${peers.map((peer) => `${peer.machine}（${peer.agents.join('、') || '没带 agent'}）`).join('，')}`)
      else log('· 那台机器离开了')
    }
  }, 500)
} else if (mode === 'guest') {
  const address = argOf('host', '127.0.0.1:4399')
  const code = argOf('code')
  if (!code) {
    log('用法：node tools/lan-check.mjs guest --host 192.168.1.5:4399 --code ABC123')
    exit(1)
  }
  const TIME = Number(argOf('timeout', '20000'))
  const BOT = '自检 agent'
  // 这一段是这台机器上的 agent 自己的回话；能收到它就说明「派回我方、用我方会话跑完」。
  const OWN_REPLY = '收到：这一轮在加入方这台机器上用它自己的原生会话跑完，再回传给宿主。'
  const [hostAddress, hostPort] = address.includes(':') ? address.split(':') : [address, '4399']
  const guest = await bootGuest({
    host: hostAddress,
    port: Number(hostPort),
    code,
    name: '联通自检',
    botName: BOT,
    machine: '联通自检机',
    reply: OWN_REPLY,
  })

  /** 等镜像里出现一条满足条件的消息。 */
  async function waitFor(match, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const room = guest.snapshot().rooms.find((row) => row.remote)
      const hit = room?.messages.find(match)
      if (hit) return hit
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return null
  }

  const view = guest.snapshot()
  const mirror = view.rooms.find((room) => room.remote)
  if (!mirror) {
    log('✗ 没有拿到镜像房间')
    exit(1)
  }
  log(`✓ 已加入：${mirror.name}（宿主 ${mirror.remote.machine ?? mirror.remote.host}）`)
  log(`  屋里 ${mirror.members.length} 个成员：${mirror.members.map((member) => member.name).join('、')}`)

  // 第一段：我 → 对面那台机器的 agent。证明加入方发言能进屋、对面板子的 agent 会回。
  const remoteBot = mirror.members.find((member) => member.kind === 'bot' && member.origin?.kind === 'lan')
  const askRemote = remoteBot ? `@${remoteBot.name} 跨机联通自检，收到请回一句。` : '跨机联通自检。'
  log(`  ① 我发一句：${askRemote}`)
  await guest.command({ action: 'msg.send', input: { roomId: mirror.id, text: askRemote } })
  const remoteReply = await waitFor(
    (message) => message.authorKind === 'bot' && remoteBot && message.authorName === remoteBot.name,
    TIME,
  )
  if (!remoteReply) {
    log(`✗ 等了 ${TIME / 1000} 秒，对面的 agent 没有回话。可能原因：房间规则没开「被 @ 必回」、对面模型没配好，或对方机器上的 agent 没起。`)
    await guest.dispose()
    process.exit(1)
  }
  log(`✓ 对面的 agent 回了一句：${remoteReply.text.slice(0, 60)}`)

  // 第二段：我 @ 我自己带过来的 agent。宿主收到后应当把这一轮派回**这台**机器，
  // 由它的原生会话跑完再回传。少这一段，「人带着自己的 agent 进屋」就只是半条路。
  //
  // 认人不能只按名字：上一次自检留下的同名成员要等 peerIdle 才被扫掉，按名字可能
  // 指到一个已经没有主的旧成员上，那样宿主会把这一轮派给一个不存在的 peer。
  // 镜像成员的 member.id 是宿主拼的（m_<peer>_<botId>），只有 botId 还是我这边那个。
  const ownLocalBot = view.rooms.find((room) => !room.remote)?.members.find((member) => member.kind === 'bot')
  const ownBot = ownLocalBot
    ? mirror.members.find((member) => member.kind === 'bot' && member.botId && member.botId === ownLocalBot.botId)
    : mirror.members.find((member) => member.kind === 'bot' && member.name === BOT)
  if (!ownBot) {
    log(`✗ 宿主那边没有看到我带过去的 agent「${BOT}」，跨机派发这一段没法验。`)
    await guest.dispose()
    process.exit(1)
  }
  const askOwn = `@${BOT} 这一轮派回我这边，用你自己的会话回一句。`
  log(`  ② 我发一句：${askOwn}`)
  await guest.command({ action: 'msg.send', input: { roomId: mirror.id, text: askOwn } })
  const ownReply = await waitFor((message) => message.authorKind === 'bot' && message.text === OWN_REPLY, TIME)
  if (!ownReply) {
    log(`✗ 等了 ${TIME / 1000} 秒，我自己的 agent 没有经宿主派回来。可能是宿主没把这一轮派给加入方（检查两边版本/agent 是否已建立）。`)
    await guest.dispose()
    process.exit(1)
  }
  log(`✓ 派回我这边跑完再回传：${ownReply.text.slice(0, 40)}…`)

  log('')
  log('  两条路都通了：')
  log('   · 我这台 → 房间码进屋 → 对面板子的 agent 回话')
  log('   · 宿主把「轮到我 agent」的那一轮派回我这台 → 用它自己的原生会话跑完 → 回传落库')
  // 不用 process.exit()：Windows 上 fetch 的句柄还在关，强退会打一行 libuv 断言。
  // 把所有长轮询停掉后让事件循环自己排空即可。
  await guest.dispose()
} else {
  log('用法：')
  log('  node tools/lan-check.mjs host')
  log('  node tools/lan-check.mjs guest --host 192.168.1.5:4399 --code ABC123')
  exit(1)
}
