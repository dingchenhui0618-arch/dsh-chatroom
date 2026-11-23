import pathlib
p = pathlib.Path(r"D:\Projects\dsh-chatroom\design\demos\A-abyss.html")
s = p.read_text(encoding="utf-8")
s = s.replace(
    ".comp-stage{width:520px;height:248px;overflow:hidden;border:1px solid #ffffff10;border-radius:var(--r-lg);background:#161719;padding:var(--s3);position:relative}",
    ".comp-stage{width:520px;height:300px;overflow:hidden;border:1px solid #ffffff10;border-radius:var(--r-lg);background:#161719;padding:132px var(--s3) var(--s3);position:relative}",
)
s = s.replace(".comp-stage .mention-pop{position:absolute;left:var(--s3);bottom:98px}",
              ".comp-stage .mention-pop{position:absolute;left:var(--s3);top:var(--s3);bottom:auto}")
p.write_text(s, encoding="utf-8")
print("ok")
