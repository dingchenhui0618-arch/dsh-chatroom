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
      code: '房间码',
      members: '成员',
      noMessages: '屋里还很安静。说第一句吧。',
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
      trunc: '只显示最近 200 条',
      settingsSelf: '我的名字',
      myAgents: '我的 agent',
      myAgentsNone: '还没有 agent：建一个，加入 LAN 房间时会一起带进屋。',
      myAgentsHint: '这些是跟着你这台机器走的 agent。加到别人的屋里时，它们跑的是各自在这台机器上的会话。',
      bringAgents: '进屋会带上：',
      bringNone: '本机还没有 agent，进屋只有你一个人。',
      removeAgent: '删掉这个 agent',
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
      code: 'Room code',
      members: 'Members',
      noMessages: 'Quiet in here. Say the first thing.',
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
      trunc: 'Showing the last 200 messages',
      settingsSelf: 'My name',
      myAgents: 'My agents',
      myAgentsNone: 'No agent yet — make one and it travels with you into a LAN room.',
      myAgentsHint: 'These agents belong to this machine: they run in their own local sessions, wherever the room is hosted.',
      bringAgents: 'Coming with you: ',
      bringNone: 'No agent on this machine yet — you would join alone.',
      removeAgent: 'Delete this agent',
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
      /* 只用宿主 token，取不到就退回中性值 —— 明暗主题都不需要单独写一套。
       * 颜色 / 间距 / 圆角先落成 --cr-* 变量再写组件；间距只走 4/8 栅格，字号只出现 11/12/13/14 四档。 */
      '.cr-main,.cr-float,.cr-toast-wrap{--cr-fg:var(--dsw-alias-label-primary,#e9eaee);--cr-muted:var(--dsw-alias-label-secondary,#9aa0aa);--cr-line:var(--dsw-alias-border-l1,rgba(255,255,255,.09));--cr-surface:var(--dsw-alias-bg-overlay,#171a20);--cr-accent:var(--dsw-alias-brand-primary,#4f7cff);--cr-hover:color-mix(in srgb,currentColor 7%,transparent);--cr-raised:color-mix(in srgb,currentColor 5%,transparent);--cr-r:8px;--cr-r-lg:12px;--cr-s1:4px;--cr-s2:8px;--cr-s3:12px;--cr-s4:16px;--cr-s5:24px}',

      /* 骨架：三列只靠一条发丝线分开，不再给每一列套一层框。 */
      '.cr-main{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--cr-fg)}',
      '.cr-grid{display:grid;grid-template-columns:224px minmax(0,1fr) 252px;height:100%;min-height:0}',
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
      '.cr-btn.cr-primary{border-color:transparent;background:var(--cr-accent);color:#fff}',
      '.cr-btn.cr-primary:hover{filter:brightness(1.06)}',
      '.cr-btn.cr-ghost{border-color:transparent;color:var(--cr-muted)}',
      '.cr-btn.cr-ghost:hover{background:var(--cr-hover);color:var(--cr-fg)}',
      '.cr-btn.cr-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 38%,transparent)}',
      '.cr-btn.cr-danger:hover{background:color-mix(in srgb,#e5484d 12%,transparent)}',
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
      '.cr-badge{min-width:16px;height:16px;padding:0 var(--cr-s1);border-radius:8px;background:var(--cr-accent);color:#fff;font-size:11px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
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
      '.cr-agent-x:hover{color:#e5484d}',
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
      '.cr-chip.cr-danger{color:#e5484d;background:color-mix(in srgb,#e5484d 14%,transparent)}',
      /* 主题可以很长：让它先缩、先省略，别把「邀请 / 规则」顶出可视区。 */
      '.cr-chip.cr-topic{flex:0 1 auto;min-width:48px;max-width:300px}',
      '.cr-flow{flex:1;min-height:0;overflow:auto;padding:var(--cr-s3) var(--cr-s4) var(--cr-s4);display:flex;flex-direction:column;gap:var(--cr-s4)}',
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
      '.cr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--cr-s2);height:100%;padding:var(--cr-s5);text-align:center;color:var(--cr-muted);font-size:12px;line-height:1.6}',

      /* LAN：加入别人的屋子 / 邀请另一台机器。整条通栏铺开，不再浮在消息区里当一张小卡片。 */
      '.cr-col-foot{margin-top:auto;padding:var(--cr-s2) var(--cr-s3) var(--cr-s3);border-top:1px solid var(--cr-line);display:flex;flex-direction:column;gap:var(--cr-s1)}',
      '.cr-link-btn{border:0;background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;padding:0;min-height:24px;cursor:pointer;text-align:left;line-height:1.5}',
      '.cr-link-btn:hover{color:var(--cr-fg)}',
      '.cr-invite{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s3) var(--cr-s4);border-bottom:1px solid var(--cr-line);background:var(--cr-raised)}',
      '.cr-invite-row{display:flex;align-items:center;gap:var(--cr-s2);font-size:12px;min-height:24px}',
      '.cr-invite-label{color:var(--cr-muted);font-size:11px;width:48px;flex:0 0 48px;white-space:nowrap}',
      '.cr-invite code{font-size:12px;padding:2px var(--cr-s2);border-radius:6px;background:var(--cr-hover);font-variant-numeric:tabular-nums}',
      '.cr-invite-note{font-size:11px;color:var(--cr-muted);line-height:1.5}',

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
      '.cr-float-who{font-size:11px;color:var(--cr-muted);margin-bottom:var(--cr-s1)}',
      '.cr-lan-tag{color:var(--cr-accent)}',
      '.cr-float-compose{display:flex;gap:var(--cr-s1);padding:var(--cr-s2);border-top:1px solid var(--cr-line);align-items:flex-end}',
      '.cr-float-input{flex:1;min-height:28px;max-height:80px;resize:none;border:1px solid var(--cr-line);border-radius:var(--cr-r);background:var(--cr-raised);color:inherit;font:inherit;font-size:12px;line-height:1.4;padding:var(--cr-s1) var(--cr-s2);box-sizing:border-box}',

      /* 提醒 */
      '.cr-toast-wrap{position:fixed;right:var(--cr-s4);top:56px;z-index:75;display:flex;flex-direction:column;gap:var(--cr-s2);pointer-events:none}',
      '.cr-toast{pointer-events:auto;max-width:300px;display:flex;flex-direction:column;gap:var(--cr-s1);padding:var(--cr-s2) var(--cr-s3);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:0 12px 32px -8px rgba(0,0,0,.5);font-size:12px;line-height:1.45;color:var(--cr-fg);cursor:pointer}',
      '.cr-toast-name{font-size:11px;color:var(--cr-muted)}',
      '.cr-nav-badge{position:absolute;top:-5px;right:-6px;min-width:16px;height:16px;padding:0 var(--cr-s1);border-radius:8px;background:var(--cr-accent);color:#fff;font-size:11px;font-weight:500;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      '.cr-error{color:#e5484d;font-size:12px;padding:var(--cr-s1) var(--cr-s4)}',
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
                  h(
                    'span',
                    { key: bot.id, className: 'cr-chip cr-agent-chip', title: bot.role || '' },
                    h('span', { className: 'cr-agent-name' }, bot.name),
                    h(
                      'button',
                      {
                        className: 'cr-agent-x',
                        'aria-label': tr('removeAgent'),
                        title: tr('removeAgent'),
                        onClick: () => props.onRemoveMy(bot.id),
                      },
                      '×',
                    ),
                  ),
                ),
              )
            : h('div', { className: 'cr-hint' }, tr('myAgentsNone')),
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
                    if (event.key === 'Enter') props.onJoin()
                  },
                }),
                // 加入那一刻只能带走「本机已经有的」agent —— 这句是唯一提前讲清楚的地方。
                h(
                  'div',
                  { className: 'cr-hint' },
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
        if (!same || previous === null || nearBottom) node.scrollTop = node.scrollHeight
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
            selfName: snapshot.self.name,
            nameDraft: ui.nameDraft,
            onNameDraft: ui.setNameDraft,
            bots: snapshot.bots || [],
            myForm: ui.myForm,
            onMyDraft: (patch) => ui.setMyForm(Object.assign({}, ui.myForm, patch)),
            onMyCancel: () => ui.setMyForm(null),
            onRemoveMy: (botId) => {
              store.command('bot.remove', { botId: botId }).catch(() => {})
            },
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
                  { className: 'cr-flow', ref: flowRef },
                  room.messages.length === 0
                    ? h('div', { className: 'cr-empty' }, tr('noMessages'))
                    : room.messages.map((message) =>
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
                onDissolve: () => store.command('room.dissolve', { roomId: room.id }),
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
        // 正在重试的那条消息（按 seq 记）：只用来把按钮按下去，别让整片消息区重排。
        retrySeq: null,
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
        get retrySeq() {
          return uiState.retrySeq
        },
        setRetrySeq: (value) => setUi({ retrySeq: value }),
        get agentForm() {
          return uiState.agentForm
        },
        setAgentForm: (value) => setUi({ agentForm: value }),
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
