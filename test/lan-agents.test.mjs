import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 「加入之后才建 agent」这条路。
 *
 * 之前只有加入那一刻的名单：宿主在 /lan/join 里把对面报上来的 agent 建成成员，
 * 之后再建、再改名，宿主永远不会知道。新装的机器上一个 agent 都没有 ——
 * 而人往往是**先挤进屋、才想起要带谁**，于是屋里就永远只有他一个人，
 * 对面的成员列还看不出少了什么。
 *
 * 这里测的就是补齐的那条路：加入方把本机现在的名单报上去，宿主对账
 * （缺的补、改的更新、删的移除），并且补进来的 agent 真能被派发过去跑。
 */

process.env.DSH_CHATROOM_PORT = '0'

async function boot(name, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `agents-${name}-`))
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

/** 老版本宿主：除了 /lan/agents 什么都转发，那个端点回 404（旧版根本没有它）。 */
async function legacyProxy(target) {
  const server = createServer(async (request, response) => {
    if (request.url === '/lan/agents') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: '没有这个端点。' } }))
      return
    }
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const upstream = await fetch(`${target}${request.url}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body,
      })
      const text = await upstream.text()
      response.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(text)
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: { code: 'proxy_failed', message: String(error?.message) } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/** 宿主开一间屋；另一台机器一个 agent 都没有，直接加入（新装的那台就是这样）。 */
async function setup({ hostReply = '宿主这边：数对得上。', guestReply = '补上来的 agent 也能跑。' } = {}) {
  const host = await boot('host', { reply: hostReply })
  const guest = await boot('guest', { reply: guestReply })
  const created = await command(host, 'room.create', { name: '对账会', topic: '把缺口口径对一遍' })
  const roomId = created.rooms[0].id
  const port = (await snapshot(host)).lan.port
  await command(guest, 'self.rename', { name: '陈默' })
  await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code, machine: 'GUEST-B' })
  const mirror = mirrorOf(await snapshot(guest))
  assert.ok(mirror, '加入方应该拿到镜像房间')
  return { host, guest, roomId, mirror, code: created.rooms[0].code }
}

test('加入时一个 agent 都没带：之后补建一个，宿主屋里立刻多一个人，标 LAN 且认得出是哪台机器', async () => {
  const { host, guest, roomId, mirror } = await setup()
  try {
    const before = roomById(await snapshot(host), roomId)
    assert.equal(before.members.filter((member) => member.kind === 'bot').length, 0, '没带 agent 时屋里不该凭空多出 agent')
    assert.equal(before.members.length, 2, '这时屋里只有两个人：我和陈默')

    // 在镜像房间里建 agent：本地先有它，再报给宿主。
    await command(guest, 'bot.create', { name: '阿乙', role: '盯尾货库存与清仓节奏', roomId: mirror.id })

    const after = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return byName(room, '阿乙') ? room : null
    }, { label: '宿主成员列里多出补报的 agent' })
    const agent = byName(after, '阿乙')
    assert.equal(agent.kind, 'bot')
    assert.equal(agent.origin.kind, 'lan', '补报的 agent 在宿主这边是远程')
    assert.equal(agent.origin.machine, 'GUEST-B', '宿主得看出这是 B 那台机器带的 agent')
    assert.equal(agent.role, '盯尾货库存与清仓节奏')
    assert.equal(after.members.length, 3)

    // 加入方视角：自己带的 agent 是本机的，不能标成远程（否则看着像串台）
    const guestRoom = await until(async () => {
      const room = mirrorOf(await snapshot(guest))
      return room && byName(room, '阿乙') ? room : null
    }, { label: '加入方的镜像里也有这个 agent' })
    assert.equal(byName(guestRoom, '阿乙').origin.kind, 'local')
    assert.equal(byName(guestRoom, '陈默').id, 'me')
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('补进来之后再改名改职责：宿主跟着变，已经说过的话仍署当时的名字', async () => {
  const { host, guest, roomId, mirror } = await setup()
  try {
    await command(guest, 'bot.create', { name: '阿乙', role: '盯库存', roomId: mirror.id })
    const bot = (await snapshot(guest)).bots.find((row) => row.name === '阿乙')
    assert.ok(bot, '加入方本地应该有这个 agent')

    // 先让它说一句：改名之后这句不能被追溯改成新名字。
    await command(host, 'msg.send', { roomId, text: '@阿乙 尾货现在多少？' })
    await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room.messages.find((message) => message.authorName === '阿乙')
    }, { label: '补报的 agent 能回一句' })

    await command(guest, 'bot.update', { botId: bot.id, name: '阿乙二号', role: '盯尾货与清仓节奏' })

    const renamed = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return byName(room, '阿乙二号') ? room : null
    }, { label: '宿主那边的成员改名' })
    assert.equal(byName(renamed, '阿乙'), undefined, '旧名字不该还留在成员列里')
    assert.equal(byName(renamed, '阿乙二号').role, '盯尾货与清仓节奏')
    const said = renamed.messages.find((message) => message.authorName === '阿乙')
    assert.ok(said, '历史消息仍署当时的名字')
    assert.equal(renamed.members.length, 3, '改名不该多出一个人')
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('把那台机器上的 agent 删掉：宿主的成员列也跟着少一个，但别人的 agent 一个不少', async () => {
  const { host, guest, roomId, mirror } = await setup()
  try {
    await command(host, 'member.createBot', { roomId, name: 'Claude', role: '账期' })
    await command(guest, 'bot.create', { name: '阿乙', role: '盯库存', roomId: mirror.id })
    const bot = (await snapshot(guest)).bots.find((row) => row.name === '阿乙')
    await until(async () => byName(roomById(await snapshot(host), roomId), '阿乙'), { label: '宿主先看到阿乙' })

    await command(guest, 'bot.remove', { botId: bot.id })

    const after = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return byName(room, '阿乙') ? null : room
    }, { label: '宿主那边的成员被撤掉' })
    assert.equal(byName(after, 'Claude').origin.kind, 'local', '宿主自己的 agent 不该被动到')
    assert.equal(after.members.length, 3, '撤掉之后应该是：我、陈默、Claude')
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('补报进来的 agent 真能被派发：宿主 @ 它，在那台机器上用它自己的会话跑，回复以 LAN 归属落库', async () => {
  const { host, guest, roomId, mirror } = await setup({ guestReply: '尾货占退货的 62%，清仓能压回 15 万。' })
  try {
    await command(guest, 'bot.create', { name: '阿乙', role: '盯尾货库存', roomId: mirror.id })
    const bot = (await snapshot(guest)).bots.find((row) => row.name === '阿乙')
    await until(async () => byName(roomById(await snapshot(host), roomId), '阿乙'), { label: '宿主先看到阿乙' })

    await command(host, 'msg.send', { roomId, text: '@阿乙 尾货占多少？' })

    const reply = await until(async () => {
      const room = roomById(await snapshot(host), roomId)
      return room.messages.find((message) => message.authorName === '阿乙')
    }, { label: '补报的 agent 的回复落进宿主房间' })
    assert.match(reply.text, /尾货占退货的 62%/)
    assert.equal(reply.origin.kind, 'lan')
    assert.equal(reply.origin.machine, 'GUEST-B')

    // 关键：这一轮是那台机器用它自己给这个 agent 的会话跑的，不是宿主代跑
    assert.equal(host.prompts.length, 0, '宿主不该替远程 agent 调模型')
    assert.equal(guest.prompts.length, 1, '那台机器应该被派发这一轮')
    assert.equal(guest.prompts[0].sessionId, bot.sessionId, '要用这个 agent 自己的会话')
    assert.match(guest.prompts[0].text, /以「阿乙」的身份/)
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('旧版本那台进来：宿主看得出它报不了 agent 名单，和「还没建」分得清', async () => {
  const host = await boot('host')
  const guest = await boot('guest')
  try {
    const created = await command(host, 'room.create', { name: '版本对账', topic: '分清旧版本和没建' })
    const { code } = created.rooms[0]
    const port = (await snapshot(host)).lan.port

    // 老版本的加入方：手写协议，body 里没有 build —— 它既没有补报接口，也没有那个界面。
    const response = await fetch(`http://127.0.0.1:${port}/lan/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, machine: 'OLD-MACHINE', self: { id: 'u_old', name: '老机器' }, agents: [] }),
    })
    const body = await response.json()
    assert.equal(body.ok, true, JSON.stringify(body.error))

    const old = (await snapshot(host)).lan.peers.find((peer) => peer.machine === 'OLD-MACHINE')
    assert.ok(old, '宿主应该记得这台机器')
    assert.equal(old.canAgents, false, '没带能力位 = 旧版本，界面要能直说要重启那台')
    assert.deepEqual(old.agents, [], '它也确实一个 agent 都没带')

    // 新版加入方：走真实的 lan.join（带 build），能力位是 true。
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code, machine: 'NEW-MACHINE' })
    const fresh = (await snapshot(host)).lan.peers.find((peer) => peer.machine === 'NEW-MACHINE')
    assert.equal(fresh.canAgents, true, '新版报得上能力位')
    assert.deepEqual(fresh.agents, [])

    // 加入方这边：对面是正经新版，hostOld 不该亮。
    assert.equal((await snapshot(guest)).links[0].hostOld, false)
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('撞上旧版本宿主（没有补报接口）：不炸、不重试到天荒地老，而是记下「对面旧」让界面说清', async () => {
  const host = await boot('host')
  const guest = await boot('guest')
  const proxy = await legacyProxy(`http://127.0.0.1:${(await snapshot(host)).lan.port}`)
  try {
    const created = await command(host, 'room.create', { name: '半新半旧', topic: '' })
    const { code } = created.rooms[0]
    // 加入方以为自己在跟一台旧宿主打交道（404 就来自那条链路）。
    await command(guest, 'lan.join', { host: '127.0.0.1', port: proxy.port, code, machine: 'NEW-MACHINE' })
    const mirror = mirrorOf(await snapshot(guest))
    assert.ok(mirror, '手还是握上了：只有补报那一步是新接口')

    await command(guest, 'bot.create', { name: '阿乙', role: '盯库存', roomId: mirror.id })

    const link = (await snapshot(guest)).links[0]
    assert.equal(link.hostOld, true, '404 要落成「宿主的插件是旧版本」')
    assert.equal((await snapshot(guest)).bots.some((bot) => bot.name === '阿乙'), true, '本机这边照建不误')

    // 宿主那边确实没收到：屋里还是两个人，而且没有任何补报上来的成员。
    const room = roomById(await snapshot(host), created.rooms[0].id)
    assert.equal(room.members.filter((member) => member.kind === 'bot').length, 0)
  } finally {
    // 先让加入方停下（它那条 /lan/state 长轮询还挂在代理上），
    // 否则 server.close() 会等这条连接，测试进程永远退不出去。
    await guest.dispose().catch(() => {})
    proxy.server.closeAllConnections?.()
    await new Promise((resolve) => proxy.server.close(resolve))
    await host.dispose().catch(() => {})
  }
})
