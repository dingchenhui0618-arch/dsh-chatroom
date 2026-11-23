import pathlib
root = pathlib.Path(r"D:\Projects\dsh-chatroom\design\demos")

A = [
    ("--muted:#a6acb6; --caption:#7d838e;", "--muted:#b3b9c3; --caption:#8d939e;"),
    (".f-msg .text{font-size:13px}", ".f-msg .text{font-size:14px}"),
]
B = [
    ("--fg:#f1ece1; --muted:#a9a296; --caption:#7e776b;", "--fg:#f1ece1; --muted:#bab2a4; --caption:#9a9284;"),
    (".f-msg .text{font-size:13px;line-height:1.7}", ".f-msg .text{font-size:14px;line-height:1.7}"),
]
C = [
    ("--fg:#eef1f4; --muted:#9aa1a9; --caption:#6f767e;", "--fg:#eef1f4; --muted:#adb4bc; --caption:#8b929a;"),
    (".f-msg .text{font-size:13px}", ".f-msg .text{font-size:14px}"),
]

for name, pairs in (("A-abyss.html", A), ("B-ink.html", B), ("C-signal.html", C)):
    p = root / name
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        if old not in s:
            print("MISS", name, old[:40])
            continue
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
    print("ok", name)
