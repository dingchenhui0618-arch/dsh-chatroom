import sys, os, pathlib
from playwright.sync_api import sync_playwright

root = pathlib.Path(r"D:\Projects\dsh-chatroom\design")
out = root / "shots"
out.mkdir(exist_ok=True)
only = sys.argv[1] if len(sys.argv) > 1 else None

files = sorted((root / "demos").glob("*.html"))
if only:
    files = [f for f in files if only in f.name]

with sync_playwright() as p:
    b = p.chromium.launch()
    for f in files:
        page = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page.goto(f.as_uri())
        page.wait_for_timeout(700)
        stem = f.stem
        page.locator(".board").screenshot(path=str(out / f"{stem}-panel.png"))
        if page.locator(".detail").count():
            page.locator(".detail").screenshot(path=str(out / f"{stem}-detail.png"))
        h = page.evaluate("document.body.scrollHeight")
        w = page.evaluate("document.body.scrollWidth")
        print(stem, "page", w, h)
        page.close()
    b.close()
print("shots in", out)
