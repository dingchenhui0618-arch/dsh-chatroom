import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 端口被别的程序占住，是这个插件在真实机器上最可能遇到的启动失败：
 * 一份装了两遍、或者别的服务图省事也压了 4399。
 *
 * 那一刻的正确行为不是「整个插件装不上」——那样人连本机房间都没有，界面上也没有任何解释；
 * 而是本机房间照常能用，只在邀请/加入那一栏写清「端口被占用」。
 * 顺带钉住「失败那一次不留半开的监听」：端口腾出来之后，同一个端口必须能起来。
 */

async function occupyPort() {
  const server = createServer((request, response) => {
    response.statusCode = 200
    response.end('busy')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolve)
  })
  return { server, port: server.address().port }
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve))

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

test('端口被别的程序占了：插件照样起来，本机房间能聊，界面上说得清原因', async () => {
  const { server, port } = await occupyPort()
  process.env.DSH_CHATROOM_PORT = String(port)
  const dir = await mkdtemp(join(tmpdir(), 'lan-busy-'))
  const fake = fakeCtx(dir, { reply: '本机这边照常：退货率 7.1%。' })
  let dispose = null
  try {
    // 不该抛：LAN 起不来不等于插件装不上。
    dispose = await apply(fake.ctx)

    const view = await snapshot(fake)
    assert.equal(view.lan.serving, false, '端口被占时不能说自己已经在服务')
    assert.equal(view.lan.port, null)
    assert.match(String(view.lan.error ?? ''), new RegExp(`端口 ${port} 被占用了。`))
    // 光说「被占用了」是死路：界面那行要顺手给出能做的事。
    assert.match(String(view.lan.error ?? ''), /关掉占着它的程序/)
    assert.match(String(view.lan.error ?? ''), /DSH_CHATROOM_PORT/)

    // 本机这条路必须完全不受影响：建房、建 agent、@ 它、它回话。
    const created = await command(fake, 'room.create', { name: '本机对账' })
    const room = created.rooms[0]
    await command(fake, 'member.createBot', { roomId: room.id, name: 'Claude', role: '账期' })
    await command(fake, 'msg.send', { roomId: room.id, text: '@Claude 退货率多少？' })
    const replied = await until(async () => {
      const now = await snapshot(fake)
      const target = now.rooms.find((row) => row.id === room.id)
      return target?.messages.find(
        (message) => message.authorName === 'Claude' && message.text.includes('7.1'),
      )
    }, { label: '本机 agent 回话' })
    assert.ok(replied.seq > 0, 'agent 的回复要按 seq 落进房间')
  } finally {
    if (dispose) await dispose()
    await closeServer(server)
  }
})

test('端口腾出来之后，同一个端口能正常起来（失败那次没留下半开的监听）', async () => {
  const { server, port } = await occupyPort()
  // 先占过再放掉：这个端口此刻确实空着，且是被刚才那次失败的监听用过的同一个号。
  await closeServer(server)
  process.env.DSH_CHATROOM_PORT = String(port)
  const dir = await mkdtemp(join(tmpdir(), 'lan-free-'))
  const fake = fakeCtx(dir, { reply: 'ok' })
  const dispose = await apply(fake.ctx)
  try {
    const view = await snapshot(fake)
    assert.equal(view.lan.serving, true, '端口空出来了就该真的在服务')
    assert.equal(view.lan.port, port, '用的还是那个端口，没有悄悄换一个')
    assert.equal(view.lan.error ?? null, null, '起来了就不该还挂着上一次的失败原因')
  } finally {
    await dispose()
  }
})
