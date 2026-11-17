/* dsh-chatroom client bundle —— 手写，无打包器。
 *
 * 加载协议：执行时调用 window.__ModuleLoader__.load({ id, factory })，
 * id 必须精确等于 package.json 的 name。factory 是懒 CJS 形态：
 * 只能用 module.exports，React 必须 React.createElement。
 *
 * 这一半做四件事，全部挂在 DSH 自己的 slot 契约上：
 *   1. sidebar.panellist  + main             → 侧栏「聊天室」入口与三栏主面板
 *   2. conversation.session.header.actions   → 会话标题旁的开关（悬浮窗只在会话界面用）
 *   3. shell.overlay                          → 独立悬浮窗（可拖动、可折叠、带未读）
 *   4. 未读提醒                                → 侧栏图标上的计数、页面标题前缀、新消息 toast
 *
 * 数据只有一个来源：Host 半边的 /api/dsh.chatroom/* 三个端点。
 * 所有写操作都走 command，读操作走 snapshot / watch（长轮询），
 * 于是「谁的界面都是同一间屋子」这件事由 Host 而不是浏览器负责。
 */

window.__ModuleLoader__.load({
  id: 'dsh-chatroom',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-chatroom'
    var PANEL_ID = 'chatroom'
    var PANEL_ORDER = 30 // 与「插件」「任务监控」同列，不抢新会话的位置

    /* ------------------------------------------------------------------ 文案 */

    var ZH = {
      nav: '聊天室',
      title: '聊天室',
      empty: '还没有房间',
      emptyHint: '建一间屋子，把你的 agent 拉进来一起说事。',
      emptyPreview: '还没有消息',
      newRoom: '新建房间',
      roomName: '房间名',
      roomTopic: '这间屋子用来做什么（可留空）',
      create: '建好',
      cancel: '取消',
      send: '发送',
      sendHint: 'Enter 发送，Shift+Enter 换行；@ 点名 agent',
      round: '让全员说一轮',
      stop: '停下这一轮',
      rules: '规则',
      ruleMention: '被 @ 的 agent 一定要回',
      ruleRound: '人发言后全员各说一句',
      ruleChair: '设一个主持人',
      chairNone: '不设主持人',
      maxSpeakers: '每条最多引出',
      speakersUnit: '个回复',
      people: '人',
      agents: 'agent',
      local: '本机',
      lan: 'LAN',
      reachHere: '在线',
      reachLocal: '本机',
      reachLan: '远程',
      remove: '移出房间',
      addAgent: '加一个 agent',
      agentName: '名字',
      agentRole: '职责（会影响它怎么说话）',
      dissolve: '解散房间',
      code: '房间码',
      members: '成员',
      noMessages: '屋里还很安静。说第一句吧。',
      speaking: '正在发言',
      busy: '这一轮还没结束',
      floatOpen: '聊天室',
      floatClose: '收起',
      openPanel: '打开面板',
      unread: '条未读',
      error: '出错了',
      retry: '重试',
      you: '我',
      trunc: '只显示最近 200 条',
      settingsSelf: '我的名字',
      joinLan: '加入 LAN 房间',
      joinAddress: '对方地址，如 192.168.1.5:4399',
      joinCode: '六位房间码',
      join: '加入',
      leaveLan: '离开这个房间',
      invite: '邀请',
      inviteAddress: '地址',
      inviteHint: '对方打开聊天室 → 加入 LAN 房间 → 填这个地址和房间码。两边都要开着这台机器。',
      copy: '复制',
      copied: '已复制',
      lanOff: 'LAN 没起来',
      remoteTag: '远程',
      hostedBy: '由',
      hosted: '同步中',
      remoteRules: '规则与成员由对端管理：在这台机器上只能发言。',
      roomGone: '这间屋子已经在宿主那台机器上解散了。',
      goneTag: '已解散',
      removeRoom: '从列表移除',
      lanPeers: '台机器在线',
    }

    var EN = {
      nav: 'Rooms',
      title: 'Rooms',
      empty: 'No rooms yet',
      emptyPreview: 'No messages yet',
      emptyHint: 'Make a room and bring your agents in.',
      newRoom: 'New room',
      roomName: 'Room name',
      roomTopic: 'What this room is for (optional)',
      create: 'Create',
      cancel: 'Cancel',
      send: 'Send',
      sendHint: 'Enter to send, Shift+Enter for a new line; @ to call an agent',
      round: 'Let everyone speak once',
      stop: 'Stop this round',
      rules: 'Rules',
      ruleMention: 'Mentioned agents always answer',
      ruleRound: 'Everyone speaks after I post',
      ruleChair: 'Have a chair',
      chairNone: 'No chair',
      maxSpeakers: 'At most',
      speakersUnit: 'replies',
      people: 'People',
      agents: 'Agents',
      local: 'Local',
      lan: 'LAN',
      reachHere: 'here',
      reachLocal: 'local',
      reachLan: 'remote',
      remove: 'Remove from room',
      addAgent: 'Add an agent',
      agentName: 'Name',
      agentRole: 'Role (shapes how it talks)',
      dissolve: 'Dissolve room',
      code: 'Room code',
      members: 'Members',
      noMessages: 'Quiet in here. Say the first thing.',
      speaking: 'Speaking',
      busy: 'A round is still running',
      floatOpen: 'Rooms',
      floatClose: 'Hide',
      openPanel: 'Open panel',
      unread: 'unread',
      error: 'Failed',
      retry: 'Retry',
      you: 'me',
      trunc: 'Showing the last 200 messages',
      settingsSelf: 'My name',
      joinLan: 'Join a LAN room',
      joinAddress: 'Host address, e.g. 192.168.1.5:4399',
      joinCode: 'Six-character room code',
      join: 'Join',
      leaveLan: 'Leave this room',
      invite: 'Invite',
      inviteAddress: 'Address',
      inviteHint: 'On the other machine: Rooms → Join a LAN room, then paste this address and code. Both machines stay open.',
      copy: 'Copy',
      copied: 'Copied',
      lanOff: 'LAN listener is off',
      remoteTag: 'Remote',
      hostedBy: 'hosted by',
      hosted: 'syncing',
      remoteRules: 'Rules and members live on the host; here you can only talk.',
      roomGone: 'The host dissolved this room.',
      goneTag: 'Dissolved',
      removeRoom: 'Remove from list',
      lanPeers: 'machines online',
    }

    /* -------------------------------------------------------------------- CSS */

    /* 只用宿主 token，取不到就退回中性值 —— 明暗主题都不需要单独写一套。
     * 间距按 4/8 栅格走，字号只出现 11/12/13/14 四档。 */
    var CSS = [
      '.cr-main{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary,#e9eaee)}',
      '.cr-grid{display:grid;grid-template-columns:224px minmax(0,1fr) 252px;height:100%;min-height:0}',
      '.cr-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.cr-col+.cr-col{border-left:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}',
      '.cr-col-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;min-height:40px}',
      '.cr-col-title{font-size:13px;font-weight:500;letter-spacing:.01em}',
      '.cr-count{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);font-variant-numeric:tabular-nums}',
      '.cr-grow{flex:1;min-width:0}',
      '.cr-btn{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;color:inherit;font:inherit;font-size:12px;padding:4px 8px;border-radius:8px;cursor:pointer;line-height:1.4;white-space:nowrap}',
      '.cr-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.cr-btn:disabled{opacity:.45;cursor:default}',
      '.cr-btn.cr-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4f7cff);color:#fff}',
      '.cr-btn.cr-primary:hover{filter:brightness(1.08)}',
      '.cr-btn.cr-ghost{border-color:transparent}',
      '.cr-btn.cr-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 38%,transparent)}',
      '.cr-btn.cr-danger:hover{background:color-mix(in srgb,#e5484d 12%,transparent)}',
      '.cr-icon-btn{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;opacity:.6;cursor:pointer;padding:2px 4px;border-radius:6px;line-height:1}',
      '.cr-icon-btn:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}',

      /* 房间列表 */
      '.cr-rooms{overflow:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:2px}',
      '.cr-room{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;cursor:pointer;border:1px solid transparent}',
      '.cr-room:hover{background:color-mix(in srgb,currentColor 6%,transparent)}',
      '.cr-room.cr-active{background:color-mix(in srgb,currentColor 9%,transparent);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.cr-room-top{display:flex;align-items:center;gap:6px}',
      '.cr-room-name{font-size:13px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-room-preview{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-badge{min-width:16px;height:16px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-brand-primary,#4f7cff);color:#fff;font-size:10px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      '.cr-form{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px}',
      '.cr-field{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:color-mix(in srgb,#000 12%,transparent);color:inherit;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;width:100%;box-sizing:border-box}',
      '.cr-field:focus{outline:1px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:-1px}',

      /* 消息列 */
      '.cr-room-head{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));min-height:44px}',
      '.cr-room-title{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-chip{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,#9aa0aa);white-space:nowrap;font-variant-numeric:tabular-nums;max-width:132px;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}',
      '.cr-chip.cr-lan{color:var(--dsw-alias-brand-primary,#4f7cff);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 10%,transparent)}',
      '.cr-flow{flex:1;min-height:0;overflow:auto;padding:12px 16px 8px;display:flex;flex-direction:column;gap:12px}',
      '.cr-msg{display:flex;gap:8px;align-items:flex-start}',
      '.cr-avatar{width:28px;height:28px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:color-mix(in srgb,currentColor 12%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.cr-msg-body{min-width:0;flex:1}',
      '.cr-msg-meta{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-bottom:2px}',
      '.cr-msg-name{font-size:12px;font-weight:500}',
      '.cr-msg-time{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa0aa);font-variant-numeric:tabular-nums}',
      '.cr-msg-text{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
      '.cr-msg-text code{font-size:12px;padding:1px 4px;border-radius:4px;background:color-mix(in srgb,currentColor 10%,transparent)}',
      '.cr-msg-text strong{font-weight:600}',
      '.cr-mention{color:var(--dsw-alias-brand-primary,#4f7cff);font-weight:500}',
      '.cr-msg.cr-mine .cr-avatar{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 40%,transparent)}',
      '.cr-msg.cr-error .cr-msg-text{color:var(--dsw-alias-label-secondary,#9aa0aa);font-style:normal}',
      '.cr-thinking{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);padding-left:36px}',
      '.cr-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.5;animation:cr-pulse 1.4s ease-in-out infinite}',
      '.cr-dot:nth-child(2){animation-delay:.2s}.cr-dot:nth-child(3){animation-delay:.4s}',
      '@keyframes cr-pulse{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:.9;transform:translateY(-1px)}}',

      /* 输入区 */
      '.cr-composer{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));padding:8px 16px 12px;display:flex;flex-direction:column;gap:6px}',
      '.cr-input-row{display:flex;gap:8px;align-items:flex-end}',
      '.cr-textarea{flex:1;min-height:36px;max-height:160px;resize:none;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;background:color-mix(in srgb,#000 10%,transparent);color:inherit;font:inherit;font-size:13px;line-height:1.5;padding:8px 10px;box-sizing:border-box}',
      '.cr-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:-1px}',
      '.cr-composer-foot{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa)}',
      '.cr-mention-pop{position:absolute;bottom:calc(100% - 4px);left:16px;z-index:5;min-width:180px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:var(--dsw-alias-bg-overlay,#171a20);box-shadow:0 12px 32px rgba(0,0,0,.35);padding:4px;display:flex;flex-direction:column;gap:2px}',
      '.cr-pop-row{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;gap:6px;align-items:center}',
      '.cr-pop-row:hover{background:color-mix(in srgb,currentColor 10%,transparent)}',

      /* 成员列 */
      '.cr-members{overflow:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:2px}',
      '.cr-group-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9aa0aa);padding:8px 10px 4px}',
      '.cr-member{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px}',
      '.cr-member:hover{background:color-mix(in srgb,currentColor 6%,transparent)}',
      '.cr-member-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-member-role{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-member .cr-icon-btn{opacity:0}',
      '.cr-member:hover .cr-icon-btn{opacity:.6}',
      '.cr-rules{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;padding:10px 12px;margin:0 12px 12px;display:flex;flex-direction:column;gap:8px;font-size:12px}',
      '.cr-check{display:flex;gap:6px;align-items:center;cursor:pointer;line-height:1.4}',
      '.cr-check input{accent-color:var(--dsw-alias-brand-primary,#4f7cff)}',
      '.cr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa0aa);font-size:12px;line-height:1.6}',

      /* LAN：加入别人的屋子 / 邀请另一台机器 */
      '.cr-col-foot{margin-top:auto;padding:8px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));display:flex;flex-direction:column;gap:8px}',
      '.cr-link-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0aa);font:inherit;font-size:12px;padding:2px 0;cursor:pointer;text-align:left;line-height:1.5}',
      '.cr-link-btn:hover{color:var(--dsw-alias-label-primary,#e9eaee)}',
      '.cr-invite{display:flex;flex-direction:column;gap:8px;margin:0 16px 8px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:color-mix(in srgb,#000 10%,transparent)}',
      '.cr-invite-row{display:flex;align-items:center;gap:8px;font-size:12px;min-height:20px}',
      '.cr-invite-label{color:var(--dsw-alias-label-secondary,#9aa0aa);font-size:11px;width:48px;flex:0 0 48px;white-space:nowrap}',
      '.cr-invite code{font-size:12px;padding:2px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 10%,transparent);font-variant-numeric:tabular-nums}',
      '.cr-invite-note{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);line-height:1.5}',

      /* 悬浮窗 */
      '.cr-float{position:fixed;right:16px;bottom:96px;z-index:70;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:inherit;color:var(--dsw-alias-label-primary,#e9eaee)}',
      '.cr-float-pill{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-overlay,#171a20);box-shadow:0 12px 32px rgba(0,0,0,.32);cursor:pointer;font-size:12px}',
      '.cr-float-card{pointer-events:auto;width:320px;max-height:min(440px,60vh);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-overlay,#171a20);box-shadow:0 20px 56px rgba(0,0,0,.4);overflow:hidden}',
      '.cr-float-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));cursor:grab;user-select:none}',
      '.cr-float-title{font-size:12px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-float-flow{overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;min-height:80px}',
      '.cr-float-msg{font-size:12px;line-height:1.5;word-break:break-word}',
      '.cr-float-who{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa0aa);margin-bottom:1px}',
      '.cr-lan-tag{color:var(--dsw-alias-brand-primary,#4f7cff)}',
      '.cr-float-compose{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));align-items:flex-end}',
      '.cr-float-input{flex:1;min-height:28px;max-height:80px;resize:none;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:8px;background:color-mix(in srgb,#000 10%,transparent);color:inherit;font:inherit;font-size:12px;line-height:1.4;padding:5px 8px;box-sizing:border-box}',

      /* 提醒 */
      '.cr-toast-wrap{position:fixed;right:16px;top:56px;z-index:75;display:flex;flex-direction:column;gap:8px;pointer-events:none}',
      '.cr-toast{pointer-events:auto;max-width:300px;display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-overlay,#171a20);box-shadow:0 12px 32px rgba(0,0,0,.36);font-size:12px;line-height:1.45}',
      '.cr-toast-name{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa)}',
      '.cr-nav-badge{position:absolute;top:-5px;right:-6px;min-width:14px;height:14px;padding:0 4px;border-radius:7px;background:var(--dsw-alias-brand-primary,#4f7cff);color:#fff;font-size:9px;font-weight:600;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      '.cr-error{color:#e5484d;font-size:12px;padding:4px 16px}',
      '@media (max-width:980px){.cr-grid{grid-template-columns:200px minmax(0,1fr)}.cr-col-members{display:none}.cr-float-card{width:280px}}',
    ].join('\n')

    /* ------------------------------------------------------------------ 工具 */

    var t = (key) => ZH[key] ?? key

    function bindLocale(ctx) {
      try {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN })
        }, NS + ':dictionaries')
        return ctx.locale.bind(NS)
      } catch (error) {
        console.warn('[dsh-chatroom] 字典注册失败，改用中文字面量：' + String((error && error.message) || error))
        return (key) => ZH[key] ?? key
      }
    }

    var pad = (n) => (n < 10 ? '0' + n : String(n))
    function clock(iso) {
      var d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    var initial = (name) => (name ? String(name).trim().slice(0, 1).toUpperCase() : '?')

    var escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    /** 极简 Markdown：**粗体**、`代码`、@名字。群聊里够用，别把整颗 markdown 引擎搬进来。 */
    function renderInline(text, members, keyPrefix) {
      var names = (members || []).map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length)
      var out = []
      var lines = String(text || '').split('\n')
      lines.forEach((line, lineIndex) => {
        if (lineIndex > 0) out.push('\n')
        var pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
        var cursor = 0
        var match
        while ((match = pattern.exec(line)) !== null) {
          if (match.index > cursor) out.push(...splitMentions(line.slice(cursor, match.index), names, keyPrefix + ':' + lineIndex + ':' + cursor))
          var token = match[0]
          if (token.startsWith('**')) {
            out.push(h('strong', { key: keyPrefix + ':b:' + match.index }, token.slice(2, -2)))
          } else {
            out.push(h('code', { key: keyPrefix + ':c:' + match.index }, token.slice(1, -1)))
          }
          cursor = match.index + token.length
        }
        if (cursor < line.length) out.push(...splitMentions(line.slice(cursor), names, keyPrefix + ':' + lineIndex + ':t'))
      })
      return out
    }

    function splitMentions(text, names, keyPrefix) {
      if (!names.length) return [text]
      var pattern = new RegExp('@(' + names.map(escapeRegExp).join('|') + ')', 'g')
      var out = []
      var cursor = 0
      var match
      var index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) out.push(text.slice(cursor, match.index))
        out.push(h('span', { className: 'cr-mention', key: keyPrefix + ':m:' + index }, match[0]))
        index += 1
        cursor = match.index + match[0].length
      }
      if (cursor < text.length) out.push(text.slice(cursor))
      return out
    }

    /** 屋里有多少成员是从别的机器进来的：底栏与成员列都要说同一件事。 */
    var lanCount = (members) => (members || []).filter((member) => member.origin && member.origin.kind === 'lan').length

    /* -------------------------------------------------------------- 数据层 */

    function createRpc(ctx) {
      return async function rpc(method, payload, timeoutMs) {
        var connection = ctx.connection || (ctx.get && ctx.get('connection'))
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          throw Object.assign(new Error('连接服务不可用'), { code: 'connection_unavailable' })
        }
        var signal = AbortSignal.timeout(timeoutMs || 30000)
        var reply = await connection.rpc.call('/api', 'dsh.chatroom/' + method, payload || {}, signal)
        if (!reply || reply.ok !== true) {
          var error = (reply && reply.error) || {}
          throw Object.assign(new Error(error.message || '请求未完成'), { code: error.code || 'rpc_failed' })
        }
        return reply.value
      }
    }

    function createStore(rpc) {
      var listeners = new Set()
      var state = {
        snapshot: null,
        error: '',
        loading: true,
        panelMounted: false,
        floatOpen: false,
        floatPos: null,
        notice: null,
        pending: [],
        lastUnread: 0,
      }
      var watching = false
      var stopped = false

      function get() {
        return state
      }
      function set(patch) {
        state = Object.assign({}, state, patch)
        for (var listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.warn('[dsh-chatroom] listener failed: ' + String(error))
          }
        }
      }
      function subscribe(listener) {
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      }

      function activeRoom() {
        var snapshot = state.snapshot
        if (!snapshot) return null
        return snapshot.rooms.find((room) => room.id === snapshot.activeRoomId) || snapshot.rooms[0] || null
      }

      function totalUnread() {
        var snapshot = state.snapshot
        if (!snapshot) return 0
        return snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0)
      }

      function applySnapshot(snapshot) {
        var unread = snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0)
        var notice = state.notice
        if (state.snapshot && unread > state.lastUnread && !state.floatOpen) {
          var room = snapshot.rooms.find((row) => row.id === snapshot.activeRoomId) || snapshot.rooms[0]
          var last = room && room.messages[room.messages.length - 1]
          if (last && last.authorKind === 'bot') {
            notice = { id: last.id, name: last.authorName, text: last.text, room: room.name, at: Date.now() }
          }
        }
        set({ snapshot: snapshot, loading: false, error: '', notice: notice, lastUnread: unread })
      }

      async function refresh() {
        try {
          var snapshot = await rpc('snapshot', {})
          if (!stopped) applySnapshot(snapshot)
          return snapshot
        } catch (error) {
          set({ error: String((error && error.message) || error), loading: false })
          return null
        }
      }

      async function watchLoop() {
        if (watching || stopped) return
        watching = true
        while (!stopped) {
          var since = state.snapshot ? state.snapshot.revision : -1
          try {
            var snapshot = await rpc('watch', { since: since }, 60000)
            if (stopped) break
            applySnapshot(snapshot)
          } catch (error) {
            if (stopped) break
            // 长轮询断了就等一下再续上；401/disabled 这类不再重试。
            var code = error && error.code
            if (code === 'disabled' || code === 'connection_unavailable') break
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
        }
        watching = false
      }

      async function command(action, input) {
        set({ error: '' })
        try {
          var snapshot = await rpc('command', { action: action, input: input || {} })
          var pending = state.pending
          if (action === 'msg.send') {
            pending = pending.filter((row) => row.action !== 'msg.send')
          }
          set({ pending: pending })
          applySnapshot(snapshot)
          return snapshot
        } catch (error) {
          set({ error: String((error && error.message) || error), pending: [] })
          throw error
        }
      }

      function send(roomId, text, mentions) {
        var opKey = 'k_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
        var pending = state.pending.concat([
          { opKey: opKey, action: 'msg.send', roomId: roomId, text: text, at: new Date().toISOString() },
        ])
        set({ pending: pending })
        return command('msg.send', { roomId: roomId, text: text, mentions: mentions || [], opKey: opKey }).catch(() => {})
      }

      return {
        get: get,
        subscribe: subscribe,
        set: set,
        activeRoom: activeRoom,
        totalUnread: totalUnread,
        refresh: refresh,
        watchLoop: watchLoop,
        command: command,
        send: send,
        stop: function () {
          stopped = true
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    /* -------------------------------------------------------------- 组件 */

    function NavIcon(props) {
      var snapshot = (props && props.store ? props.store.get().snapshot : null) || null
      var unread = snapshot ? snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0) : 0
      var size = props && typeof props.size === 'number' ? props.size : 18
      var color = props && props.active ? 'var(--dsw-alias-brand-primary,#4f7cff)' : 'currentColor'
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', width: '18px', height: '18px' } },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M2.4 5.2c0-1 .8-1.8 1.8-1.8h9.6c1 0 1.8.8 1.8 1.8v5.3c0 1-.8 1.8-1.8 1.8H7.6L4.2 15v-2.7h0c-1 0-1.8-.8-1.8-1.8V5.2Z',
            stroke: color,
            strokeWidth: '1.5',
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M5.9 6.6h6.2M5.9 9.2h4', stroke: color, strokeWidth: '1.5', strokeLinecap: 'round' }),
        ),
        unread > 0 ? h('span', { className: 'cr-nav-badge' }, unread > 99 ? '99+' : String(unread)) : null,
      )
    }

    function Avatar(props) {
      var member = props.member
      var tint = member && member.kind === 'bot' ? 'var(--dsw-alias-brand-primary,#4f7cff)' : 'currentColor'
      return h(
        'div',
        { className: 'cr-avatar', style: { color: tint }, title: member ? member.name : '' },
        initial(props.name || (member && member.name)),
      )
    }

    function OriginChip(props) {
      var member = props.member
      var tr = props.tr
      var lan = member.origin && member.origin.kind === 'lan'
      // 认机器比认 IP 有用：192.168.1.42 谁都记不住，「周荻的 MacBook」一眼就知道是谁。
      var who = member.origin && (member.origin.machine || member.origin.peer)
      var label = lan ? tr('lan') + (who ? ' · ' + who : '') : tr('local')
      // 成员列窄：只留「LAN」，完整机器名放 title；消息行有位置，照旧写全。
      return h(
        'span',
        { className: 'cr-chip' + (lan ? ' cr-lan' : ''), title: label },
        props.compact && lan ? tr('lan') : label,
      )
    }

    /** 邀请另一台机器：地址 + 房间码就是全部凭据，抄过去即可，不用账号。 */
    function InviteBar(props) {
      var room = props.room
      var lan = props.lan || {}
      var tr = props.tr
      var [copied, setCopied] = React.useState(false)
      var address = lan.serving
        ? (lan.addresses && lan.addresses.length ? lan.addresses[0].address : '127.0.0.1') + ':' + lan.port
        : ''
      if (!lan.serving) {
        return h(
          'div',
          { className: 'cr-invite' },
          h('div', { className: 'cr-invite-note' }, tr('lanOff') + (lan.error ? '：' + lan.error : '')),
        )
      }
      var copy = function () {
        try {
          navigator.clipboard.writeText(address + ' ' + room.code).then(
            function () {
              setCopied(true)
              setTimeout(function () {
                setCopied(false)
              }, 1600)
            },
            function () {},
          )
        } catch (error) {
          /* 剪贴板不可用时不影响看地址 */
        }
      }
      return h(
        'div',
        { className: 'cr-invite' },
        h(
          'div',
          { className: 'cr-invite-row' },
          h('span', { className: 'cr-invite-label' }, tr('inviteAddress')),
          h('code', null, address),
          h('span', { className: 'cr-grow' }),
          h('button', { className: 'cr-btn cr-ghost', onClick: copy }, copied ? tr('copied') : tr('copy')),
        ),
        h(
          'div',
          { className: 'cr-invite-row' },
          h('span', { className: 'cr-invite-label' }, tr('code')),
          h('code', null, room.code),
          lan.peers && lan.peers.length
            ? h('span', { className: 'cr-chip cr-lan' }, lan.peers.length + ' ' + tr('lanPeers'))
            : null,
        ),
        h('div', { className: 'cr-invite-note' }, tr('inviteHint')),
      )
    }

    function MessageRow(props) {
      var message = props.message
      var members = props.members
      var tr = props.tr
      var mine = message.authorId === props.selfId
      var author = members.find((member) => member.id === message.authorId) || {
        name: message.authorName,
        kind: message.authorKind,
        origin: message.origin,
      }
      return h(
        'div',
        { className: 'cr-msg' + (mine ? ' cr-mine' : '') + (message.status === 'error' ? ' cr-error' : '') },
        h(Avatar, { member: author, name: message.authorName }),
        h(
          'div',
          { className: 'cr-msg-body' },
          h(
            'div',
            { className: 'cr-msg-meta' },
            h('span', { className: 'cr-msg-name' }, message.authorName + (mine ? '（' + tr('you') + '）' : '')),
            h(OriginChip, { member: author, tr: tr }),
            message.authorKind === 'bot' ? h('span', { className: 'cr-chip' }, 'agent') : null,
            h('span', { className: 'cr-msg-time' }, clock(message.at)),
          ),
          h('div', { className: 'cr-msg-text' }, renderInline(message.text, members, 'm' + message.seq)),
        ),
      )
    }

    function RoomList(props) {
      var snapshot = props.snapshot
      var store = props.store
      var tr = props.tr
      var creating = props.creating
      var formName = props.formName
      var formTopic = props.formTopic
      return h(
        'div',
        { className: 'cr-col' },
        h(
          'div',
          { className: 'cr-col-head' },
          h('span', { className: 'cr-col-title' }, tr('title')),
          h('span', { className: 'cr-count' }, String(snapshot.rooms.length)),
          h('span', { className: 'cr-grow' }),
          h(
            'button',
            { className: 'cr-btn cr-ghost', onClick: props.onToggleCreate, title: tr('newRoom') },
            creating ? tr('cancel') : '+ ' + tr('newRoom'),
          ),
        ),
        creating
          ? h(
              'div',
              { className: 'cr-form' },
              h('input', {
                className: 'cr-field',
                placeholder: tr('roomName'),
                value: formName,
                autoFocus: true,
                onChange: (event) => props.onFormName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') props.onCreate()
                },
              }),
              h('input', {
                className: 'cr-field',
                placeholder: tr('roomTopic'),
                value: formTopic,
                onChange: (event) => props.onFormTopic(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') props.onCreate()
                },
              }),
              h(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                h('button', { className: 'cr-btn cr-primary', disabled: !formName.trim(), onClick: props.onCreate }, tr('create')),
                h('button', { className: 'cr-btn cr-ghost', onClick: props.onToggleCreate }, tr('cancel')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cr-rooms' },
          snapshot.rooms.length === 0
            ? h('div', { className: 'cr-empty', style: { height: 'auto', paddingTop: '24px' } }, h('div', null, tr('empty')), h('div', null, tr('emptyHint')))
            : snapshot.rooms.map((room) =>
                h(
                  'div',
                  {
                    key: room.id,
                    className: 'cr-room' + (room.id === snapshot.activeRoomId ? ' cr-active' : ''),
                    onClick: () => props.onActivate(room.id),
                  },
                  h(
                    'div',
                    { className: 'cr-room-top' },
                    h('span', { className: 'cr-room-name' }, room.name),
                    room.remote ? h('span', { className: 'cr-chip cr-lan' }, tr('remoteTag')) : null,
                    room.unread > 0 ? h('span', { className: 'cr-badge' }, room.unread > 99 ? '99+' : String(room.unread)) : null,
                  ),
                  h(
                    'span',
                    { className: 'cr-room-preview' },
                    (room.messages.length ? room.messages[room.messages.length - 1].authorName + '：' + room.messages[room.messages.length - 1].text : tr('emptyPreview')) || '',
                  ),
                ),
              ),
        ),
        // LAN 入口放左栏底部：不抢「新建房间」的位置，也不用多一个图标。
        h(
          'div',
          { className: 'cr-col-foot' },
          props.joinOpen
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('joinAddress'),
                  value: props.joinHost,
                  autoFocus: true,
                  onChange: (event) => props.onJoinHost(event.target.value),
                }),
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('joinCode'),
                  value: props.joinCode,
                  style: { textTransform: 'uppercase' },
                  onChange: (event) => props.onJoinCode(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') props.onJoin()
                  },
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    {
                      className: 'cr-btn cr-primary',
                      disabled: !(props.joinHost.trim() && props.joinCode.trim()),
                      onClick: props.onJoin,
                    },
                    tr('join'),
                  ),
                  h('button', { className: 'cr-btn cr-ghost', onClick: props.onToggleJoin }, tr('cancel')),
                ),
              )
            : h(
                'button',
                { className: 'cr-link-btn', onClick: props.onToggleJoin },
                '+ ' + tr('joinLan'),
              ),
        ),
      )
    }

    function Composer(props) {
      var room = props.room
      var tr = props.tr
      var members = room.members
      var canMention = members.filter((member) => member.kind === 'bot')
      // 宿主解散了这间屋子：镜像还在（能看历史），但已经没有可以写进去的地方。
      var gone = Boolean(room.remote && room.remote.lost)
      return h(
        'div',
        { className: 'cr-composer', style: { position: 'relative' } },
        props.mentionOpen
          ? h(
              'div',
              { className: 'cr-mention-pop' },
              canMention.length === 0
                ? h('div', { className: 'cr-pop-row', style: { cursor: 'default', opacity: 0.6 } }, '屋里还没有 agent')
                : canMention.map((member) =>
                    h(
                      'button',
                      {
                        key: member.id,
                        className: 'cr-pop-row',
                        onClick: () => props.onMention(member),
                      },
                      h(Avatar, { member: member, name: member.name }),
                      h('span', null, member.name),
                    ),
                  ),
            )
          : null,
        h(
          'div',
          { className: 'cr-input-row' },
          h('textarea', {
            className: 'cr-textarea',
            placeholder: gone ? tr('roomGone') : tr('sendHint'),
            value: props.draft,
            rows: 1,
            disabled: gone,
            onChange: (event) => props.onDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                props.onSend()
              } else if (event.key === '@') {
                props.onMentionOpen(true)
              } else if (event.key === 'Escape') {
                props.onMentionOpen(false)
              }
            },
          }),
          h(
            'button',
            {
              className: 'cr-btn cr-ghost',
              title: tr('sendHint'),
              disabled: gone,
              onClick: () => props.onMentionOpen(!props.mentionOpen),
            },
            '@',
          ),
          h(
            'button',
            { className: 'cr-btn cr-primary', disabled: gone || !props.draft.trim(), onClick: props.onSend },
            tr('send'),
          ),
        ),
        h(
          'div',
          { className: 'cr-composer-foot' },
          gone
            ? null
            : room.activity && room.activity.speaking && room.activity.speaking.length
              ? h('span', null, tr('speaking') + ' ' + room.activity.speaking.join('、'))
              : h(
                  'span',
                  null,
                  room.members.length + ' ' + tr('people') + ' · ' + lanCount(members) + ' ' + tr('lan'),
                ),
          h('span', { className: 'cr-grow' }),
          room.remote
            ? gone
              ? null
              : h('span', { className: 'cr-chip' }, tr('hosted'))
            : h(
                'button',
                {
                  className: 'cr-btn cr-ghost',
                  disabled: Boolean(room.activity && room.activity.speaking && room.activity.speaking.length),
                  onClick: props.onRound,
                },
                room.activity && room.activity.speaking && room.activity.speaking.length ? tr('stop') : tr('round'),
              ),
        ),
      )
    }

    function MembersColumn(props) {
      var room = props.room
      var tr = props.tr
      var people = room.members.filter((member) => member.kind === 'human')
      var agents = room.members.filter((member) => member.kind === 'bot')
      var row = (member) =>
        h(
          'div',
          { key: member.id, className: 'cr-member' },
          h(Avatar, { member: member, name: member.name }),
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'cr-member-name' }, member.name),
            h('div', { className: 'cr-member-role' }, member.role || (member.kind === 'bot' ? 'agent' : '人')),
          ),
          h(OriginChip, { member: member, tr: tr, compact: true }),
          member.id === props.selfId || props.remote
            ? null
            : h(
                'button',
                { className: 'cr-icon-btn', title: tr('remove'), onClick: () => props.onRemove(member.id) },
                '×',
              ),
        )
      return h(
        'div',
        { className: 'cr-col cr-col-members' },
        h(
          'div',
          { className: 'cr-col-head' },
          h('span', { className: 'cr-col-title' }, tr('members')),
          h('span', { className: 'cr-count' }, String(room.members.length)),
        ),
        h(
          'div',
          { className: 'cr-members' },
          h('div', { className: 'cr-group-label' }, tr('people')),
          people.map(row),
          h('div', { className: 'cr-group-label' }, tr('agents')),
          agents.length ? agents.map(row) : h('div', { className: 'cr-member', style: { opacity: 0.6 } }, '还没有 agent'),
          props.remote
            ? null
            : h(
                'button',
                { className: 'cr-btn cr-ghost', style: { margin: '8px 2px 0' }, onClick: props.onAddAgent },
                '+ ' + tr('addAgent'),
              ),
          props.pickingAgent && props.directory.length
            ? h(
                'div',
                { className: 'cr-mention-pop', style: { position: 'static', marginTop: '8px' } },
                props.directory.map((bot) =>
                  h(
                    'button',
                    { key: bot.id, className: 'cr-pop-row', onClick: () => props.onPickAgent(bot.id) },
                    bot.name,
                  ),
                ),
              )
            : null,
        ),
        props.rulesOpen && !props.remote
          ? h(
              'div',
              { className: 'cr-rules' },
              h(
                'label',
                { className: 'cr-check' },
                h('input', {
                  type: 'checkbox',
                  checked: room.rules.mention,
                  onChange: (event) => props.onRules({ mention: event.target.checked }),
                }),
                h('span', null, tr('ruleMention')),
              ),
              h(
                'label',
                { className: 'cr-check' },
                h('input', {
                  type: 'checkbox',
                  checked: room.rules.roundRobin,
                  onChange: (event) => props.onRules({ roundRobin: event.target.checked }),
                }),
                h('span', null, tr('ruleRound')),
              ),
              h(
                'label',
                { className: 'cr-check', style: { flexWrap: 'wrap' } },
                h('span', null, tr('ruleChair')),
                h(
                  'select',
                  {
                    className: 'cr-field',
                    style: { width: 'auto', flex: 1 },
                    value: room.rules.chairId || '',
                    onChange: (event) => props.onRules({ chairId: event.target.value || null }),
                  },
                  h('option', { value: '' }, tr('chairNone')),
                  agents.map((member) => h('option', { key: member.id, value: member.id }, member.name)),
                ),
              ),
              h(
                'label',
                { className: 'cr-check', style: { flexWrap: 'nowrap' } },
                h('span', { style: { whiteSpace: 'nowrap' } }, tr('maxSpeakers')),
                h('input', {
                  className: 'cr-field',
                  style: { width: '48px', flex: '0 0 48px' },
                  type: 'number',
                  min: 1,
                  max: 8,
                  value: room.rules.maxSpeakers,
                  onChange: (event) => props.onRules({ maxSpeakers: Number(event.target.value) }),
                }),
                h('span', { style: { whiteSpace: 'nowrap' } }, tr('speakersUnit')),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
                h('button', { className: 'cr-btn cr-danger', onClick: props.onDissolve }, tr('dissolve')),
              ),
            )
          : null,
        props.remote
          ? h(
              'div',
              { className: 'cr-col-foot' },
              room.remote && room.remote.lost
                ? h('div', { className: 'cr-invite-note', style: { color: '#e5484d' } }, tr('roomGone'))
                : props.link && props.link.status === 'offline'
                  ? h('div', { className: 'cr-invite-note', style: { color: '#e5484d' } }, props.link.error || '离线')
                  : h('div', { className: 'cr-invite-note' }, tr('remoteRules')),
              h(
                'button',
                { className: 'cr-btn cr-danger', onClick: props.onLeaveRemote },
                room.remote && room.remote.lost ? tr('removeRoom') : tr('leaveLan'),
              ),
            )
          : null,
      )
    }

    function RoomsPanel(props) {
      var store = props.store
      var tr = props.tr
      var view = useStore(store)
      var snapshot = view.snapshot
      var ui = props.ui

      React.useEffect(() => {
        store.set({ panelMounted: true })
        if (!view.snapshot) store.refresh()
        return () => store.set({ panelMounted: false })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      if (!snapshot) {
        return h('div', { className: 'cr-main' }, h('div', { className: 'cr-empty' }, view.error || '…'))
      }
      var room = store.activeRoom()
      var pending = view.pending.filter((row) => !room || row.roomId === room.id)

      function send() {
        if (!room) return
        var text = ui.draft.trim()
        if (!text) return
        var mentions = room.members
          .filter((member) => text.includes('@' + member.name))
          .map((member) => member.id)
        ui.setDraft('')
        store.send(room.id, text, mentions)
      }

      return h(
        'div',
        { className: 'cr-main' },
        view.error ? h('div', { className: 'cr-error' }, tr('error') + '：' + view.error) : null,
        h(
          'div',
          { className: 'cr-grid' },
          h(RoomList, {
            snapshot: snapshot,
            store: store,
            tr: tr,
            creating: ui.creating,
            formName: ui.formName,
            formTopic: ui.formTopic,
            joinOpen: ui.joinOpen,
            joinHost: ui.joinHost,
            joinCode: ui.joinCode,
            onToggleCreate: () => ui.setCreating(!ui.creating),
            onFormName: ui.setFormName,
            onFormTopic: ui.setFormTopic,
            onToggleJoin: () => ui.setJoinOpen(!ui.joinOpen),
            onJoinHost: ui.setJoinHost,
            onJoinCode: ui.setJoinCode,
            onJoin: () => {
              var host = ui.joinHost.trim()
              var code = ui.joinCode.trim().toUpperCase()
              if (!host || !code) return
              store
                .command('lan.join', { host: host, code: code })
                .then(() => {
                  ui.setJoinHost('')
                  ui.setJoinCode('')
                  ui.setJoinOpen(false)
                })
                .catch(() => {})
            },
            onCreate: () => {
              var name = ui.formName.trim()
              if (!name) return
              store.command('room.create', { name: name, topic: ui.formTopic.trim() }).then(() => {
                ui.setFormName('')
                ui.setFormTopic('')
                ui.setCreating(false)
              })
            },
            onActivate: (roomId) => store.command('room.activate', { roomId: roomId }),
          }),
          room
            ? h(
                'div',
                { className: 'cr-col' },
                h(
                  'div',
                  { className: 'cr-room-head' },
                  h('span', { className: 'cr-room-title' }, room.name),
                  room.remote
                    ? h(
                        'span',
                        { className: 'cr-chip cr-lan' },
                        tr('hostedBy') + ' ' + (room.remote.machine || room.remote.host),
                      )
                    : h('span', { className: 'cr-chip' }, tr('code') + ' ' + room.code),
                  room.remote && room.remote.lost
                    ? h(
                        'span',
                        { className: 'cr-chip cr-lan', style: { color: '#e5484d', borderColor: 'rgba(229,72,77,.45)' } },
                        tr('goneTag'),
                      )
                    : null,
                  room.topic ? h('span', { className: 'cr-chip' }, room.topic) : null,
                  h('span', { className: 'cr-grow' }),
                  room.remote
                    ? null
                    : h(
                        'button',
                        { className: 'cr-btn cr-ghost', onClick: () => ui.setInviteOpen(!ui.inviteOpen) },
                        tr('invite'),
                      ),
                  room.remote
                    ? null
                    : h(
                        'button',
                        { className: 'cr-btn cr-ghost', onClick: () => ui.setRulesOpen(!ui.rulesOpen) },
                        tr('rules'),
                      ),
                ),
                !room.remote && ui.inviteOpen ? h(InviteBar, { room: room, lan: snapshot.lan, tr: tr }) : null,
                h(
                  'div',
                  { className: 'cr-flow' },
                  room.messages.length === 0
                    ? h('div', { className: 'cr-empty' }, tr('noMessages'))
                    : room.messages.map((message) =>
                        h(MessageRow, {
                          key: message.id,
                          message: message,
                          members: room.members,
                          selfId: snapshot.self.id,
                          tr: tr,
                        }),
                      ),
                  pending.map((row) =>
                    h(MessageRow, {
                      key: row.opKey,
                      message: {
                        id: row.opKey,
                        seq: -1,
                        at: row.at,
                        authorId: snapshot.self.id,
                        authorName: snapshot.self.name,
                        authorKind: 'human',
                        text: row.text,
                        status: 'sent',
                        origin: { kind: 'local' },
                      },
                      members: room.members,
                      selfId: snapshot.self.id,
                      tr: tr,
                    }),
                  ),
                  room.activity && room.activity.speaking && room.activity.speaking.length
                    ? h(
                        'div',
                        { className: 'cr-thinking' },
                        h('span', null, tr('speaking') + ' ' + room.activity.speaking.join('、')),
                        h('span', { className: 'cr-dot' }),
                        h('span', { className: 'cr-dot' }),
                        h('span', { className: 'cr-dot' }),
                      )
                    : null,
                  room.truncated ? h('div', { className: 'cr-thinking' }, tr('trunc')) : null,
                ),
                h(Composer, {
                  room: room,
                  tr: tr,
                  draft: ui.draft,
                  mentionOpen: ui.mentionOpen,
                  onDraft: ui.setDraft,
                  onMentionOpen: ui.setMentionOpen,
                  onMention: (member) => {
                    var next = ui.draft + (ui.draft && !ui.draft.endsWith(' ') ? ' ' : '') + '@' + member.name + ' '
                    ui.setDraft(next)
                    ui.setMentionOpen(false)
                  },
                  onSend: send,
                  onRound: () => {
                    var speaking = room.activity && room.activity.speaking && room.activity.speaking.length
                    return speaking ? store.command('round.stop', { roomId: room.id }) : store.command('round.run', { roomId: room.id })
                  },
                }),
              )
            : h('div', { className: 'cr-col' }, h('div', { className: 'cr-empty' }, tr('emptyHint'))),
          room
            ? h(MembersColumn, {
                room: room,
                tr: tr,
                selfId: snapshot.self.id,
                rulesOpen: ui.rulesOpen,
                pickingAgent: ui.pickingAgent,
                remote: Boolean(room.remote),
                link: (snapshot.links || []).find((link) => link.localRoomId === room.id) || null,
                directory: snapshot.bots.filter((bot) => !room.members.some((member) => member.botId === bot.id)),
                onRules: (patch) => store.command('room.update', { roomId: room.id, rules: patch }),
                onRemove: (memberId) => store.command('member.remove', { roomId: room.id, memberId: memberId }),
                onDissolve: () => store.command('room.dissolve', { roomId: room.id }),
                onLeaveRemote: () => {
                  var found = (snapshot.links || []).find((link) => link.localRoomId === room.id)
                  if (found) store.command('lan.leave', { linkId: found.id }).catch(() => {})
                },
                onAddAgent: () => {
                  if (ui.pickingAgent) ui.setPickingAgent(false)
                  else if (view.snapshot.bots.length === 0) {
                    var name = window.prompt('这个 agent 叫什么？')
                    if (name) store.command('member.createBot', { roomId: room.id, name: name, role: '' })
                  } else ui.setPickingAgent(true)
                },
                onPickAgent: (botId) => {
                  ui.setPickingAgent(false)
                  store.command('member.addBot', { roomId: room.id, botId: botId })
                },
              })
            : null,
        ),
      )
    }

    /** 悬浮窗：会话界面里那块独立的聊天框。 */
    function useFloat(store, tr, room) {
      var view = useStore(store)
      var dragRef = React.useRef(null)
      var [draft, setDraft] = React.useState('')

      React.useEffect(() => {
        if (!view.floatOpen) return undefined
        function onMove(event) {
          if (!dragRef.current) return
          store.set({ floatPos: { x: event.clientX - dragRef.current.dx, y: event.clientY - dragRef.current.dy } })
        }
        function onUp() {
          dragRef.current = null
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return function () {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
      }, [view.floatOpen])

      if (!room) return null
      var style = view.floatPos
        ? { right: 'auto', bottom: 'auto', left: view.floatPos.x + 'px', top: view.floatPos.y + 'px' }
        : null
      var messages = room.messages.filter((message) => message.status !== 'error').slice(-6)

      if (!view.floatOpen) {
        return h(
          'div',
          { className: 'cr-float', style: style },
          h(
            'button',
            {
              className: 'cr-float-pill',
              onClick: () => store.set({ floatOpen: true, notice: null }),
              title: tr('floatOpen'),
            },
            h(NavIcon, { store: store, size: 14 }),
            h('span', null, room.name),
            room.unread > 0 ? h('span', { className: 'cr-badge' }, String(room.unread)) : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'cr-float', style: style },
        h(
          'div',
          { className: 'cr-float-card' },
          h(
            'div',
            {
              className: 'cr-float-head',
              onPointerDown: (event) => {
                var rect = event.currentTarget.parentElement.getBoundingClientRect()
                dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
              },
            },
            h('span', { className: 'cr-float-title' }, room.name),
            h(
              'button',
              { className: 'cr-icon-btn', title: tr('floatClose'), onClick: () => store.set({ floatOpen: false }) },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'cr-float-flow' },
            messages.length === 0
              ? h('div', { className: 'cr-float-msg', style: { opacity: 0.6 } }, tr('noMessages'))
              : messages.map((message) =>
                  h(
                    'div',
                    { key: message.id, className: 'cr-float-msg' },
                    h(
                      'div',
                      { className: 'cr-float-who' },
                      message.origin && message.origin.kind === 'lan'
                        ? h(
                            'span',
                            { className: 'cr-lan-tag' },
                            tr('lan') +
                              ' ' +
                              (message.origin.machine || message.origin.peer || '') +
                              ' · ',
                          )
                        : null,
                      message.authorName + ' · ' + clock(message.at),
                    ),
                    h('div', null, renderInline(message.text, room.members, 'f' + message.seq)),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'cr-float-compose' },
            h('textarea', {
              className: 'cr-float-input',
              placeholder: tr('sendHint'),
              value: draft,
              rows: 1,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  var text = draft.trim()
                  if (!text) return
                  setDraft('')
                  store.send(room.id, text, [])
                }
              },
            }),
            h(
              'button',
              {
                className: 'cr-btn cr-primary',
                disabled: !draft.trim(),
                onClick: () => {
                  var text = draft.trim()
                  if (!text) return
                  setDraft('')
                  store.send(room.id, text, [])
                },
              },
              tr('send'),
            ),
          ),
        ),
      )
    }

    function props_openPanel(store) {
      // 主面板是 sidebar 的独立面板，浏览器里没有跨插件的路由 API，
      // 所以这里只负责把悬浮窗收起，让用户从侧栏进入面板。
      store.set({ floatOpen: false })
    }

    /** 侧栏图标的未读计数必须订阅，否则图标上的数字不会跟着房间变。 */
    function NavEntry(props) {
      useStore(props.store)
      return h(NavIcon, { store: props.store })
    }

    function ToastHost(props) {
      var view = useStore(props.store)
      var [dismissed, setDismissed] = React.useState(null)
      React.useEffect(() => {
        if (!view.notice) return undefined
        var id = view.notice.id
        var timer = setTimeout(function () {
          setDismissed(id)
          props.store.set({ notice: null })
        }, 5000)
        return () => clearTimeout(timer)
      }, [view.notice && view.notice.id])
      if (!view.notice || dismissed === view.notice.id) return null
      return h(
        'div',
        { className: 'cr-toast-wrap' },
        h(
          'div',
          { className: 'cr-toast', onClick: () => props.store.set({ floatOpen: true, notice: null }) },
          h('div', { className: 'cr-toast-name' }, view.notice.room + ' · ' + view.notice.name),
          h('div', null, view.notice.text.slice(0, 120)),
        ),
      )
    }

    function SessionToggle(props) {
      var view = useStore(props.store)
      var unread = view.snapshot
        ? view.snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0)
        : 0
      return h(
        'button',
        {
          className: 'cr-btn cr-ghost',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px', position: 'relative' },
          onClick: () => props.store.set({ floatOpen: !view.floatOpen, notice: null }),
          title: props.tr('floatOpen'),
        },
        h(NavIcon, { store: props.store, size: 14 }),
        h('span', null, props.tr('floatOpen')),
        unread > 0 ? h('span', { className: 'cr-badge', style: { marginLeft: '2px' } }, String(unread)) : null,
      )
    }

    /* --------------------------------------------------------------- 挂载 */

    function apply(ctx) {
      var tr = bindLocale(ctx)

      ctx.effect(function () {
        var el = document.createElement('style')
        el.setAttribute('data-dsh-chatroom', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () {
          el.remove()
        }
      }, 'dsh-chatroom: styles')

      var rpc = createRpc(ctx)
      var store = createStore(rpc)

      // 未读提醒：页面标题前缀，标签页不聚焦时也看得见。
      var baseTitle = document.title
      var unsubscribe = store.subscribe(function () {
        var unread = store.totalUnread()
        document.title = unread > 0 ? '(' + unread + ') ' + baseTitle : baseTitle
      })

      // 全局只跑一条长轮询，面板与悬浮窗共享同一份快照。
      store.refresh().then(function () {
        store.watchLoop()
      })

      ctx.effect(function () {
        return function () {
          store.stop()
          unsubscribe()
          document.title = baseTitle
        }
      }, 'dsh-chatroom: lifetime')

      var slots = ctx.slots
      var uiState = {
        draft: '',
        creating: false,
        formName: '',
        formTopic: '',
        rulesOpen: false,
        pickingAgent: false,
        mentionOpen: false,
        inviteOpen: false,
        joinOpen: false,
        joinHost: '',
        joinCode: '',
      }
      var uiListeners = new Set()
      function useUi() {
        return React.useSyncExternalStore(
          function (listener) {
            uiListeners.add(listener)
            return function () {
              uiListeners.delete(listener)
            }
          },
          function () {
            return uiState
          },
          function () {
            return uiState
          },
        )
      }
      function setUi(patch) {
        uiState = Object.assign({}, uiState, patch)
        for (var listener of uiListeners) listener()
      }
      var ui = {
        get draft() {
          return uiState.draft
        },
        setDraft: (value) => setUi({ draft: value }),
        get creating() {
          return uiState.creating
        },
        setCreating: (value) => setUi({ creating: value }),
        get formName() {
          return uiState.formName
        },
        setFormName: (value) => setUi({ formName: value }),
        get formTopic() {
          return uiState.formTopic
        },
        setFormTopic: (value) => setUi({ formTopic: value }),
        get rulesOpen() {
          return uiState.rulesOpen
        },
        setRulesOpen: (value) => setUi({ rulesOpen: value }),
        get pickingAgent() {
          return uiState.pickingAgent
        },
        setPickingAgent: (value) => setUi({ pickingAgent: value }),
        get mentionOpen() {
          return uiState.mentionOpen
        },
        setMentionOpen: (value) => setUi({ mentionOpen: value }),
        get inviteOpen() {
          return uiState.inviteOpen
        },
        setInviteOpen: (value) => setUi({ inviteOpen: value }),
        get joinOpen() {
          return uiState.joinOpen
        },
        setJoinOpen: (value) => setUi({ joinOpen: value }),
        get joinHost() {
          return uiState.joinHost
        },
        setJoinHost: (value) => setUi({ joinHost: value }),
        get joinCode() {
          return uiState.joinCode
        },
        setJoinCode: (value) => setUi({ joinCode: value }),
      }

      function Panel() {
        // 面板重新挂载时把 ui 也挂起来，保证 useSyncExternalStore 有两份订阅。
        useUi()
        return h(RoomsPanel, { store: store, tr: tr, ui: ui })
      }

      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: function () { return tr('nav') } },
          function NavEntryBinding() {
            return h(NavEntry, { store: store })
          },
        )
      })
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: PANEL_ID }, Panel)
      })

      try {
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'chatroom-toggle',
              order: 200,
              label: function () { return tr('floatOpen') },
            },
            function HeaderEntry() {
              return h(SessionToggle, { store: store, tr: tr })
            },
          )
        })
      } catch (error) {
        console.warn('[dsh-chatroom] 会话头部入口未注册：' + String((error && error.message) || error))
      }

      try {
        slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'chatroom-float', order: 20, label: function () { return tr('floatOpen') } },
            function FloatEntry() {
              var room = store.activeRoom()
              return h('div', null, useFloat(store, tr, room), h(ToastHost, { store: store }))
            },
          )
        })
      } catch (error) {
        console.warn('[dsh-chatroom] 悬浮窗未注册：' + String((error && error.message) || error))
      }
    }

    module.exports = { name: 'dsh-chatroom', inject: ['slots', 'locale'], apply: apply }
    return module.exports
  },
})
