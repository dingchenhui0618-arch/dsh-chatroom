import { unreadOf } from './rooms.js'

/**
 * 给客户端的投影：只给面板需要的字段，消息截到最近 200 条。
 *
 * 两个额外的入参都不是状态，而是「此刻谁在看」和「这台机器现在的 LAN 情况」：
 *   viewerId —— 未读游标要按看的人算。LAN 那台机器看的是它自己成员的游标，
 *               而不是本机 self 的游标（否则每台机器都会显示别人的未读数）。
 *   lan      —— 监听端口、局域网地址、在线 peer。存在内存里，不落盘：
 *               在线与否是瞬时事实，写进 state.json 只会让重启后显示假在线。
 *
 * 导出是给 QA 渲染工具用的：它要在没有 DSH 外壳的情况下复用同一份投影与分发。
 */

export const PROJECTION_MESSAGES = 200

export function project(state, extra = {}) {
  const viewerId = extra.viewerId ?? state.self.id
  return {
    revision: state.revision,
    self: { id: state.self.id, name: state.self.name },
    activeRoomId: state.activeRoomId,
    lan: extra.lan ?? { serving: false, port: null, addresses: [], peers: [], error: null },
    links: (state.links ?? []).map((link) => ({
      id: link.id,
      host: link.host,
      port: link.port,
      code: link.code,
      machine: link.machine ?? null,
      hostMachine: link.hostMachine ?? null,
      roomId: link.roomId,
      localRoomId: link.localRoomId,
      status: link.status ?? 'online',
      error: link.error ?? null,
    })),
    bots: state.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      sessionId: bot.sessionId,
      lastError: bot.lastError ?? null,
      lastSpokeAt: bot.lastSpokeAt ?? null,
    })),
    rooms: state.rooms.map((room) => ({
      id: room.id,
      code: room.code,
      name: room.name,
      topic: room.topic,
      createdAt: room.createdAt,
      ownerId: room.ownerId,
      remote: room.remote ?? null,
      rules: { ...room.rules },
      activity: room.activity ?? null,
      nextSeq: room.nextSeq,
      // 镜像房间的未读由宿主按「我们这个 peer」算好随投影带过来，本地不重算：
      // 本地没有宿主的 reads 表，重算只会得到「全都没读」。
      unread: room.remote && typeof room.unread === 'number' ? room.unread : unreadOf(room, viewerId),
      members: room.members,
      messages: room.messages.slice(-PROJECTION_MESSAGES),
      truncated: room.messages.length > PROJECTION_MESSAGES,
    })),
  }
}
