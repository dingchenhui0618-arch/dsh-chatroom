import pathlib
root = pathlib.Path(r"D:\Projects\dsh-chatroom\design\demos")

def patch(name, pairs):
    p = root / name
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        if old not in s:
            print("MISS", name, old[:50]); continue
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
    print("ok", name)

patch("A-abyss.html", [
  (".lat{display:grid;grid-template-columns:repeat(8,3px);grid-template-rows:repeat(2,3px);gap:2px;flex:0 0 auto}",
   ".lat{display:grid;grid-template-columns:repeat(8,4px);grid-template-rows:repeat(2,4px);gap:2px;flex:0 0 auto}"),
  (".lat i{background:var(--live);opacity:.18;border-radius:1px;animation:wave 1.7s var(--ease) infinite}",
   ".lat i{background:var(--live);opacity:.3;border-radius:1px;animation:wave 1.7s var(--ease) infinite}"),
])

patch("C-signal.html", [
  (".lat{display:grid;grid-template-columns:repeat(8,3px);grid-template-rows:repeat(2,3px);gap:2px;flex:0 0 auto}",
   ".lat{display:grid;grid-template-columns:repeat(8,4px);grid-template-rows:repeat(2,4px);gap:2px;flex:0 0 auto}"),
  (".lat i{background:var(--sig);opacity:.18;animation:wave 1.5s var(--ease) infinite}",
   ".lat i{background:var(--sig);opacity:.3;animation:wave 1.5s var(--ease) infinite}"),
  (".msg.mine .text{background:#ffffff07;border:1px solid var(--line);border-left:2px solid #ffffff33;padding:6px 10px;border-radius:0 var(--r) var(--r) 0;margin-left:-2px}",
   ".msg.mine .msg-body{align-items:flex-end}\n  .msg.mine .text{background:#ffffff07;border:1px solid var(--line);border-right:2px solid #ffffff38;padding:6px 10px;border-radius:var(--r) 0 0 var(--r);text-align:right;max-width:640px}"),
  (".send{height:32px;padding:0 var(--s2);", ".send{height:32px;padding:0 10px;flex:0 0 auto;"),
  (".send kbd{font-family:var(--mono);font-size:10px;color:var(--caption);border:1px solid var(--line);border-radius:2px;padding:0 3px}",
   ".send kbd{display:none}"),
])
