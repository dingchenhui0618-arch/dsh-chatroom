import pathlib

root = pathlib.Path(r"D:\Projects\dsh-chatroom\design\demos")

A_CSS = """
  .lattice{display:flex;align-items:center;gap:var(--s2);margin-left:40px;color:var(--muted);font-size:12px}
  .lat{display:grid;grid-template-columns:repeat(8,3px);grid-template-rows:repeat(2,3px);gap:2px;flex:0 0 auto}
  .lat i{background:var(--live);opacity:.18;border-radius:1px;animation:wave 1.7s var(--ease) infinite}
  .lat-time{font-family:var(--mono);font-size:10px;color:var(--caption);margin-left:auto;padding-right:var(--s1);font-variant-numeric:tabular-nums}
  @keyframes wave{0%,100%{opacity:.15}45%{opacity:.95}}
"""
B_CSS = """
  .thought{display:flex;align-items:center;gap:var(--s3);margin-left:38px;color:var(--muted);font-size:12px;font-family:var(--serif);letter-spacing:.04em;border-bottom:1px solid var(--line);padding-bottom:var(--s2)}
  .thought .inkline{display:inline-block;height:1px;width:28px;background:var(--seal);animation:underline 2.4s var(--ease) infinite}
  .t-time{font-family:var(--mono);font-size:10px;color:var(--caption);margin-left:auto;font-variant-numeric:tabular-nums}
"""
C_CSS = """
  .lattice{display:flex;align-items:center;gap:var(--s2);margin-left:38px;font-family:var(--mono);font-size:10px;color:var(--caption);letter-spacing:.04em}
  .lat{display:grid;grid-template-columns:repeat(8,3px);grid-template-rows:repeat(2,3px);gap:2px;flex:0 0 auto}
  .lat i{background:var(--sig);opacity:.18;animation:wave 1.5s var(--ease) infinite}
  .lat-time{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--caption);padding-right:var(--s1)}
  @keyframes wave{0%,100%{opacity:.15}45%{opacity:.95}}
"""

def delays():
    out = []
    for i in range(16):
        d = round((i % 8) * 0.085 + (i // 8) * 0.04, 3)
        out.append(f"  .lat i:nth-child({i+1}){{animation-delay:{d}s}}")
    return "\n".join(out)

for name, css, anchor in (
    ("A-abyss.html", A_CSS, "  @keyframes breathe"),
    ("B-ink.html", B_CSS, "  @keyframes ink"),
    ("C-signal.html", C_CSS, "  @keyframes scan"),
):
    p = root / name
    s = p.read_text(encoding="utf-8")
    block = css + ("\n" + delays() if ".lat i" in css else "") + "\n"
    if anchor not in s:
        print("MISS anchor", name)
        continue
    s = s.replace(anchor, block + anchor, 1)
    p.write_text(s, encoding="utf-8")
    print("css added", name)
