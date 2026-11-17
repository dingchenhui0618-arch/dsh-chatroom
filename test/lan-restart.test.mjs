import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 宿主重启之后，那台机器回来还是同一个人。
 *
 * peerId 是每个进程现发的，成员却是落盘的：宿主一重启，屋里那组远程成员会被当成
 * 上一代进程的幽灵清掉。加入方那边拿的还是同一条落盘的 link（instance 不变），
 * 它重新握手进屋 —— 但在这次修复之前，宿主没有任何记录能证明「刚才那组就是它」，
 * 于是现发一组新的成员 id。
 *
 * 这一换，三样东西一起坏：
 *   1. 它自己过去说过的话不再属于它 —— 加入方镜像按成员 id 认「me」，新 id 对不上，
 *      那些话会被标成「远程 · 宿主机器名」说的话，看着像别人借用它的名字；
 *   2. 已读游标是按成员 id 记的，随成员一起没了 —— 整段历史重新变成未读；
 *   3. 它带的 agent 同样换 id，主席位（椅子里存的是成员 id）也被清空。
 *
 * 重启主机是常事（装插件、更新代码都要重启），所以这条必须稳住。
 */

/** 拿一个空闲端口：宿主重启后加入方还照旧地址重连，端口不能换（端口 0 每次都不同）。 */
async function freePort() {
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 找一个能真监听的端口：并行跑测试时刚放掉的号可能被别人抢走，抢了就换一个。 */
async function hostPort(dir, options = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort()
    process.env.DSH_CHATROOM_PORT = String(port)
    const side = await boot(dir, options)
    if ((await snapshot(side)).lan.serving) return { side, port }
    await side.dispose()
  }
  throw new Error('找不到能监听的端口')
}

async function boot(dir, options = {}) {
  const fake = fakeCtx(dir, options)
  const dispose = await apply(fake.ctx)
  return { dir, dispose, ...fake }
}

const snapshot = async (side) => {
  const result = await call(side.routes, 'snapshot', {})
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}

const command = async (side, action, input = {}) => {
  const result = await call(side.routes, 'command', { action, input })
  assert.equal(result.ok, true, `${action} 失败：${JSON.stringify(result.error)}`)
  return result.value
}

const roomById = (view, roomId) => view.rooms.find((room) => room.id === roomId)
const mirrorOf = (view) => view.rooms.find((room) => room.remote)
const byName = (room, name) => room.members.find((member) => member.name === name)

test('宿主重启：回来还是同一个人 —— 成员 id 不变、自己说的话还认自己、未读不重标', async () => {
  const hostDir = await mkdtemp(join(tmpdir(), 'restart-host-'))
  const guestDir = await mkdtemp(join(tmpdir(), 'restart-guest-'))
  const envBackup = process.env.DSH_CHATROOM_PORT
  // 宿主这次必须用固定端口：加入方的 link 里记着地址，重启换端口就等于换了台机器。
  const { side: firstHost, port } = await hostPort(hostDir, { reply: '宿主这边：记下了。' })
  let host = firstHost
  let guest = null
  try {
    // 加入方自己也开一个监听口（每台机器都能当宿主）：端口 0 让系统挑，别跟宿主抢。
    process.env.DSH_CHATROOM_PORT = '0'
    guest = await boot(guestDir, { reply: '加入方也记下了。' })

    const created = await command(host, 'room.create', { name: '对账会', topic: '重启也别换人' })
    const roomId = created.rooms[0].id
    // 先把全员轮流关掉：这一轮只测身份，不测谁该说话。
    await command(host, 'room.update', { roomId, rules: { roundRobin: false, mention: true } })

    await command(guest, 'self.rename', { name: '陈默' })
    await command(guest, 'lan.join', {
      host: '127.0.0.1',
      port,
      code: created.rooms[0].code,
      machine: 'GUEST-B',
    })
    const mirror = mirrorOf(await snapshot(guest))
    assert.ok(mirror, '加入方应该拿到镜像房间')
    await command(guest, 'bot.create', { name: '阿乙', role: '盯尾货库存', roomId: mirror.id })

    const joined = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room && byName(room, '陈默') && byName(room, '阿乙') ? room : null
    }, { label: '宿主屋里先有这两个人' })
    const humanBefore = byName(joined, '陈默').id
    const agentBefore = byName(joined, '阿乙').id

    // 加入方说一句，宿主读一句，然后把未读清零 —— 重启后这个「零」还得是零。
    await command(guest, 'msg.send', { roomId: mirror.id, text: '这句是重启前我说的' })
    await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room.messages.find((message) => message.text === '这句是重启前我说的')
    }, { label: '重启前那句先落到宿主' })
    await command(host, 'msg.send', { roomId, text: '宿主也说了两句，一句在这' })
    await command(host, 'msg.send', { roomId, text: '另一句在这' })
    // 宿主那两句是随长轮询推到加入方的，得等镜像真的收到再读 —— 否则读到的是旧的末条。
    const beforeRead = await until(async () => {
      const room = mirrorOf(await snapshot(guest))
      return room && room.messages.length === 3 ? room : null
    }, { label: '加入方镜像收到宿主那两句' })
    await command(guest, 'read.mark', { roomId: beforeRead.id, seq: beforeRead.nextSeq - 1 })
    await until(async () => {
      const room = mirrorOf(await snapshot(guest))
      return room && room.unread === 0
    }, { label: '重启前未读先清零' })
    // 主席位存的是成员 id：重启后这个 id 若被换掉，椅子就空了。
    // 放在消息都说完之后再设，免得主席按指派规则再回一轮，把消息条数搅浑。
    await command(host, 'room.update', { roomId, rules: { chairId: agentBefore } })

    // 真正的重启：关掉宿主半边（状态落盘），再照同一个目录、同一个端口起来。
    await host.dispose()
    process.env.DSH_CHATROOM_PORT = String(port)
    host = await boot(hostDir, { reply: '宿主这边：记下了。' })

    const back = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room && room.members.length === 3 ? room : null
    }, { timeoutMs: 20000, label: '加入方重新握手进屋' })

    // 1. 人还是那个人。
    assert.equal(byName(back, '陈默')?.id, humanBefore, '宿主重启不该把加入方换成另一个成员 id')
    assert.equal(byName(back, '阿乙')?.id, agentBefore, '带过来的 agent 也该还是同一个成员 id')
    assert.equal(back.members.length, 3, '不能多出一组「另一个他」')
    // 2. 主席位跟着回来。
    assert.equal(back.rules.chairId, agentBefore, '重启后主席位应该还在那个 agent 上')

    const mirrorBack = await until(async () => {
      const room = mirrorOf(await snapshot(guest))
      return room && byName(room, '阿乙') ? room : null
    }, { timeoutMs: 20000, label: '加入方镜像恢复' })

    // 3. 自己说过的话还认自己。
    const mine = mirrorBack.messages.find((message) => message.text === '这句是重启前我说的')
    assert.ok(mine, '重启前那句应该还在镜像里')
    assert.equal(mine.authorId, 'me', '重启后自己过去说的话必须还署在自己名下')
    assert.equal(mine.origin.kind, 'local', '自己说的话不能被打成远程')
    // 4. 未读不重标。
    assert.equal(mirrorBack.unread, 0, '重启不该把整段历史重新标成未读')

    // 5. 回来之后再说一句，宿主那边仍算在同一个成员头上。
    await command(guest, 'msg.send', { roomId: mirrorBack.id, text: '重启后补一句' })
    const after = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room.messages.find((message) => message.text === '重启后补一句')
    }, { label: '重启后这句落到宿主' })
    assert.equal(after.authorId, humanBefore, '重启后说的话也该落在原来那个成员身上')
  } finally {
    process.env.DSH_CHATROOM_PORT = envBackup
    await guest?.dispose().catch(() => {})
    await host?.dispose().catch(() => {})
  }
})

test('断线超过清扫时间：成员列里先消失，回来还是原来那个人', async () => {
  const hostDir = await mkdtemp(join(tmpdir(), 'sweep-host-'))
  const guestDir = await mkdtemp(join(tmpdir(), 'sweep-guest-'))
  const envPort = process.env.DSH_CHATROOM_PORT
  const envIdle = process.env.DSH_CHATROOM_PEER_IDLE
  // 清扫窗口压到 1 秒：测的是「扫掉以后回来」，不是耐心。
  process.env.DSH_CHATROOM_PEER_IDLE = '1000'
  const { side: firstHost, port } = await hostPort(hostDir, { reply: '宿主这边：记下了。' })
  let host = firstHost
  let guest = null
  try {
    process.env.DSH_CHATROOM_PORT = '0'
    guest = await boot(guestDir, { reply: '加入方也记下了。' })
    const created = await command(host, 'room.create', { name: '断线会', topic: '网抖一下也别换人' })
    const roomId = created.rooms[0].id
    await command(guest, 'self.rename', { name: '周荻' })
    await command(guest, 'lan.join', {
      host: '127.0.0.1',
      port,
      code: created.rooms[0].code,
      machine: 'GUEST-C',
    })
    const mirror = mirrorOf(await snapshot(guest))
    await command(guest, 'bot.create', { name: '阿丙', role: '盯账期', roomId: mirror.id })
    const joined = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room && byName(room, '周荻') && byName(room, '阿丙') ? room : null
    }, { label: '先都在屋里' })
    const humanBefore = byName(joined, '周荻').id
    const agentBefore = byName(joined, '阿丙').id
    await command(guest, 'msg.send', { roomId: mirror.id, text: '断线前我说的这句' })
    await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room.messages.find((message) => message.text === '断线前我说的这句')
    }, { label: '断线前那句先到宿主' })

    // 那台机器断了：进程关掉，清扫会把它的成员列整组撤下来。
    await guest.dispose()
    guest = null
    await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room && room.members.length === 1 ? room : null
    }, { timeoutMs: 10000, label: '清扫把断线那台的人撤下来' })

    // 它回来了：同一个目录、同一条 link，重新握手。
    process.env.DSH_CHATROOM_PORT = '0'
    guest = await boot(guestDir, { reply: '加入方也记下了。' })
    const back = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room && room.members.length === 3 ? room : null
    }, { timeoutMs: 20000, label: '断线那台重新进屋' })
    assert.equal(byName(back, '周荻')?.id, humanBefore, '断线回来不该换成另一个成员 id')
    assert.equal(byName(back, '阿丙')?.id, agentBefore, 'agent 的成员 id 也该照旧')

    const mirrorBack = await until(async () => {
      const room = mirrorOf(await snapshot(guest))
      return room && byName(room, '阿丙') ? room : null
    }, { timeoutMs: 20000, label: '镜像恢复' })
    const mine = mirrorBack.messages.find((message) => message.text === '断线前我说的这句')
    assert.equal(mine?.authorId, 'me', '断线前自己说的话还该署在自己名下')
    assert.equal(mine?.origin.kind, 'local', '不能被打成远程')
  } finally {
    process.env.DSH_CHATROOM_PORT = envPort
    process.env.DSH_CHATROOM_PEER_IDLE = envIdle
    await guest?.dispose().catch(() => {})
    await host?.dispose().catch(() => {})
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('关掉插件时还有一次握手在路上：不许留下未处理的拒绝', async () => {
  /**
   * 未处理的拒绝在 Node 里等于未捕获异常 —— 它会把宿主进程整个带走。
   * 而「关掉/重载插件」（设置 → 插件里关开一次）时，加入方的重连循环很可能正飞着一次
   * 重新握手：store 已经关了，回程里的状态更新会抛 `closed`。这条把那个时刻真做出来：
   * 宿主那侧用真插件，中间夹一个「握手的回程要等 500ms」的代理，趁这段时间关插件。
   */
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const hostDir = await mkdtemp(join(tmpdir(), 'close-host-'))
  const guestDir = await mkdtemp(join(tmpdir(), 'close-guest-'))
  const envPort = process.env.DSH_CHATROOM_PORT
  let host = null
  let guest = null
  let proxy = null
  try {
    process.env.DSH_CHATROOM_PORT = '0'
    host = await boot(hostDir, { reply: '宿主这边：记下了。' })
    const created = await command(host, 'room.create', { name: '关插件', topic: '握手飞着的时候关掉' })
    const target = (await snapshot(host)).lan.port
    assert.ok(target, '宿主应该真的在监听')

    let joins = 0
    let secondJoin
    const joined = new Promise((resolve) => {
      secondJoin = resolve
    })
    proxy = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      // 除握手外的请求一律按「凭据失效」回：逼加入方走重新握手那条路。
      if (request.url !== '/lan/join') {
        response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: { code: 'peer_unknown', message: '凭据过期了。' } }))
        return
      }
      joins += 1
      if (joins === 2) secondJoin()
      const upstream = await fetch(`http://127.0.0.1:${target}/lan/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const text = await upstream.text()
      // 回程慢 500ms：够我们在这期间把插件关掉。
      if (joins >= 2) await sleep(500)
      response.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(text)
    })
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxyPort = proxy.address().port

    guest = await boot(guestDir, { reply: '加入方也记下了。' })
    await command(guest, 'lan.join', {
      host: '127.0.0.1',
      port: proxyPort,
      code: created.rooms[0].code,
      machine: 'GUEST-D',
    })

    // 等它撞上 403、开始第二次握手（回程 500ms），然后立刻关插件。
    await joined
    await sleep(120)
    await guest.dispose()
    guest = null
    await sleep(900)
    assert.deepEqual(
      unhandled.map((reason) => String(reason?.message ?? reason)),
      [],
      '关插件时不该留下未处理的拒绝（Node 会把它当成未捕获异常）',
    )
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    process.env.DSH_CHATROOM_PORT = envPort
    await guest?.dispose().catch(() => {})
    proxy?.close()
    await host?.dispose().catch(() => {})
  }
})
