import pathlib

root = pathlib.Path(r"D:\Projects\dsh-chatroom\design\demos")

MSGS = [
    dict(kind="mine", who="林", name="林岸（我）", time="09:30", chan="L1", seq="55",
         text="这批预算我按 45 天账期算的，@账期 agent 先看缺口。", at="账期 agent"),
    dict(kind="agent", who="账", name="账期 agent", time="09:31", chan="A1", seq="56",
         text="45 天账期下，10 月缺口约 82 万，集中在第二周。把两笔大额应付款挪到 11/03，缺口降到 31 万。"),
    dict(kind="mine", who="林", name="林岸（我）", time="09:33", chan="L1", seq="57",
         text="那就先把尾货清仓价挂出来，预算按 7.1% 重算一版。"),
    dict(kind="agent", who="退", name="退货 agent", time="09:34", chan="A2", seq="58",
         text="尾货清仓价已经挂出去了，按 7.1% 重算 Q4 退货成本压到 14 万。"),
    dict(kind="remote", who="周", name="周荻", time="09:35", chan="R1", seq="59",
         text="我这边先把退货率放上来：上周华东仓冒到 7.1%。"),
    dict(kind="mine", who="林", name="林岸（我）", time="09:36", chan="L1", seq="60",
         text="@尾货 agent 7.1% 里尾货占多少？", at="尾货 agent"),
    dict(kind="remote", who="尾", name="尾货 agent", time="09:37", chan="A3", seq="61",
         text="尾货占退货的 62%，三款夏装清仓能把 Q4 退货成本压回 15 万以内。"),
]

def txt(m):
    t = m["text"]
    if m.get("at"):
        t = t.replace("@" + m["at"], '<span class="at">@' + m["at"] + "</span>")
    return t

def flow_A():
    out = ['<div class="flow">', '          <div class="day">11 月 17 日</div>', '']
    for m in MSGS:
        cls = "msg mine" if m["kind"] == "mine" else "msg"
        live = ' live' if m["kind"] == "remote" and m["who"] == "尾" else ""
        src = '<span class="src">LAN · 周荻的 MacBook</span>' if m["kind"] == "remote" else ""
        out.append(f'          <div class="{cls}">')
        out.append(f'            <div class="avatar{live}">{m["who"]}</div>')
        out.append('            <div class="msg-body">')
        out.append(f'              <div class="meta"><span class="name">{m["name"]}</span>{src}<span class="time">{m["time"]}</span></div>')
        out.append(f'              <div class="text">{txt(m)}</div>')
        out.append('            </div>')
        out.append('          </div>')
        out.append('')
    out.append('          <div class="lattice">')
    out.append('            <span class="lat">' + ''.join(['<i></i>' for _ in range(16)]) + '</span>')
    out.append('            <span>账期 agent 正在算 11/03 的那笔</span><span class="lat-time">00:04</span>')
    out.append('          </div>')
    out.append('        </div>\n\n        ')
    return "\n".join(out)

def flow_B():
    out = ['<div class="flow">', '          <div class="day">11 月 17 日</div>', '']
    for m in MSGS:
        kind = m["kind"]
        cls = "msg mine" if kind == "mine" else ("msg remote" if kind == "remote" else "msg")
        seal = "seal me" if kind == "mine" else ("seal remote" if kind == "remote" else "seal")
        src = '<span class="src">LAN · 周荻的 MacBook</span>' if kind == "remote" else ""
        fresh = " fresh" if m["seq"] == "61" else ""
        out.append(f'          <div class="{cls}{fresh}">')
        out.append(f'            <div class="{seal}">{m["who"]}</div>')
        out.append('            <div class="msg-body">')
        out.append(f'              <div class="meta"><span class="name">{m["name"]}</span>{src}<span class="time">{m["time"]}</span></div>')
        out.append(f'              <div class="text">{txt(m)}</div>')
        out.append('            </div>')
        out.append('          </div>')
        out.append('')
    out.append('          <div class="thought"><span class="inkline"></span>账期 agent 正在写 11/03 的条款 <span class="t-time">00:04</span></div>')
    out.append('        </div>\n\n        ')
    return "\n".join(out)

def flow_C():
    out = ['<div class="flow">', '          <div class="day">11 月 17 日 · 上午</div>', '']
    for m in MSGS:
        kind = m["kind"]
        cls = "msg mine" if kind == "mine" else ("msg remote" if kind == "remote" else "msg")
        new = " new" if m["seq"] == "61" else ""
        src = f'<span class="src">LAN · {m["chan"]}</span>' if kind == "remote" else ""
        out.append(f'          <div class="{cls}{new}">')
        out.append(f'            <div class="avatar">{m["who"]}</div>')
        out.append('            <div class="msg-body">')
        out.append(f'              <div class="meta"><span class="name">{m["name"]}</span>{src}<span class="time">{m["time"]}</span></div>')
        out.append(f'              <div class="text">{txt(m)}</div>')
        out.append('            </div>')
        out.append(f'            <span class="chan mono">{m["chan"]}</span><span class="seq">#{m["seq"]}</span>')
        out.append('          </div>')
        out.append('')
    out.append('          <div class="lattice"><span class="lat">' + ''.join(['<i></i>' for _ in range(16)]) + '</span><span class="mono">A1 · 计算中</span><span class="lat-time">00:04</span></div>')
    out.append('        </div>\n\n        ')
    return "\n".join(out)

flows = {"A-abyss.html": flow_A, "B-ink.html": flow_B, "C-signal.html": flow_C}

for name, fn in flows.items():
    p = root / name
    s = p.read_text(encoding="utf-8")
    start = s.index('<div class="flow">')
    end = s.index('<div class="composer"')
    s = s[:start] + fn() + s[end:]
    p.write_text(s, encoding="utf-8")
    print("rebuilt flow", name)
