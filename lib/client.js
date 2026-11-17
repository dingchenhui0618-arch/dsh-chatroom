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
 * 数据只有一个来源：Host 半边的 /api/dsh.chatroom/* 四个端点。
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

    /**
     * 这一下回车是不是输入法在「选词」。
     *
     * 中文/日文输入法开着的时候，回车先是把候选词落进输入框，那一下浏览器标成
     * isComposing（老输入法只给 keyCode 229）。不认这个标记，拼音打到一半按回车
     * 就会把半截话发进屋里 —— 用户看到的是一句拼音加几个错字，还得自己撤回。
     *
     * React 的合成事件不带 isComposing，得看 nativeEvent。
     */
    function imePicking(event) {
      return Boolean(event.nativeEvent && event.nativeEvent.isComposing) || event.keyCode === 229
    }

    /* ------------------------------------------------------------------ 文案 */

    var ZH = {
      nav: '聊天室',
      title: '聊天室',
      empty: '还没有房间',
      emptyHint: '建一间屋子，把你的 agent 拉进来一起说事。',
      emptyPreview: '还没有消息',
      firstTitle: '房间在你自己的机器上',
      firstText: '建一间屋子，把你的 agent 拉进来一起说事。同一 Wi-Fi 下另一台机器用地址和六位房间码进屋，轮到它的 agent 时那台机器用自己的会话回话。',
      firstNote: '每条消息引出几个回复、agent 之间最多接力几层，都在「规则」里定 —— 一屋子 agent 才不会把 token 烧光。',
      newRoom: '新建房间',
      roomName: '房间名',
      roomTopic: '这间屋子用来做什么（可留空）',
      create: '建好',
      cancel: '取消',
      send: '发送',
      sendHint: 'Enter 发送，Shift+Enter 换行；@ 点名 agent',
      floatHint: '说点什么…',
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
      agentKind: 'agent',
      local: '本机',
      lan: 'LAN',
      reachHere: '在线',
      reachLocal: '本机',
      reachLan: '远程',
      remove: '移出房间',
      addAgent: '加一个 agent',
      agentName: '名字',
      agentRole: '职责（会影响它怎么说话）',
      agentEdit: '改这个 agent',
      edit: '改',
      agentNew: '新建一个 agent',
      save: '保存',
      dissolve: '解散房间',
      dissolveAsk: '解散后这间屋子和里面的记录都会没了',
      dissolveYes: '确定解散',
      code: '房间码',
      members: '成员',
      noMessages: '屋里还很安静。说第一句吧。',
      hintNotAddressed: '这句没叫到 agent —— 开头写 @名字，或者让全员说一轮。',
      hintNotAddressedRemote: '这句没叫到 agent —— 开头写 @名字，它们才会接着往下说。',
      hintCompact: '这句没叫到 agent —— 开头写 @名字。',
      hintRulesOff: '三种发言规则都关着，谁都不会自动接话。点「规则」打开一个。',
      hintCompactRulesOff: '这间屋子的发言规则都关着，谁都不会自动接话。',
      speaking: '正在发言',
      busy: '这一轮还没结束',
      floatOpen: '聊天室',
      floatClose: '收起',
      floatDrag: '拖动移动；双击回到右下角',
      floatDragPill: '拖动移动；点一下展开',
      openPanel: '打开面板',
      unread: '条未读',
      error: '出错了',
      retry: '重试',
      you: '我',
      older: '加载更早的消息',
      olderLoading: '正在载入…',
      jumpLatest: '回到最新',
      jumpFresh: '条新的',
      settingsSelf: '我的名字',
      myAgents: '我的 agent',
      myAgentsNone: '还没有 agent：建一个，加入 LAN 房间时会一起带进屋。',
      myAgentsHint: '这些是跟着你这台机器走的 agent。加到别人的屋里时，它们跑的是各自在这台机器上的会话。',
      bringAgents: '进屋会带上：',
      bringNone: '本机还没有 agent，进屋只有你一个人。',
      removeAgent: '删掉这个 agent',
      removeAgentAsk: '删掉它？',
      removeAgentYes: '删掉',
      joinLan: '加入 LAN 房间',
      joinAddress: '对方地址，如 192.168.1.5:4399',
      joinCode: '六位房间码',
      join: '加入',
      leaveLan: '离开这个房间',
      invite: '邀请',
      inviteAddress: '地址',
      inviteHint: '对方打开聊天室 → 加入 LAN 房间 → 填这个地址和房间码。两边都要开着这台机器。',
      inviteMore: '其他地址：',
      virtualNic: '虚拟网卡',
      inviteVirtualOnly:
        '这台机器只有虚拟网卡的地址，隔壁那台连不上：先连上 WiFi 或网线，再邀请。',
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
      /* 只列需要处理的机器：旧版本报不了名单、或那台还没建 agent。 */
      peerNoneYet: '还没建 agent —— 在那台的左栏「我的 agent」里建一个，建完自动进来。',
      peerOld: '旧版本，报不了 agent 名单 —— 重启那台的桌面端，再进屋一次。',
      hostOldHint: '宿主的插件是旧版本，本机的 agent 名单报不过去。重启宿主那台的桌面端后重新进屋。',
    }

    var EN = {
      nav: 'Rooms',
      title: 'Rooms',
      empty: 'No rooms yet',
      emptyPreview: 'No messages yet',
      emptyHint: 'Make a room and bring your agents in.',
      firstTitle: 'Rooms live on your machine',
      firstText: 'Make a room and bring your agents in. Another machine on the same Wi-Fi joins with an address and a six-character code, and its agents answer from their own sessions.',
      firstNote: 'How many replies one message may pull, and how deep agents may hand off, are set under Rules.',
      newRoom: 'New room',
      roomName: 'Room name',
      roomTopic: 'What this room is for (optional)',
      create: 'Create',
      cancel: 'Cancel',
      send: 'Send',
      sendHint: 'Enter to send, Shift+Enter for a new line; @ to call an agent',
      floatHint: 'Say something…',
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
      agentKind: 'agent',
      local: 'Local',
      lan: 'LAN',
      reachHere: 'here',
      reachLocal: 'local',
      reachLan: 'remote',
      remove: 'Remove from room',
      addAgent: 'Add an agent',
      agentName: 'Name',
      agentRole: 'Role (shapes how it talks)',
      agentEdit: 'Edit this agent',
      edit: 'Edit',
      agentNew: 'Create an agent',
      save: 'Save',
      dissolve: 'Dissolve room',
      dissolveAsk: 'Dissolving deletes this room and everything said in it',
      dissolveYes: 'Dissolve anyway',
      code: 'Room code',
      members: 'Members',
      noMessages: 'Quiet in here. Say the first thing.',
      hintNotAddressed: 'No agent was called — start with @name, or run a full round.',
      hintNotAddressedRemote: 'No agent was called — start with @name and they pick it up.',
      hintCompact: 'No agent was called — start with @name.',
      hintRulesOff: 'All three speaking rules are off, so nobody answers on their own. Open Rules and turn one on.',
      hintCompactRulesOff: 'Every speaking rule is off in this room, so nobody answers on its own.',
      speaking: 'Speaking',
      busy: 'A round is still running',
      floatOpen: 'Rooms',
      floatClose: 'Hide',
      floatDrag: 'Drag to move; double-click to send it back to the corner',
      floatDragPill: 'Drag to move; click to open',
      openPanel: 'Open panel',
      unread: 'unread',
      error: 'Failed',
      retry: 'Retry',
      you: 'me',
      older: 'Load earlier messages',
      olderLoading: 'Loading…',
      jumpLatest: 'Jump to latest',
      jumpFresh: 'new',
      settingsSelf: 'My name',
      myAgents: 'My agents',
      myAgentsNone: 'No agent yet — make one and it travels with you into a LAN room.',
      myAgentsHint: 'These agents belong to this machine: they run in their own local sessions, wherever the room is hosted.',
      bringAgents: 'Coming with you: ',
      bringNone: 'No agent on this machine yet — you would join alone.',
      removeAgent: 'Delete this agent',
      removeAgentAsk: 'Delete it?',
      removeAgentYes: 'Delete',
      joinLan: 'Join a LAN room',
      joinAddress: 'Host address, e.g. 192.168.1.5:4399',
      joinCode: 'Six-character room code',
      join: 'Join',
      leaveLan: 'Leave this room',
      invite: 'Invite',
      inviteAddress: 'Address',
      inviteHint: 'On the other machine: Rooms → Join a LAN room, then paste this address and code. Both machines stay open.',
      inviteMore: 'Other addresses: ',
      virtualNic: 'virtual adapter',
      inviteVirtualOnly:
        'This machine only has virtual-adapter addresses, so the other machine cannot reach it. Connect Wi-Fi or Ethernet first.',
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
      peerNoneYet: 'no agent yet — create one in that machine’s “My agents” and it joins by itself.',
      peerOld: 'old build, cannot report its agents — restart that desktop app and rejoin.',
      hostOldHint: 'The host runs an older build, so your agents cannot be reported. Restart that desktop app, then rejoin.',
    }

    /* -------------------------------------------------------------------- CSS */

    /* 只用宿主 token，取不到就退回中性值 —— 明暗主题都不需要单独写一套。
     * 间距按 4/8 栅格走，字号只出现 11/12/13/14 四档。 */
    var CSS = [
      /* 只用宿主 token，取不到就退回中性值 —— 明暗主题都不需要单独写一套。
       * 颜色 / 间距 / 圆角先落成 --cr-* 变量再写组件；间距只走 4/8 栅格，字号只出现 11/12/13/14 四档。
       * 浮层底色用 bg-layer-2 而不是 bg-overlay：默认深色主题里 bg-overlay 是 #61666b（说明图/遮罩用的灰），
       * 套到浮窗上就是一块比宿主面板亮一截的灰板；bg-layer-2 才是宿主自己抬起来的那层（#2c2c2e）。
       * 主按钮的文字色用 bg-base 反色，不能写死 #fff：默认主题的 brand-primary 是近白 #f9fafb，
       * 白底白字 = 按钮上的字整个消失（真外壳里实测过）。 */
      '.cr-main,.cr-float,.cr-toast-wrap{--cr-fg:var(--dsw-alias-label-primary,#e9eaee);--cr-muted:var(--dsw-alias-label-secondary,#9aa0aa);--cr-line:var(--dsw-alias-border-l1,rgba(255,255,255,.09));--cr-surface:var(--dsw-alias-bg-layer-2,#1c1f25);--cr-accent:var(--dsw-alias-brand-primary,#4f7cff);--cr-on-accent:var(--dsw-alias-bg-base,#0b0b0c);--cr-hover:color-mix(in srgb,currentColor 7%,transparent);--cr-raised:color-mix(in srgb,currentColor 5%,transparent);--cr-danger:#e5484d;--cr-warn:#c08a2e;--cr-r:8px;--cr-r-lg:12px;--cr-s1:4px;--cr-s2:8px;--cr-s3:12px;--cr-s4:16px;--cr-s5:24px}',

      /* 骨架：三列只靠一条发丝线分开，不再给每一列套一层框。 */
      '.cr-main{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--cr-fg)}',
      '.cr-grid{display:grid;grid-template-columns:224px minmax(0,1fr) 252px;height:100%;min-height:0}',
      /* 一间屋子都还没有时，成员列整列都不存在 —— 别留一根空着的第三列撑在那。 */
      '.cr-grid-first{grid-template-columns:224px minmax(0,1fr)}',
      '.cr-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.cr-col+.cr-col{border-left:1px solid var(--cr-line)}',
      '.cr-col-head{display:flex;align-items:center;gap:var(--cr-s2);padding:var(--cr-s3) var(--cr-s3) var(--cr-s2);min-height:44px}',
      '.cr-col-title{font-size:13px;font-weight:500}',
      '.cr-count{font-size:11px;color:var(--cr-muted);font-variant-numeric:tabular-nums}',
      '.cr-grow{flex:1;min-width:0}',

      /* 按钮：一个高度、一个圆角，主次只靠填充和颜色区分。 */
      '.cr-btn{display:inline-flex;align-items:center;gap:var(--cr-s1);height:28px;padding:0 var(--cr-s2);border:1px solid var(--cr-line);border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
      '.cr-btn:hover{background:var(--cr-hover)}',
      '.cr-btn:disabled{opacity:.45;cursor:default}',
      '.cr-btn:disabled:hover{background:transparent}',
      '.cr-btn.cr-primary{border-color:transparent;background:var(--cr-accent);color:var(--cr-on-accent)}',
      '.cr-btn.cr-primary:hover{filter:brightness(1.06)}',
      '.cr-btn.cr-ghost{border-color:transparent;color:var(--cr-muted)}',
      '.cr-btn.cr-ghost:hover{background:var(--cr-hover);color:var(--cr-fg)}',
      '.cr-btn.cr-danger{color:var(--cr-danger);border-color:color-mix(in srgb,var(--cr-danger) 38%,transparent)}',
      '.cr-btn.cr-danger:hover{background:color-mix(in srgb,var(--cr-danger) 12%,transparent)}',
      '.cr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;opacity:.55;cursor:pointer}',
      '.cr-icon-btn:hover{opacity:1;background:var(--cr-hover)}',

      /* 房间列表：选中态只加一条 2px 品牌色竖条，不给整块描边。 */
      '.cr-rooms{overflow:auto;padding:0 var(--cr-s2) var(--cr-s3);display:flex;flex-direction:column}',
      '.cr-room{display:flex;flex-direction:column;gap:var(--cr-s1);padding:var(--cr-s2);border-left:2px solid transparent;border-radius:var(--cr-r);cursor:pointer}',
      '.cr-room:hover{background:var(--cr-hover)}',
      '.cr-room.cr-active{background:var(--cr-hover);border-left-color:var(--cr-accent)}',
      '.cr-room-top{display:flex;align-items:center;gap:var(--cr-s2)}',
      '.cr-room-name{font-size:13px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-room-preview{font-size:11px;line-height:1.4;color:var(--cr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 未读数字要在徽标底色上看得见：默认主题里 brand-primary 本身就是近白
      // （#f9fafb），配 #fff 等于白字白底、对比度 1.04:1 —— 实机上就是一坨白点。
      // 底色用 accent，字色反色（--cr-on-accent），并给作用域外的位置留兜底。
      '.cr-badge{min-width:16px;height:16px;padding:0 var(--cr-s1);border-radius:8px;background:var(--cr-accent,var(--dsw-alias-brand-primary,#4f7cff));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#0b0b0c));font-size:11px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      '.cr-form{display:flex;flex-direction:column;gap:var(--cr-s2);padding:0 var(--cr-s3) var(--cr-s3)}',
      '.cr-field{width:100%;box-sizing:border-box;height:28px;padding:0 var(--cr-s2);border:1px solid var(--cr-line);border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:12px}',
      '.cr-field:focus{outline:1px solid var(--cr-accent);outline-offset:-1px}',
      /* 我的名字：坐在键盘前的这个人叫什么，决定对面看到的名字。 */
      '.cr-name-row{display:flex;align-items:center;gap:var(--cr-s2)}',
      '.cr-name-label{font-size:11px;color:var(--cr-muted);flex:0 0 auto}',
      '.cr-name-row .cr-field{flex:1;min-width:0}',
      '.cr-hint{font-size:11px;color:var(--cr-muted);line-height:1.5}',
      '.cr-chips{display:flex;flex-wrap:wrap;gap:var(--cr-s2)}',
      '.cr-agent-chip{display:inline-flex;align-items:center;max-width:168px}',
      '.cr-agent-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.cr-agent-x{border:0;background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;line-height:1;padding:0 0 0 var(--cr-s1);cursor:pointer;min-height:20px}',
      '.cr-agent-x:hover{color:var(--cr-danger)}',
  '.cr-agent-ask{max-width:none}',
  '.cr-agent-yes{border:0;background:transparent;color:var(--cr-danger);font:inherit;font-size:11px;line-height:1;padding:0 var(--cr-s1);cursor:pointer;min-height:20px;text-decoration:underline;text-underline-offset:2px}',
      '.cr-my-form{display:flex;flex-direction:column;gap:var(--cr-s2);padding-top:var(--cr-s1)}',
      /* agent 的名字与职责：建的时候填，之后还能改（职责决定它怎么说话）。 */
      '.cr-agent-form{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s2);border-radius:var(--cr-r);background:var(--cr-raised)}',
      '.cr-agent-form .cr-field{background:var(--cr-surface)}',
      '.cr-member.cr-member-editing{display:block;padding:0;background:none}',
      '.cr-member.cr-member-editing:hover{background:none}',

      /* 消息列：头部一条发丝线，消息之间只留空白，不画卡片。 */
      '.cr-room-head{display:flex;align-items:center;gap:var(--cr-s2);padding:0 var(--cr-s4);border-bottom:1px solid var(--cr-line);min-height:48px}',
      '.cr-room-title{font-size:14px;font-weight:500;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-chip{flex:0 0 auto;display:inline-block;height:20px;line-height:20px;padding:0 var(--cr-s2);border-radius:6px;background:var(--cr-raised);color:var(--cr-muted);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums;max-width:132px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}',
      '.cr-chip.cr-lan{color:var(--cr-accent);background:color-mix(in srgb,var(--cr-accent) 12%,transparent)}',
      '.cr-chip.cr-danger{color:var(--cr-danger);background:color-mix(in srgb,var(--cr-danger) 14%,transparent)}',
      /* 主题可以很长：让它先缩、先省略，别把「邀请 / 规则」顶出可视区。 */
      '.cr-chip.cr-topic{flex:0 1 auto;min-width:48px;max-width:300px}',
      '.cr-flow{flex:1;min-height:0;overflow:auto;padding:var(--cr-s3) var(--cr-s4) var(--cr-s4);display:flex;flex-direction:column;gap:var(--cr-s4)}',
      /* 往回翻历史之后，人停在上头；没有这一步就得靠滚轮一路滚到底才能回到最新那句。
         sticky 贴在滚动容器底部，不占内容高度、也不跟消息抢位置。 */
      '.cr-jump{position:sticky;bottom:var(--cr-s2);align-self:center;height:24px;padding:0 var(--cr-s3);border:1px solid var(--cr-line);border-radius:999px;background:var(--cr-surface);color:var(--cr-fg);font:inherit;font-size:11px;line-height:1;cursor:pointer;box-shadow:0 8px 24px -14px rgba(0,0,0,.7)}',
      '.cr-jump:hover{background:var(--cr-hover)}',
      '.cr-msg{display:flex;gap:var(--cr-s2);align-items:flex-start}',
      '.cr-avatar{width:24px;height:24px;border-radius:var(--cr-r);flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;background:var(--cr-hover)}',
      '.cr-msg-body{min-width:0;flex:1}',
      '.cr-msg-meta{display:flex;align-items:baseline;gap:var(--cr-s2);flex-wrap:wrap;margin-bottom:var(--cr-s1)}',
      '.cr-msg-name{font-size:12px;font-weight:500}',
      '.cr-msg-time{font-size:11px;color:var(--cr-muted);font-variant-numeric:tabular-nums}',
      '.cr-msg-text{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
      '.cr-msg-text code{font-size:12px;padding:1px var(--cr-s1);border-radius:4px;background:var(--cr-hover)}',
      '.cr-msg-text strong{font-weight:600}',
      '.cr-mention{color:var(--cr-accent);font-weight:500}',
      '.cr-msg.cr-mine .cr-avatar{background:color-mix(in srgb,var(--cr-accent) 16%,transparent);color:var(--cr-accent)}',
      '.cr-msg.cr-error .cr-msg-text{color:var(--cr-muted)}',
      /* agent 没回上来那一行要能重来：按钮跟在这条消息下面，不挤进署名行。 */
      '.cr-msg-actions{display:flex;align-items:center;gap:var(--cr-s3);margin-top:var(--cr-s1)}',
      '.cr-msg-actions .cr-link-btn{color:var(--cr-accent)}',
      '.cr-msg-actions .cr-link-btn:hover{color:var(--cr-fg)}',
      '.cr-msg-actions .cr-link-btn:disabled{color:var(--cr-muted);cursor:default}',
      '.cr-thinking{display:flex;align-items:center;gap:var(--cr-s1);font-size:11px;color:var(--cr-muted);padding-left:32px}',
      /* 「说了一句、谁都没接」时的一句解释。它不是消息，所以不占消息行、不比正文大：
       * 左边一条发丝线，和消息正文对齐（32px = 头像列），跟着最后一条往下走。 */
      '.cr-hint{margin:var(--cr-s2) 0 0 32px;padding:var(--cr-s1) 0 var(--cr-s1) var(--cr-s2);border-left:2px solid var(--cr-line);color:var(--cr-muted);font-size:12px;line-height:1.6}',
      /* 左栏是 224px 的窄列：那条 32px 缩进 + 竖线是给消息流里的解释用的，
       * 挪到窄列里会把字挤成两三行还错位 —— 这里只保留一行说明。 */
      '.cr-hint.cr-flat{margin:var(--cr-s1) 0 0;padding:0;border-left:0;font-size:11px;line-height:1.6}',
      /* 往回翻历史：投影只有最近 200 条，更早的要一句一句点回来。
       * 做成顶部一枚窄胶囊、居中 —— 它是「列表的起点」，不该长得像一条消息。 */
      '.cr-older{display:flex;justify-content:center;padding:var(--cr-s1) 0 var(--cr-s2)}',
      '.cr-older-btn{height:24px;padding:0 var(--cr-s3);border:1px solid var(--cr-line);border-radius:999px;background:transparent;color:var(--cr-muted);font:inherit;font-size:11px;line-height:1;cursor:pointer}',
      '.cr-older-btn:hover{background:var(--cr-hover);color:var(--cr-fg)}',
      '.cr-older-btn:disabled{cursor:default;opacity:.6}',
      '.cr-older-btn:disabled:hover{background:transparent;color:var(--cr-muted)}',
      '.cr-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.5;animation:cr-pulse 1.4s ease-in-out infinite}',
      '.cr-dot:nth-child(2){animation-delay:.2s}.cr-dot:nth-child(3){animation-delay:.4s}',
      '@keyframes cr-pulse{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:.9;transform:translateY(-1px)}}',

      /* 输入区 */
      '.cr-composer{border-top:1px solid var(--cr-line);padding:var(--cr-s2) var(--cr-s4) var(--cr-s3);display:flex;flex-direction:column;gap:var(--cr-s2)}',
      '.cr-input-row{display:flex;gap:var(--cr-s2);align-items:flex-end}',
      '.cr-textarea{flex:1;min-height:32px;max-height:160px;resize:none;border:1px solid var(--cr-line);border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.5;padding:var(--cr-s1) var(--cr-s2);box-sizing:border-box}',
      '.cr-textarea:focus{outline:1px solid var(--cr-accent);outline-offset:-1px}',
      '.cr-composer-foot{display:flex;align-items:center;gap:var(--cr-s2);font-size:11px;color:var(--cr-muted)}',
      '.cr-mention-pop{position:absolute;bottom:calc(100% - 4px);left:var(--cr-s4);z-index:5;min-width:180px;padding:var(--cr-s1);border:1px solid var(--cr-line);border-radius:var(--cr-r);background:var(--cr-surface);box-shadow:0 12px 32px -8px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px}',
      '.cr-pop-row{display:flex;align-items:center;gap:var(--cr-s2);padding:var(--cr-s1) var(--cr-s2);border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.cr-pop-row:hover{background:var(--cr-hover)}',

      /* 成员列：分组名不再大写加宽字距，中文用不到那套。 */
      '.cr-members{overflow:auto;padding:0 var(--cr-s2) var(--cr-s3);display:flex;flex-direction:column}',
      '.cr-group-label{font-size:11px;color:var(--cr-muted);padding:var(--cr-s2) var(--cr-s2) var(--cr-s1)}',
      '.cr-member{display:flex;align-items:center;gap:var(--cr-s2);padding:var(--cr-s2);border-radius:var(--cr-r)}',
      '.cr-member:hover{background:var(--cr-hover)}',
      '.cr-member-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-member-role{font-size:11px;color:var(--cr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-member .cr-icon-btn{opacity:0}',
      '.cr-member:hover .cr-icon-btn{opacity:.7}',
      /* 「改」只在鼠标落到这一行时才出现：常驻会白占宽度，把职责那一行提前截断。 */
      '.cr-member .cr-icon-btn.cr-edit-btn{display:none}',
      '.cr-member:hover .cr-icon-btn.cr-edit-btn{display:inline-flex}',
      '.cr-rules{border-top:1px solid var(--cr-line);padding:var(--cr-s3) var(--cr-s4);display:flex;flex-direction:column;gap:var(--cr-s2);font-size:12px}',
      '.cr-check{display:flex;gap:var(--cr-s2);align-items:center;line-height:1.4;cursor:pointer}',
      '.cr-check input{accent-color:var(--cr-accent)}',
  '.cr-confirm{display:flex;flex-direction:column;gap:var(--cr-s2);margin-top:var(--cr-s1);padding-top:var(--cr-s3);border-top:1px solid var(--cr-line)}',
  '.cr-confirm-text{font-size:11px;line-height:1.5;color:var(--cr-danger)}',
  '.cr-confirm-row{display:flex;gap:var(--cr-s2)}',
      '.cr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--cr-s2);height:100%;padding:var(--cr-s5);text-align:center;color:var(--cr-muted);font-size:12px;line-height:1.6}',
      /* 首屏（一间屋子都还没有）：中栏本来是空的，只留一句提示会像渲染挂了。
       * 这里给一块真正的第一屏：一句话说清房间在哪、另一台机器怎么进来，两个入口直接可用。 */
      '.cr-first{flex:1;justify-content:center;align-items:flex-start;gap:var(--cr-s3);padding:var(--cr-s5);box-sizing:border-box}',
      '.cr-first-inner{width:100%;max-width:420px;margin:0 auto;display:flex;flex-direction:column;gap:var(--cr-s3)}',
      '.cr-first-title{font-size:14px;font-weight:500;line-height:1.5;color:var(--cr-fg)}',
      '.cr-first-text{margin:0;font-size:13px;line-height:1.7;color:var(--cr-muted)}',
      '.cr-first-actions{display:flex;gap:var(--cr-s2);flex-wrap:wrap}',
      '.cr-first-note{margin:0;font-size:11px;line-height:1.6;color:var(--cr-muted)}',

      /* LAN：加入别人的屋子 / 邀请另一台机器。整条通栏铺开，不再浮在消息区里当一张小卡片。 */
      '.cr-col-foot{margin-top:auto;padding:var(--cr-s2) var(--cr-s3) var(--cr-s3);border-top:1px solid var(--cr-line);display:flex;flex-direction:column;gap:var(--cr-s1)}',
      '.cr-link-btn{border:0;background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;padding:0;min-height:24px;cursor:pointer;text-align:left;line-height:1.5}',
      '.cr-link-btn:hover{color:var(--cr-fg)}',
      '.cr-invite{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s3) var(--cr-s4);border-bottom:1px solid var(--cr-line);background:var(--cr-raised)}',
      '.cr-invite-row{display:flex;align-items:center;gap:var(--cr-s2);font-size:12px;min-height:24px}',
      '.cr-invite-label{color:var(--cr-muted);font-size:11px;width:48px;flex:0 0 48px;white-space:nowrap}',
      '.cr-invite code{font-size:12px;padding:2px var(--cr-s2);border-radius:6px;background:var(--cr-hover);font-variant-numeric:tabular-nums}',
      '.cr-invite-note{font-size:11px;color:var(--cr-muted);line-height:1.5}',
      /* 需要处理的机器：机器名一行、原因一行。它回答的是「agent 为什么没进来」，
       * 所以「旧版本报不了」和「还没建」必须长得不一样，不能糊成一句「无」。 */
      '.cr-machines{border-top:1px solid var(--cr-line);margin-top:var(--cr-s2);padding:var(--cr-s2) var(--cr-s2) 0}',
      '.cr-peer{display:flex;flex-direction:column;min-width:0;padding:var(--cr-s1) 0;font-size:11px;line-height:1.5}',
      '.cr-peer-machine{color:var(--cr-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-peer-state{color:var(--cr-muted);word-break:break-word}',
      '.cr-warn{color:var(--cr-warn);font-size:11px;line-height:1.5;word-break:break-word}',

      /* 悬浮窗：外层只负责定位和拖动，视觉全在胶囊和卡片上。 */
      '.cr-float{position:fixed;right:var(--cr-s4);bottom:96px;z-index:70;display:flex;flex-direction:column;align-items:flex-end;gap:var(--cr-s2);pointer-events:none;font-family:inherit;color:var(--cr-fg)}',
      '.cr-float-pill{pointer-events:auto;display:flex;align-items:center;gap:var(--cr-s2);height:32px;padding:0 var(--cr-s3);border:1px solid var(--cr-line);border-radius:999px;background:var(--cr-surface);box-shadow:0 8px 24px -8px rgba(0,0,0,.5);color:var(--cr-fg);font:inherit;font-size:12px;cursor:grab;user-select:none;touch-action:none}',
      '.cr-float-pill:hover{border-color:color-mix(in srgb,var(--cr-accent) 36%,var(--cr-line))}',
      '.cr-float-card{pointer-events:auto;width:320px;max-height:min(440px,60vh);display:flex;flex-direction:column;border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:0 16px 40px -12px rgba(0,0,0,.55);color:var(--cr-fg);overflow:hidden}',
      '.cr-float-head{display:flex;align-items:center;gap:var(--cr-s2);height:40px;padding:0 var(--cr-s2) 0 var(--cr-s3);border-bottom:1px solid var(--cr-line);cursor:grab;user-select:none;touch-action:none}',
      /* 拖动是这扇窗唯一的位移方式：抓手处给一条点阵纹理，光标是抓手，拖的时候换成抓紧。 */
      '.cr-grip{flex:0 0 auto;width:6px;height:10px;opacity:.45;background-image:radial-gradient(circle,currentColor 1px,transparent 1.2px);background-size:3px 3px;pointer-events:none}',
      '.cr-float-pill.cr-dragging,.cr-float-head.cr-dragging{cursor:grabbing}',
      '.cr-float-title{font-size:12px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-float-flow{overflow:auto;padding:var(--cr-s3);display:flex;flex-direction:column;gap:var(--cr-s3);min-height:80px}',
      '.cr-float-msg{font-size:12px;line-height:1.55;word-break:break-word}',
      /* 没回上来那一条在浮窗里压成灰的，底下跟一个重试 —— 失败不该被折叠掉。 */
      '.cr-float-failed{color:var(--cr-muted);border-top:1px dashed var(--cr-line);padding-top:var(--cr-s2)}',
      /* 浮窗里的那句解释：比面板更挤，所以不缩进、不描边，只留一行 11px 的说明。 */
      '.cr-float-hint{color:var(--cr-muted);font-size:11px;line-height:1.5;padding-top:var(--cr-s1)}',
      '.cr-float-who{font-size:11px;color:var(--cr-muted);margin-bottom:var(--cr-s1)}',
      '.cr-lan-tag{color:var(--cr-accent)}',
      '.cr-float-compose{display:flex;gap:var(--cr-s1);padding:var(--cr-s2);border-top:1px solid var(--cr-line);align-items:flex-end}',
      '.cr-float-input{flex:1;min-height:28px;max-height:80px;resize:none;border:1px solid var(--cr-line);border-radius:var(--cr-r);background:var(--cr-raised);color:inherit;font:inherit;font-size:12px;line-height:1.4;padding:var(--cr-s1) var(--cr-s2);box-sizing:border-box}',

      /* 提醒 */
      '.cr-toast-wrap{position:fixed;right:var(--cr-s4);top:56px;z-index:75;display:flex;flex-direction:column;gap:var(--cr-s2);pointer-events:none}',
      '.cr-toast{pointer-events:auto;max-width:300px;display:flex;flex-direction:column;gap:var(--cr-s1);padding:var(--cr-s2) var(--cr-s3);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:0 12px 32px -8px rgba(0,0,0,.5);font-size:12px;line-height:1.45;color:var(--cr-fg);cursor:pointer}',
      '.cr-toast-name{font-size:11px;color:var(--cr-muted)}',
      // 侧栏那颗在 token 作用域之外（宿主只把 --dsw-alias-* 挂在面板元素上），
      // 所以这里不能只写 var(--cr-accent)：取不到就是透明底，数字只剩描边。
      '.cr-nav-badge{position:absolute;top:-5px;right:-6px;min-width:16px;height:16px;padding:0 var(--cr-s1);border-radius:8px;background:var(--cr-accent,var(--dsw-alias-brand-primary,#4f7cff));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#0b0b0c));font-size:11px;font-weight:500;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      /* 页面级错误条，别写成 .cr-error：那条类名已经被「没回上来的那条消息」占着，
       * 撞在一起会让每一条失败消息都被这条横幅的底色和缩进套上。 */
      '.cr-error-bar{color:var(--cr-danger);font-size:12px;line-height:1.5;padding:var(--cr-s2) var(--cr-s4);background:color-mix(in srgb,var(--cr-danger) 9%,transparent);border-bottom:1px solid color-mix(in srgb,var(--cr-danger) 24%,transparent)}',
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

    /**
     * 悬浮窗的位置要留得住，但也不能留到屏幕外面去。
     *
     * 拖到右下角、把窗口改窄、或者干脆关掉页面重开 —— 这三种情况都会让一个「记住的坐标」
     * 变成一块点不到、拖不回来的浮窗。所以所有坐标都要过一道夹取：至少留出 8px 边距，
     * 并且整块浮窗都在视口里。夹的是坐标，不是用户意图，所以夹完就顺手存下来。
     */
    var FLOAT_MARGIN = 8
    var FLOAT_POS_KEY = 'dsh-chatroom:float-pos:v1'

    function clampFloat(x, y, width, height) {
      var viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1440
      var viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 900
      var maxX = Math.max(FLOAT_MARGIN, viewportWidth - width - FLOAT_MARGIN)
      var maxY = Math.max(FLOAT_MARGIN, viewportHeight - height - FLOAT_MARGIN)
      var pick = (value, max) => Math.round(Math.min(Math.max(Number.isFinite(value) ? value : FLOAT_MARGIN, FLOAT_MARGIN), max))
      return { x: pick(x, maxX), y: pick(y, maxY) }
    }

    function floatStorage() {
      try {
        return typeof window !== 'undefined' ? window.localStorage : null
      } catch (error) {
        return null // 隐私模式下访问 localStorage 会抛，记不住位置不至于让浮窗打不开
      }
    }

    function readFloatPos() {
      var box = floatStorage()
      if (!box) return null
      try {
        var raw = JSON.parse(box.getItem(FLOAT_POS_KEY) || 'null')
        if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
        return { x: raw.x, y: raw.y } // 视口可能已经变了，等浮窗挂上来再夹
      } catch (error) {
        return null
      }
    }

    function saveFloatPos(position) {
      var box = floatStorage()
      if (!box) return
      try {
        box.setItem(FLOAT_POS_KEY, JSON.stringify({ x: position.x, y: position.y }))
      } catch (error) {
        /* 存不下就算了，位置只在这一次会话里有效 */
      }
    }

    function clearFloatPos() {
      var box = floatStorage()
      if (!box) return
      try {
        box.removeItem(FLOAT_POS_KEY)
      } catch (error) {
        /* 同上 */
      }
    }

    /* -------------------------------------------------------------- 数据层 */

    function createRpc(ctx) {
      var callId = 0

      /** 客户端的连接服务：有的版本挂在 ctx.connection，有的只能 ctx.get 取。 */
      function connectionOf() {
        try {
          if (ctx.connection && ctx.connection.rpc) return ctx.connection
        } catch (error) {
          /* 没注入时属性访问会抛，不是错误，接着往下找 */
        }
        try {
          var viaGet = typeof ctx.get === 'function' ? ctx.get('connection') : null
          if (viaGet && viaGet.rpc) return viaGet
        } catch (error) {
          /* 同上 */
        }
        return null
      }

      function unwrap(reply) {
        if (!reply || reply.ok !== true) {
          var error = (reply && reply.error) || {}
          throw Object.assign(new Error(error.message || '请求未完成'), { code: error.code || 'rpc_failed' })
        }
        return reply.value
      }

      return async function rpc(method, payload, timeoutMs) {
        var signal = AbortSignal.timeout(timeoutMs || 30000)
        var connection = connectionOf()
        if (connection) {
          return unwrap(await connection.rpc.call('/api', 'dsh.chatroom/' + method, payload || {}, signal))
        }
        // 回落：这个包自己的 /api 路由本来就是同源的，浏览器带着 Cookie 直接 POST 就行
        // （同宿主里别的客户端插件走的就是这条路）。取不到连接服务不该让整个面板停摆。
        if (typeof fetch !== 'function') {
          throw Object.assign(new Error('连接服务不可用'), { code: 'connection_unavailable' })
        }
        callId += 1
        var response = await fetch('/api/dsh.chatroom/' + method, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'rpc-' + Date.now().toString(36) + '-' + callId.toString(36),
            method: 'dsh.chatroom/' + method,
            payload: payload || {},
          }),
          signal: signal,
        })
        if (!response || !response.ok) {
          throw Object.assign(new Error('请求未完成（HTTP ' + ((response && response.status) || 0) + '）'), {
            code: 'http_' + ((response && response.status) || 0),
          })
        }
        return unwrap(await response.json())
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
        floatPos: readFloatPos(),
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

      async function pageOlder(roomId, beforeSeq, limit) {
        return rpc('messages', { roomId: roomId, beforeSeq: beforeSeq, limit: limit || 100 })
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
        pageOlder: pageOlder,
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
      // 旁边已经有数字徽标的地方（悬浮胶囊、会话标题栏按钮）不要再叠一个：
      // 同一个未读数在一处显示两遍，看着像两个未读。
      var withBadge = !(props && props.badge === false)
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
        unread > 0 && withBadge ? h('span', { className: 'cr-nav-badge' }, unread > 99 ? '99+' : String(unread)) : null,
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
      // 本机是默认状态，不给它贴标签 —— 只有「从别的机器进来的」才需要一眼认出来。
      // 认机器比认 IP 有用：192.168.1.42 谁都记不住，「周荻的 MacBook」一眼就知道是谁。
      if (!lan) return null
      var who = member.origin && (member.origin.machine || member.origin.peer)
      var label = tr('lan') + (who ? ' · ' + who : '')
      // 成员列窄：只留「LAN」，完整机器名放 title；消息行有位置，照旧写全。
      return h(
        'span',
        { className: 'cr-chip cr-lan', title: label },
        props.compact && lan ? tr('lan') : label,
      )
    }

    /** 这台机器有没有「说不清 agent 为什么不在」的事要讲。 */
    function needsAttention(peer) {
      return peer.canAgents === false || !(peer.agents && peer.agents.length)
    }

    /** 一台 LAN 机器：机器名一行，下面一行说清它为什么没带 agent。 */
    function PeerRow(props) {
      var peer = props.peer
      var tr = props.tr
      return h(
        'div',
        { className: 'cr-peer', title: peer.address || peer.machine },
        h('div', { className: 'cr-peer-machine' }, peer.machine || peer.address || 'LAN'),
        peer.canAgents === false
          ? h('div', { className: 'cr-warn' }, tr('peerOld'))
          : h('div', { className: 'cr-peer-state' }, tr('peerNoneYet')),
      )
    }

    /** 邀请另一台机器：地址 + 房间码就是全部凭据，抄过去即可，不用账号。 */
    function InviteBar(props) {
      var room = props.room
      var lan = props.lan || {}
      var tr = props.tr
      var [copied, setCopied] = React.useState(false)
      /* 地址按「对方最可能连得上」排过序：真实网卡在前，WSL / Hyper-V 这类虚拟网卡在后，
       * 并带 virtual 标记。只显示一个地址会在装了 WSL2 的机器上递错地址 —— 抄过去一直超时。 */
      var cands = (lan.addresses || []).filter(function (row) {
        return row && row.address
      })
      var primary = cands[0]
      var others = cands.slice(1)
      var address = lan.serving
        ? (primary ? primary.address : '127.0.0.1') + ':' + lan.port
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
        others.length
          ? h(
              'div',
              { className: 'cr-invite-note' },
              tr('inviteMore') +
                others
                  .map(function (row) {
                    return row.address + '（' + row.name + (row.virtual ? '，' + tr('virtualNic') : '') + '）'
                  })
                  .join(' · '),
            )
          : null,
        primary && primary.virtual ? h('div', { className: 'cr-warn' }, tr('inviteVirtualOnly')) : null,
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
            // 自己的消息加「（我）」后缀；默认名字本来就叫「我」时不重复成「我（我）」
            h(
              'span',
              { className: 'cr-msg-name' },
              message.authorName + (mine && message.authorName !== tr('you') ? '（' + tr('you') + '）' : ''),
            ),
            h(OriginChip, { member: author, tr: tr }),
            h('span', { className: 'cr-msg-time' }, clock(message.at)),
          ),
          h('div', { className: 'cr-msg-text' }, renderInline(message.text, members, 'm' + message.seq)),
          // 失败那一行给一次「重试」的机会：宿主只重跑这一个 agent，不惊动屋里其他人。
          // 光有占位消息、没有入口的话，用户只能靠再 @ 一遍来重试。
          message.status === 'error' && props.onRetry
            ? h(
                'div',
                { className: 'cr-msg-actions' },
                h(
                  'button',
                  {
                    className: 'cr-link-btn',
                    disabled: Boolean(props.busy || props.retrying),
                    // 这一轮还没收尾时宿主会回 room_busy：先说清楚，别让人点了没反应。
                    title: props.busy ? tr('busy') : null,
                    onClick: () => props.onRetry(message),
                  },
                  props.retrying ? tr('retry') + '…' : tr('retry'),
                ),
              )
            : null,
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
                  if (imePicking(event)) return
                  if (event.key === 'Enter') props.onCreate()
                },
              }),
              h('input', {
                className: 'cr-field',
                placeholder: tr('roomTopic'),
                value: formTopic,
                onChange: (event) => props.onFormTopic(event.target.value),
                onKeyDown: (event) => {
                  if (imePicking(event)) return
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
            ? h('div', { className: 'cr-empty', style: { height: 'auto', paddingTop: '24px' } }, h('div', null, tr('empty')))
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
          // 「我的 agent」在名字上面：进别人的屋子之前，先看清「我带谁一起进去」。
          // 加入之后再建也走这里 —— 建完立刻报给宿主，屋里马上多一个人。
          h(
            'div',
            { className: 'cr-name-row' },
            h('span', { className: 'cr-name-label', title: tr('myAgentsHint') }, tr('myAgents')),
            h('span', { className: 'cr-grow' }),
            h(
              'button',
              { className: 'cr-link-btn', onClick: props.onToggleMy },
              props.myForm ? tr('cancel') : '+ ' + tr('agentNew'),
            ),
          ),
          props.bots.length
            ? h(
                'div',
                { className: 'cr-chips' },
                props.bots.map((bot) =>
                  // 删掉 agent 是不可逆的：第一次点只问一句，同一个位置答完才真的删。
                  props.confirmBot === bot.id
                    ? h(
                        'span',
                        { key: bot.id, className: 'cr-chip cr-agent-chip cr-agent-ask' },
                        h('span', { className: 'cr-agent-name' }, tr('removeAgentAsk')),
                        h(
                          'button',
                          {
                            className: 'cr-agent-yes',
                            'aria-label': tr('removeAgent'),
                            title: tr('removeAgent'),
                            onClick: () => props.onRemoveMy(bot.id),
                          },
                          tr('removeAgentYes'),
                        ),
                        h(
                          'button',
                          {
                            className: 'cr-agent-x',
                            'aria-label': tr('cancel'),
                            title: tr('cancel'),
                            onClick: props.onCancelRemove,
                          },
                          '×',
                        ),
                      )
                    : h(
                        'span',
                        { key: bot.id, className: 'cr-chip cr-agent-chip', title: bot.role || '' },
                        h('span', { className: 'cr-agent-name' }, bot.name),
                        h(
                          'button',
                          {
                            className: 'cr-agent-x',
                            'aria-label': tr('removeAgent'),
                            title: tr('removeAgent'),
                            onClick: () => props.onAskRemove(bot.id),
                          },
                          '×',
                        ),
                      ),
                ),
              )
            : h('div', { className: 'cr-hint cr-flat' }, tr('myAgentsNone')),
          props.myForm
            ? h(
                'div',
                { className: 'cr-my-form' },
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('agentName'),
                  value: props.myForm.name,
                  autoFocus: true,
                  'aria-label': tr('agentName'),
                  onChange: (event) => props.onMyDraft({ name: event.target.value }),
                  onKeyDown: (event) => {
                    if (imePicking(event)) return
                    if (event.key === 'Enter' && props.myForm.name.trim()) props.onMySave()
                    if (event.key === 'Escape') props.onMyCancel()
                  },
                }),
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('agentRole'),
                  value: props.myForm.role,
                  'aria-label': tr('agentRole'),
                  onChange: (event) => props.onMyDraft({ role: event.target.value }),
                  onKeyDown: (event) => {
                    if (imePicking(event)) return
                    if (event.key === 'Enter' && props.myForm.name.trim()) props.onMySave()
                    if (event.key === 'Escape') props.onMyCancel()
                  },
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    { className: 'cr-btn cr-primary', disabled: !props.myForm.name.trim(), onClick: props.onMySave },
                    tr('save'),
                  ),
                  h('button', { className: 'cr-btn cr-ghost', onClick: props.onMyCancel }, tr('cancel')),
                ),
              )
            : null,
          // 名字写在加入口上面：进别人的屋子之前先让对面知道你是谁，
          // 否则第二台机器上的人只会叫「GUEST-A」这种机器名。
          h(
            'div',
            { className: 'cr-name-row' },
            h('span', { className: 'cr-name-label', title: tr('settingsSelf') }, tr('settingsSelf')),
            h('input', {
              className: 'cr-field',
              value: props.nameDraft !== '' ? props.nameDraft : props.selfName,
              'aria-label': tr('settingsSelf'),
              // 点进来就全选：改名通常是「换一个」，不是「在旧名字后面接着打」。
              onFocus: (event) => event.target.select(),
              onChange: (event) => props.onNameDraft(event.target.value),
              onBlur: props.onCommitName,
              onKeyDown: (event) => {
                if (imePicking(event)) return
                if (event.key === 'Enter') props.onCommitName()
              },
            }),
          ),
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
                    if (imePicking(event)) return
                    if (event.key === 'Enter') props.onJoin()
                  },
                }),
                // 加入那一刻只能带走「本机已经有的」agent —— 这句是唯一提前讲清楚的地方。
                h(
                  'div',
                  { className: 'cr-hint cr-flat' },
                  props.bots.length
                    ? tr('bringAgents') + props.bots.map((bot) => bot.name).join('、')
                    : tr('bringNone'),
                ),
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
              if (imePicking(event)) return
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
      var form = props.agentForm

      // 新建与编辑共用一个表单：字段一样（名字 + 职责），提交的动作按有没有 botId 分叉。
      var formNode = () =>
        h(
          'div',
          { className: 'cr-agent-form' },
          h('input', {
            className: 'cr-field',
            placeholder: tr('agentName'),
            value: form.name,
            autoFocus: true,
            'aria-label': tr('agentName'),
            onChange: (event) => props.onAgentDraft({ name: event.target.value }),
            onKeyDown: (event) => {
              if (imePicking(event)) return
              if (event.key === 'Enter' && form.name.trim()) props.onAgentSave()
              if (event.key === 'Escape') props.onAgentCancel()
            },
          }),
          h('input', {
            className: 'cr-field',
            placeholder: tr('agentRole'),
            value: form.role,
            'aria-label': tr('agentRole'),
            onChange: (event) => props.onAgentDraft({ role: event.target.value }),
            onKeyDown: (event) => {
              if (imePicking(event)) return
              if (event.key === 'Enter' && form.name.trim()) props.onAgentSave()
              if (event.key === 'Escape') props.onAgentCancel()
            },
          }),
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h(
              'button',
              { className: 'cr-btn cr-primary', disabled: !form.name.trim(), onClick: props.onAgentSave },
              tr('save'),
            ),
            h('button', { className: 'cr-btn cr-ghost', onClick: props.onAgentCancel }, tr('cancel')),
          ),
        )

      var row = (member) => {
        // 正在改的那一行原地换成表单，不弹窗：改的就是这行里的名字和职责。
        if (form && form.botId && member.botId && member.botId === form.botId) {
          return h('div', { key: member.id, className: 'cr-member cr-member-editing' }, formNode())
        }
        // 别人的 agent 在别人那台机器上，只能在他那边改。
        var editable =
          !props.remote && member.botId && (!member.origin || member.origin.kind !== 'lan')
        // 第二行只放有信息量的东西：agent 放职责，跨机器的人放他那台机器的名字。
        // 本机的人没有第二行 —— 一行名字就够了。
        var subtitle =
          member.role ||
          (member.kind === 'bot'
            ? tr('agentKind')
            : member.origin && member.origin.kind === 'lan'
              ? member.origin.machine || member.origin.peer || ''
              : '')
        return h(
          'div',
          { key: member.id, className: 'cr-member' },
          h(Avatar, { member: member, name: member.name }),
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'cr-member-name' }, member.name),
            subtitle ? h('div', { className: 'cr-member-role' }, subtitle) : null,
          ),
          h(OriginChip, { member: member, tr: tr, compact: true }),
          editable
            ? h(
                'button',
                {
                  className: 'cr-icon-btn cr-edit-btn',
                  title: tr('agentEdit'),
                  onClick: () => props.onEditAgent(member.botId),
                },
                tr('edit'),
              )
            : null,
          member.id === props.selfId || props.remote
            ? null
            : h(
                'button',
                { className: 'cr-icon-btn', title: tr('remove'), onClick: () => props.onRemove(member.id) },
                '×',
              ),
        )
      }
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
            : form && !form.botId
              ? formNode()
              : h(
                  'button',
                  { className: 'cr-btn cr-ghost', style: { margin: '8px 2px 0' }, onClick: props.onAddAgent },
                  '+ ' + tr('addAgent'),
                ),
          props.pickingAgent && !form
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
                h(
                  'button',
                  { className: 'cr-pop-row', style: { opacity: 0.75 }, onClick: props.onNewAgent },
                  '+ ' + tr('agentNew'),
                ),
              )
            : null,
          /* 只在**有话要说**的机器上出现：旧版本报不了名单、或者那台还没建 agent。
           * 已经带着 agent 进来的机器不必再列一遍 —— 它的 agent 就在上面成员列里。 */
          props.peers && props.peers.filter(needsAttention).length
            ? h(
                'div',
                { className: 'cr-machines' },
                props.peers.filter(needsAttention).map((peer) => h(PeerRow, { key: peer.id, peer: peer, tr: tr })),
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
              props.confirmDissolve
                ? h(
                    'div',
                    { className: 'cr-confirm' },
                    h('div', { className: 'cr-confirm-text' }, tr('dissolveAsk')),
                    h(
                      'div',
                      { className: 'cr-confirm-row' },
                      h('button', { className: 'cr-btn cr-danger', onClick: props.onDissolve }, tr('dissolveYes')),
                      h('button', { className: 'cr-btn cr-ghost', onClick: props.onCancelDissolve }, tr('cancel')),
                    ),
                  )
                : h(
                    'div',
                    { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
                    h('button', { className: 'cr-btn cr-danger', onClick: props.onAskDissolve }, tr('dissolve')),
                  ),
            )
          : null,
        props.remote
          ? h(
              'div',
              { className: 'cr-col-foot' },
              room.remote && room.remote.lost
                ? h('div', { className: 'cr-invite-note', style: { color: 'var(--cr-danger)' } }, tr('roomGone'))
                : props.link && props.link.status === 'offline'
                  ? h('div', { className: 'cr-invite-note', style: { color: 'var(--cr-danger)' } }, props.link.error || '离线')
                  : props.link && props.link.hostOld
                    ? h('div', { className: 'cr-warn' }, tr('hostOldHint'))
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

    /**
     * 「说了一句，谁都没接」时该不该解释一句。
     *
     * 默认规则只有「被 @ 才回」，所以新用户建屋、加 agent、问一句「你好」，
     * 得到的是完全的安静 —— 界面原来对此一个字都不说，看着像插件坏了。
     *
     * 这里不去猜宿主调度到了哪一步（那是异步的，猜早了会误报），只看投影里
     * 已经有的事实：最后一条是不是我刚说的、屋里有没有 agent、我有没有点到它、
     * 三条规则此刻还有没有人能接话。条件一变（agent 接话了 / 我再说一句 / 规则被打开），
     * 它自己就消失 —— 不需要额外状态，也不会出现「解释完了还一直挂着」。
     *
     * compact 给浮窗用：那里点不到「让全员说一轮」和「规则」这两个按钮，
     * 所以不能照着面板的说法指路。加入方的镜像房间同理（规则只能宿主改）。
     */
    function silenceNote(room, selfId, tr, compact) {
      if (!room) return null
      if (room.remote && room.remote.lost) return null // 屋子已经散了，输入也锁着，不必解释
      var messages = room.messages
      if (!messages || !messages.length) return null
      var last = messages[messages.length - 1]
      if (!last || last.authorId !== selfId || last.status !== 'sent') return null
      // 正在发言时不插嘴：那时下面已经有「正在发言 X」在解释界面。
      if (room.activity && room.activity.speaking && room.activity.speaking.length) return null
      var bots = room.members.filter(function (member) {
        return member.kind === 'bot'
      })
      // 屋里压根没有 agent：该去右栏建一个，不是「没叫到」。
      if (!bots.length) return null
      var rules = room.rules || {}
      if (rules.roundRobin || rules.chairId) return null // 这两条规则会自己接话
      var called = (last.mentions || []).some(function (id) {
        return bots.some(function (bot) {
          return bot.id === id
        })
      })
      if (rules.mention) {
        if (called) return null
        if (compact) return tr('hintCompact')
        return room.remote ? tr('hintNotAddressedRemote') : tr('hintNotAddressed')
      }
      // 连「被 @ 才回」都关着：这时就算点名也没人接，得先说清是规则的事。
      if (compact || room.remote) return tr('hintCompactRulesOff')
      return tr('hintRulesOff')
    }

    /**
     * 把「翻回来的更早几页」和新投影拼成一条没有重复的时间线。
     *
     * 拼接处不假设顺序：新投影会随着新消息往前挪窗口，同一句有机会同时出现在
     * 已经翻出来的那几页和投影里。按 seq 去重再排序，比「谁在前谁在后」可靠。
     */
    function mergeOlder(previous, incoming) {
      var seen = {}
      var out = []
      var all = (incoming || []).concat(previous || [])
      for (var row of all) {
        if (!row || typeof row.seq !== 'number' || seen[row.seq]) continue
        seen[row.seq] = true
        out.push(row)
      }
      out.sort(function (a, b) {
        return a.seq - b.seq
      })
      return out
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

      // 面板停在某间屋子上，就等于「读过了」：把游标推到最新一条，未读徽标才会消。
      // 但「挂着」不等于「看得见」：DSH 的侧栏面板被切走之后通常还留在 DOM 里，
      // 标签页切到后台也一样。无条件清已读会把提醒废掉（用户根本没看，未读就没了），
      // 所以先确认这块面板真的在屏幕上。
      // 另外用 ref 记「已经报过哪个 seq」：每次轮询回来的新投影都会再触发一次，
      // 每报一次宿主就 +1 revision，不记就会自己喂自己成死循环。
      var panelRef = React.useRef(null)
      var marked = React.useRef({ roomId: null, seq: 0 })
      // 面板要跟着新消息走：agent 的回复是异步补进来的，停在顶上就等于「说了话看不到」。
      // 但用户自己往上翻历史时不能把他拽下来 —— 只有本来就在底部才跟。
      var flowRef = React.useRef(null)
      var follow = React.useRef({ roomId: null, seq: null })
      // 往回翻完历史，人停在上面；这之后进来的新消息他看不见。给一个明确出口，
      // 别让人拿滚轮一路滚到底（长房间那是几百行的距离）。
      var [away, setAway] = React.useState(false)
      // 停在上面读历史的时候进来的话，用户在屏幕上根本看不见。出口上要写清「几条新的」——
      // 否则这枚按钮和一直挂着没区别，agent 回了什么还得自己找。
      var [fresh, setFresh] = React.useState(0)
      function measureFlow() {
        var node = flowRef.current
        if (!node) return
        var gap = node.scrollHeight - node.scrollTop - node.clientHeight
        setAway(gap > 160)
        // 人自己滚回底部，等于看过最新那句了，计数清零。
        if (gap <= 160) setFresh(0)
      }
      function jumpToLatest() {
        var node = flowRef.current
        setAway(false)
        setFresh(0)
        if (node) node.scrollTop = node.scrollHeight
      }
      // 投影只带最近 200 条。往回翻过的那页停在更早的位置，新消息一进来投影整体往前滑，
      // 两段中间就裂出一道缝：那几句既不在翻出来的那页里、也不在投影里，谁都不去要
      // 就永远看不见（时间戳会突然从 11/03 跳到 11/05）。补一次，按投影的首句往回要。
      var seam = React.useRef({ roomId: null, seq: null })
      function fillSeam(current) {
        var paged = ui.older
        if (!paged || paged.roomId !== current.id || paged.loading || !paged.items.length) return
        if (!current.messages.length) return
        var windowFirst = current.messages[0].seq
        var olderLast = 0
        for (var index = 0; index < paged.items.length; index += 1) {
          if (paged.items[index].seq > olderLast) olderLast = paged.items[index].seq
        }
        if (!olderLast || windowFirst <= olderLast + 1) return
        if (seam.current.roomId === current.id && seam.current.seq === windowFirst) return
        seam.current = { roomId: current.id, seq: windowFirst }
        store
          .pageOlder(current.id, windowFirst)
          .then(function (page) {
            var rows = page && page.messages ? page.messages : []
            if (!rows.length) return
            ui.setOlder({
              roomId: current.id,
              items: mergeOlder(paged.items, rows),
              hasMore: paged.hasMore,
              loading: false,
            })
          })
          .catch(function () {})
      }
      React.useEffect(() => {
        var node = flowRef.current
        var current = store.activeRoom()
        if (!node || !current) return
        var last = current.messages.length ? current.messages[current.messages.length - 1].seq : 0
        var same = follow.current.roomId === current.id
        var previous = follow.current.seq
        follow.current = { roomId: current.id, seq: last }
        if (same && previous === last) return
        var nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
        if (!same || previous === null || nearBottom) {
          node.scrollTop = node.scrollHeight
        } else if (last > previous) {
          // 人在上头读历史：不把他拽下来，只把「新进来几条」记在出口上。
          var added = 0
          for (var index = 0; index < current.messages.length; index += 1) {
            if (current.messages[index].seq > previous) added += 1
          }
          if (added) setFresh((count) => count + added)
          fillSeam(current)
        }
        measureFlow()
      })
      React.useEffect(() => {
        var snap = view.snapshot
        if (!snap) return
        var node = panelRef.current
        if (!node || node.offsetParent === null || document.visibilityState !== 'visible') return
        var current = snap.rooms.find((row) => row.id === snap.activeRoomId)
        if (!current || !current.unread) return
        if (current.remote && current.remote.lost) return
        var seq = current.nextSeq - 1
        if (marked.current.roomId === current.id && marked.current.seq === seq) return
        marked.current = { roomId: current.id, seq: seq }
        store.command('read.mark', { roomId: current.id, seq: seq }).catch(() => {})
      })

      if (!snapshot) {
        return h('div', { className: 'cr-main' }, h('div', { className: 'cr-empty' }, view.error || '…'))
      }
      var room = store.activeRoom()
      var pending = view.pending.filter((row) => !room || row.roomId === room.id)
      // 这一轮还在发言时，宿主会拿 room_busy 把重试打回来 —— 先把按钮按住。
      var busy = Boolean(room && room.activity && room.activity.speaking && room.activity.speaking.length)
      // 说完一句、谁都没接的时候，界面得说清是「没叫到人」还是「规则全关着」——
      // 默认只有「被 @ 才回」，不解释的话第一次用就是一片安静。
      var hint = silenceNote(room, snapshot.self.id, tr)
      // 投影只带最近 200 条：屋子更长时，更早那些话只有宿主那边还留着。
      // 顶部那枚「加载更早的消息」是它们唯一的入口 —— 少了它，说过的话在界面上
      // 就等于不存在，只剩一句「只显示最近 200 条」。
      var older = room && ui.older && ui.older.roomId === room.id ? ui.older : null
      var olderItems = older ? older.items : []
      var canOlder = room ? (older ? older.hasMore : Boolean(room.truncated)) : false
      var timeline = room ? (olderItems.length ? mergeOlder(olderItems, room.messages) : room.messages) : []

      /**
       * 翻回一页更早的消息。
       *
       * 翻完要自己把视口接回去：内容是在顶上长出来的，浏览器不会替你抵消这段高度，
       * 用户在读的那句会突然掉下去。这里按「翻页前离内容底部的距离」反推 scrollTop。
       */
      function loadOlder() {
        if (!room || (older && older.loading)) return
        var known = olderItems.length ? olderItems : room.messages
        var first = null
        for (var row of known) {
          if (first === null || row.seq < first) first = row.seq
        }
        if (first === null) return
        var box = flowRef.current
        var keep = box ? box.scrollHeight - box.scrollTop : 0
        ui.setOlder({ roomId: room.id, items: olderItems, hasMore: true, loading: true })
        store
          .pageOlder(room.id, first)
          .then(function (page) {
            ui.setOlder({
              roomId: room.id,
              items: mergeOlder(olderItems, page && page.messages ? page.messages : []),
              hasMore: Boolean(page && page.hasMore),
              loading: false,
            })
            window.requestAnimationFrame(function () {
              var node = flowRef.current
              if (!node) return
              var target = node.scrollHeight - keep
              node.scrollTop = target < 0 ? 0 : target
              measureFlow()
            })
          })
          .catch(function (error) {
            ui.setOlder({ roomId: room.id, items: olderItems, hasMore: true, loading: false })
            store.set({ error: String((error && error.message) || error) })
          })
      }

      function retry(message) {
        if (!room || room.remote) return
        ui.setRetrySeq(message.seq)
        store
          .command('msg.retry', { roomId: room.id, seq: message.seq })
          .catch(() => {})
          .then(() => ui.setRetrySeq(null))
      }

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
        { className: 'cr-main', ref: panelRef },
        view.error ? h('div', { className: 'cr-error-bar' }, tr('error') + '：' + view.error) : null,
        h(
          'div',
          { className: 'cr-grid' + (snapshot.rooms.length ? '' : ' cr-grid-first') },
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
            selfName: snapshot.self.name,
            nameDraft: ui.nameDraft,
            onNameDraft: ui.setNameDraft,
            bots: snapshot.bots || [],
            myForm: ui.myForm,
            onMyDraft: (patch) => ui.setMyForm(Object.assign({}, ui.myForm, patch)),
            onMyCancel: () => ui.setMyForm(null),
            onRemoveMy: (botId) => {
              ui.setConfirmBot(null)
              store.command('bot.remove', { botId: botId }).catch(() => {})
            },
            confirmBot: ui.confirmBot,
            onAskRemove: (botId) => ui.setConfirmBot(botId),
            onCancelRemove: () => ui.setConfirmBot(null),
            onToggleMy: () => ui.setMyForm(ui.myForm ? null : { name: '', role: '' }),
            onMySave: () => {
              var form = ui.myForm
              if (!form) return
              var name = form.name.trim()
              if (!name) return
              // 本地房间里有位置就顺手放进去；镜像房间的成员在宿主那边，交给 bot.create 里的上报。
              var target = room && !room.remote ? room.id : null
              store
                .command('bot.create', { name: name, role: form.role.trim(), roomId: target })
                .then(() => ui.setMyForm(null))
                .catch(() => {})
            },
            onToggleCreate: () => ui.setCreating(!ui.creating),
            onFormName: ui.setFormName,
            onFormTopic: ui.setFormTopic,
            onToggleJoin: () => ui.setJoinOpen(!ui.joinOpen),
            onJoinHost: ui.setJoinHost,
            onJoinCode: ui.setJoinCode,
            // 离开输入框或回车才提交：一边打字一边发 RPC 会把状态机打满。
            onCommitName: () => {
              var label = ui.nameDraft.trim()
              if (!label || label === snapshot.self.name) {
                ui.setNameDraft('')
                return
              }
              store
                .command('self.rename', { name: label })
                .then(() => {
                  ui.setNameDraft('')
                })
                .catch(() => {})
            },
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
                    ? h('span', { className: 'cr-chip cr-danger' }, tr('goneTag'))
                    : null,
                  room.topic ? h('span', { className: 'cr-chip cr-topic' }, room.topic) : null,
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
                  { className: 'cr-flow', ref: flowRef, onScroll: measureFlow },
                  canOlder
                    ? h(
                        'div',
                        { className: 'cr-older' },
                        h(
                          'button',
                          {
                            className: 'cr-older-btn',
                            disabled: Boolean(older && older.loading),
                            onClick: loadOlder,
                          },
                          older && older.loading ? tr('olderLoading') : tr('older'),
                        ),
                      )
                    : null,
                  timeline.length === 0
                    ? h('div', { className: 'cr-empty' }, tr('noMessages'))
                    : timeline.map((message) =>
                        h(MessageRow, {
                          key: message.id,
                          message: message,
                          members: room.members,
                          selfId: snapshot.self.id,
                          tr: tr,
                          // 加入方的镜像是只读的：重试由宿主那台机器发起。
                          onRetry: room.remote ? null : retry,
                          retrying: ui.retrySeq === message.seq,
                          busy: busy,
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
                  hint ? h('div', { className: 'cr-hint' }, hint) : null,
                  away
                    ? h(
                        'button',
                        { className: 'cr-jump', onClick: jumpToLatest },
                        fresh ? tr('jumpLatest') + ' · ' + fresh + ' ' + tr('jumpFresh') : tr('jumpLatest'),
                      )
                    : null,
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
            : h(
                'div',
                { className: 'cr-col cr-first' },
                h(
                  'div',
                  { className: 'cr-first-inner' },
                  h('div', { className: 'cr-first-title' }, tr('firstTitle')),
                  h('p', { className: 'cr-first-text' }, tr('firstText')),
                  h(
                    'div',
                    { className: 'cr-first-actions' },
                    h('button', { className: 'cr-btn cr-primary', onClick: () => ui.setCreating(true) }, tr('newRoom')),
                    h('button', { className: 'cr-btn cr-ghost', onClick: () => ui.setJoinOpen(true) }, tr('joinLan')),
                  ),
                  h('p', { className: 'cr-first-note' }, tr('firstNote')),
                ),
              ),
          room
            ? h(MembersColumn, {
                room: room,
                tr: tr,
                selfId: snapshot.self.id,
                rulesOpen: ui.rulesOpen,
                pickingAgent: ui.pickingAgent,
                remote: Boolean(room.remote),
                link: (snapshot.links || []).find((link) => link.localRoomId === room.id) || null,
                peers: ((snapshot.lan || {}).peers || []).filter(
                  (peer) => !peer.roomId || peer.roomId === room.id,
                ),
                directory: snapshot.bots.filter((bot) => !room.members.some((member) => member.botId === bot.id)),
                agentForm: ui.agentForm,
                onAgentDraft: (patch) => ui.setAgentForm(Object.assign({}, ui.agentForm, patch)),
                onAgentCancel: () => ui.setAgentForm(null),
                onAgentSave: () => {
                  var form = ui.agentForm
                  if (!form) return
                  var name = form.name.trim()
                  if (!name) return
                  var role = form.role.trim()
                  // 有 botId 就是改这个 agent（名字与职责属于 agent 本身，不是某个房间的成员），
                  // 没有就是在这间屋子里新建一个。
                  var task = form.botId
                    ? store.command('bot.update', { botId: form.botId, name: name, role: role })
                    : store.command('member.createBot', { roomId: room.id, name: name, role: role })
                  task.then(() => ui.setAgentForm(null)).catch(() => {})
                },
                onEditAgent: (botId) => {
                  var bot = (snapshot.bots || []).find((row) => row.id === botId)
                  if (!bot) return
                  ui.setPickingAgent(false)
                  ui.setAgentForm({ botId: bot.id, name: bot.name, role: bot.role || '' })
                },
                onNewAgent: () => {
                  ui.setPickingAgent(false)
                  ui.setAgentForm({ botId: null, name: '', role: '' })
                },
                onRules: (patch) => store.command('room.update', { roomId: room.id, rules: patch }),
                onRemove: (memberId) => store.command('member.remove', { roomId: room.id, memberId: memberId }),
                onDissolve: () => {
                  ui.setConfirmDissolve(false)
                  store.command('room.dissolve', { roomId: room.id })
                },
                confirmDissolve: ui.confirmDissolve,
                onAskDissolve: () => ui.setConfirmDissolve(true),
                onCancelDissolve: () => ui.setConfirmDissolve(false),
                onLeaveRemote: () => {
                  var found = (snapshot.links || []).find((link) => link.localRoomId === room.id)
                  if (found) store.command('lan.leave', { linkId: found.id }).catch(() => {})
                },
                onAddAgent: () => {
                  if (ui.pickingAgent) {
                    ui.setPickingAgent(false)
                    return
                  }
                  // 手上还没有 agent 就直接填表单；已经有几个就先把它们列出来，末行也能新建。
                  if ((view.snapshot.bots || []).length === 0) {
                    ui.setAgentForm({ botId: null, name: '', role: '' })
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
      var floatRef = React.useRef(null)
      var flowRef = React.useRef(null)
      var scrollKey = React.useRef('')
      var suppressClick = React.useRef(false)
      var [draft, setDraft] = React.useState('')
      var [dragging, setDragging] = React.useState(false)
      var [retrySeq, setRetrySeq] = React.useState(null)

      // 记住的坐标可能来自一个更大的窗口：位置一变（含重开页面）就先按当前视口夹一次。
      React.useEffect(() => {
        if (!view.floatPos) return
        var node = floatRef.current
        var rect = node ? node.getBoundingClientRect() : null
        var next = clampFloat(view.floatPos.x, view.floatPos.y, rect ? rect.width : 296, rect ? rect.height : 360)
        if (next.x !== view.floatPos.x || next.y !== view.floatPos.y) {
          store.set({ floatPos: next })
          saveFloatPos(next)
        }
      }, [view.floatPos, view.floatOpen])

      // 窗口被拖窄时也要夹：否则浮窗连标题栏都在屏幕外，拖都拖不回来。
      React.useEffect(() => {
        function onResize() {
          var current = store.get().floatPos
          if (!current) return
          var node = floatRef.current
          var rect = node ? node.getBoundingClientRect() : null
          var next = clampFloat(current.x, current.y, rect ? rect.width : 296, rect ? rect.height : 360)
          if (next.x !== current.x || next.y !== current.y) {
            store.set({ floatPos: next })
            saveFloatPos(next)
          }
        }
        window.addEventListener('resize', onResize)
        return function () {
          window.removeEventListener('resize', onResize)
        }
      }, [])

      /* 拖动对胶囊和展开的卡片一视同仁：收起成胶囊以后它也得能拖 —— 两者共用同一个位置，
       * 只是窗口小了一号。所以监听常驻，收起状态不再提前 return。 */
      function beginDrag(event) {
        if (event.button > 0) return
        var node = floatRef.current
        if (!node) return
        var rect = node.getBoundingClientRect()
        suppressClick.current = false
        dragRef.current = {
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          originX: event.clientX,
          originY: event.clientY,
          moved: false,
        }
        setDragging(true)
      }

      React.useEffect(() => {
        function onMove(event) {
          var grab = dragRef.current
          if (!grab) return
          // 手没动就不算拖：松手以后要按点击处理（收起状态点一下才是展开）。
          if (!grab.moved) {
            if (Math.abs(event.clientX - grab.originX) < 4 && Math.abs(event.clientY - grab.originY) < 4) return
            grab.moved = true
          }
          // 拖动中就不许出界：松手以后没有第二个抓手能把它拉回来。
          store.set({ floatPos: clampFloat(event.clientX - grab.dx, event.clientY - grab.dy, grab.width, grab.height) })
        }
        function onUp() {
          var grab = dragRef.current
          if (!grab) return
          dragRef.current = null
          setDragging(false)
          if (!grab.moved) return
          suppressClick.current = true
          var position = store.get().floatPos
          if (position) saveFloatPos(position)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return function () {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [store])

      // 浮窗展开着就是「正在看」：未读随之清掉，胶囊和标题前缀上的数字才会落回去。
      var marked = React.useRef({ roomId: null, seq: 0 })
      React.useEffect(() => {
        if (!view.floatOpen || !room || !room.unread) return
        if (room.remote && room.remote.lost) return
        var seq = room.nextSeq - 1
        if (marked.current.roomId === room.id && marked.current.seq === seq) return
        marked.current = { roomId: room.id, seq: seq }
        store.command('read.mark', { roomId: room.id, seq: seq }).catch(() => {})
      })

      // 浮窗只放得下六条：新消息进来、或者窗刚展开，都要停在最后一条上，
      // 否则看到的是六条里最旧的那半句（最新一句被输入框切掉半行）。
      React.useEffect(() => {
        var node = flowRef.current
        if (!node || !room) return
        var last = room.messages.length ? room.messages[room.messages.length - 1].seq : 0
        var key = room.id + ':' + last + ':' + (view.floatOpen ? 'open' : 'shut')
        if (key === scrollKey.current) return
        scrollKey.current = key
        node.scrollTop = node.scrollHeight
      })

      if (!room) return null
      var style = view.floatPos
        ? { right: 'auto', bottom: 'auto', left: view.floatPos.x + 'px', top: view.floatPos.y + 'px' }
        : null
      var messages = room.messages.filter((message) => message.status !== 'error').slice(-6)
      var gone = Boolean(room.remote && room.remote.lost)
      // 浮窗里只留最近几条，失败那行不在其中 —— 但「没回上来」不能就这么消失，
      // 所以单独把最后一条失败消息提出来，照样给一个重试入口。
      var lastMessage = room.messages.length ? room.messages[room.messages.length - 1] : null
      var failed = !room.remote && lastMessage && lastMessage.status === 'error' ? lastMessage : null
      var busy = Boolean(room.activity && room.activity.speaking && room.activity.speaking.length)
      // 浮窗里也有输入框，也会撞上「说了一句没人接」——同一句解释，别只在面板里说。
      // 但它点不到「让全员说一轮」，所以用短的那一版。
      var hint = silenceNote(room, view.snapshot?.self?.id ?? 'me', tr, true)

      if (!view.floatOpen) {
        return h(
          'div',
          { className: 'cr-float', style: style, ref: floatRef },
          h(
            'button',
            {
              className: 'cr-float-pill' + (dragging ? ' cr-dragging' : ''),
              title: tr('floatDragPill'),
              onPointerDown: beginDrag,
              onClick: (event) => {
                // 拖完松手时浏览器还会补一个 click：那一下不能顺带把窗展开。
                // 键盘激活（detail 0）不走这条，回车照样能开。
                if (suppressClick.current && event.detail !== 0) {
                  suppressClick.current = false
                  return
                }
                suppressClick.current = false
                store.set({ floatOpen: true, notice: null })
              },
            },
            h('span', { className: 'cr-grip' }),
            h(NavIcon, { store: store, size: 14, badge: false }),
            h('span', null, room.name),
            room.unread > 0 ? h('span', { className: 'cr-badge' }, String(room.unread)) : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'cr-float', style: style, ref: floatRef },
        h(
          'div',
          { className: 'cr-float-card' },
          h(
            'div',
            {
              className: 'cr-float-head' + (dragging ? ' cr-dragging' : ''),
              title: tr('floatDrag'),
              onPointerDown: beginDrag,
              // 拖丢了也能一键回到默认角落：记下的坐标不该变成单程票。
              onDoubleClick: () => {
                dragRef.current = null
                setDragging(false)
                clearFloatPos()
                store.set({ floatPos: null })
              },
            },
            h('span', { className: 'cr-grip' }),
            h('span', { className: 'cr-float-title' }, room.name),
            h(
              'button',
              { className: 'cr-icon-btn', title: tr('floatClose'), onClick: () => store.set({ floatOpen: false }) },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'cr-float-flow', ref: flowRef },
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
            failed
              ? h(
                  'div',
                  { key: 'retry', className: 'cr-float-msg cr-float-failed' },
                  h('div', { className: 'cr-float-who' }, failed.authorName + ' · ' + clock(failed.at)),
                  h('div', null, failed.text),
                  h(
                    'button',
                    {
                      className: 'cr-link-btn',
                      disabled: busy || retrySeq === failed.seq,
                      title: busy ? tr('busy') : null,
                      onClick: () => {
                        if (busy || retrySeq === failed.seq) return
                        setRetrySeq(failed.seq)
                        store
                          .command('msg.retry', { roomId: room.id, seq: failed.seq })
                          .catch(() => {})
                          .then(() => setRetrySeq(null))
                      },
                    },
                    retrySeq === failed.seq ? tr('retry') + '…' : tr('retry'),
                  ),
                )
              : null,
            hint ? h('div', { key: 'hint', className: 'cr-float-hint' }, hint) : null,
          ),
          h(
            'div',
            { className: 'cr-float-compose' },
            h('textarea', {
              className: 'cr-float-input',
              placeholder: gone ? tr('roomGone') : tr('floatHint'),
              value: draft,
              rows: 1,
              disabled: gone,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (imePicking(event)) return
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (gone) return
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
                disabled: gone || !draft.trim(),
                onClick: () => {
                  if (gone) return
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
          style: { position: 'relative' },
          onClick: () => props.store.set({ floatOpen: !view.floatOpen, notice: null }),
          title: props.tr('floatOpen'),
        },
        h(NavIcon, { store: props.store, size: 14, badge: false }),
        h('span', null, props.tr('floatOpen')),
        unread > 0 ? h('span', { className: 'cr-badge' }, String(unread)) : null,
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
        nameDraft: '',
        // 左栏「我的 agent」的新建表单：和成员列那个 agentForm 分开，
        // 否则打开一个，另一个也跟着弹出来。
        myForm: null,
        // 删 agent、解散屋子都收不回来：先问一次再动手，别让一次误点把东西弄没。
        confirmBot: null,
        confirmDissolve: false,
        // 正在重试的那条消息（按 seq 记）：只用来把按钮按下去，别让整片消息区重排。
        retrySeq: null,
        // 已经翻回来的更早消息：{ roomId, items, hasMore, loading }。
        // 只放界面临时翻出来的那几页 —— 它们是投影之外的东西，不写进 store 的状态，
        // 也不会被长轮询的新投影冲掉。
        older: null,
        agentForm: null,
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
        get nameDraft() {
          return uiState.nameDraft
        },
        setNameDraft: (value) => setUi({ nameDraft: value }),
        get myForm() {
          return uiState.myForm
        },
        setMyForm: (value) => setUi({ myForm: value }),
        get confirmBot() {
          return uiState.confirmBot
        },
        setConfirmBot: (value) => setUi({ confirmBot: value }),
        get confirmDissolve() {
          return uiState.confirmDissolve
        },
        setConfirmDissolve: (value) => setUi({ confirmDissolve: value }),
        get retrySeq() {
          return uiState.retrySeq
        },
        setRetrySeq: (value) => setUi({ retrySeq: value }),
        get agentForm() {
          return uiState.agentForm
        },
        setAgentForm: (value) => setUi({ agentForm: value }),
        get older() {
          return uiState.older
        },
        setOlder: (value) => setUi({ older: value }),
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
