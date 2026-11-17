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
  log('') // 换行：下面的块方便直接抄给对方
  log('── 这台机器（宿主）────────────────────────────')
  log(`  房间码   ${host.code}`)
  for (const address of status.addresses) log(`  地址     ${address.address}:${status.port}  (${address.name})`)
  log(`  本机地址 ${status.port ? `127.0.0.1:${status.port}` : '—'}`)
  log('')
  log('  在另一台机器上运行：')
  log(`  node tools/lan-check.mjs guest --host ${status.addresses[0]?.address ?? '127.0.0.1'}:${status.port} --code ${host.code}`)
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
  const [hostAddress, hostPort] = address.includes(':') ? address.split(':') : [address, '4399']
  const guest = await bootGuest({
    host: hostAddress,
    port: Number(hostPort),
    code,
    name: '联通自检',
    botName: '自检 agent',
    machine: '联通自检机',
  })
  const view = guest.snapshot()
  const mirror = view.rooms.find((room) => room.remote)
  if (!mirror) {
    log('✗ 没有拿到镜像房间')
    exit(1)
  }
  log(`✓ 已加入：${mirror.name}（宿主 ${mirror.remote.machine ?? mirror.remote.host}）`)
  log(`  屋里 ${mirror.members.length} 个成员：${mirror.members.map((member) => member.name).join('、')}`)

  const target = mirror.members.find((member) => member.kind === 'bot' && member.origin?.kind === 'lan')
  const text = target ? `@${target.name} 跨机联通自检，收到请回一句。` : '跨机联通自检。'
  log(`  发一句：${text}`)
  await guest.command({ action: 'msg.send', input: { roomId: mirror.id, text } })

  const deadline = Date.now() + Number(argOf('timeout', '20000'))
  let reply = null
  while (Date.now() < deadline && !reply) {
    const room = guest.snapshot().rooms.find((row) => row.remote)
    reply = room?.messages.find((message) => message.authorKind === 'bot' && message.authorName === target?.name)
    if (!reply) await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (reply) {
    log(`✓ 对面的 agent 回了一句：${reply.text.slice(0, 80)}`)
    log('  这条路通了：局域网 → 房间码 → 跨机派发 → 回传落库。')
    await guest.dispose()
    // 不用 process.exit()：Windows 上 fetch 的句柄还在关，强退会打一行 libuv 断言。
    // 把所有长轮询停掉后让事件循环自己排空即可。
  } else {
    log('✗ 等了 20 秒，对面的 agent 没有回话。可能原因：房间规则没开「被 @ 必回」、对面模型没配好，或对方机器上的 agent 没起。')
    await guest.dispose()
    process.exitCode = 1
  }
} else {
  log('用法：')
  log('  node tools/lan-check.mjs host')
  log('  node tools/lan-check.mjs guest --host 192.168.1.5:4399 --code ABC123')
  exit(1)
}
