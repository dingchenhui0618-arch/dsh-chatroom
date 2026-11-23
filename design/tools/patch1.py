import pathlib, re, sys

root = pathlib.Path(r"D:\Projects\dsh-chatroom\design\demos")

def patch(name, pairs):
    p = root / name
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        if old not in s:
            print("MISS", name, old[:60])
            continue
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
    print("patched", name)

# ---------- A ----------
a = [
  (".pill{position:absolute;right:300px;bottom:112px;", ".pill{position:absolute;right:24px;bottom:172px;"),
  ('.board::before{content:"";position:absolute;inset:0;pointer-events:none;\n    background:radial-gradient(1200px 320px at 46% -120px,#8fd9d01a,transparent 70%)}',
   '.board::before{content:"";position:absolute;inset:0;pointer-events:none;\n    background:radial-gradient(1200px 320px at 46% -120px,#8fd9d01a,transparent 70%)}\n  .board::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.035;\n    background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'140\' height=\'140\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.9\' numOctaves=\'2\'/%3E%3C/filter%3E%3Crect width=\'140\' height=\'140\' filter=\'url(%23n)\' opacity=\'.6\'/%3E%3C/svg%3E")}'),
  ('.flow{flex:1;padding:var(--s5) var(--s5) var(--s4);display:flex;flex-direction:column;gap:var(--s4);overflow:hidden}',
   '.flow{flex:1;padding:var(--s4) var(--s5) var(--s3);display:flex;flex-direction:column;gap:14px;overflow:hidden;background:linear-gradient(180deg,#ffffff05,transparent 30%,transparent 70%,#00000026)}'),
]
patch("A-abyss.html", a)

# trim one message from all three (the 09:32 line) so the 900px board breathes
def drop_block(name, marker):
    p = root / name
    s = p.read_text(encoding="utf-8")
    i = s.index(marker)
    # find the enclosing <div class="msg ..."> before the marker, and its matching close
    start = s.rindex('<div class="msg', 0, i)
    # naive but deterministic: each message block ends with the next '\n          </div>\n' at msg indent
    end = s.index('\n          </div>\n', i) + len('\n          </div>\n')
    s = s[:start] + s[end:]
    p.write_text(s, encoding="utf-8")
    print("trimmed", name)

drop_block("A-abyss.html", '退货率这版按 6.2% 算的')
drop_block("B-ink.html", '退货率这版按 6.2% 算的')
drop_block("C-signal.html", '退货率这版按 6.2% 算的')

# ---------- B ----------
b = [
  (".ticket{position:absolute;right:300px;bottom:112px;", ".ticket{position:absolute;right:24px;bottom:176px;"),
  ('.t-mark img{width:24px;height:auto;opacity:.92}', '.t-mark img{width:26px;height:auto}'),
  ('.stamp .sq img{width:42px;height:auto;opacity:.9}', '.stamp .sq img{width:42px;height:auto;opacity:.85;filter:none}'),
]
patch("B-ink.html", b)

# swap ticket + stamp whales to the white version
p = root / "B-ink.html"
s = p.read_text(encoding="utf-8")
s = s.replace('<div class="t-mark"><img src="../assets/whale-black.png" alt=""></div>',
              '<div class="t-mark"><img src="../assets/whale-white.png" alt=""></div>')
s = s.replace('<span class="sq"><img src="../assets/whale-black.png" alt=""></span>',
              '<span class="sq"><img src="../assets/whale-white.png" alt=""></span>')
p.write_text(s, encoding="utf-8")
print("patched B whales")

# ---------- C ----------
c = [
  ('.msg{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:var(--s2) var(--s3);align-items:start;position:relative;padding:2px 0}',
   '.msg{display:grid;grid-template-columns:26px minmax(0,1fr) 34px 30px;gap:var(--s2) var(--s3);align-items:start;position:relative;padding:2px 0}'),
  ('.msg.mine{grid-template-columns:auto minmax(0,1fr) 26px}\n  .msg.mine .avatar{order:3}\n  .msg.mine .chan{order:2}\n', ''),
  ('.pill{position:absolute;right:300px;bottom:112px;', '.pill{position:absolute;right:24px;bottom:172px;'),
]
patch("C-signal.html", c)
