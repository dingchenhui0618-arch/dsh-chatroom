import base64, io
from PIL import Image

src = Image.open(r"D:\Projects\dsh-chatroom\design\assets\whale-white.png").convert("RGBA")
w, h = src.size
# keep alpha, drop colour -> white on transparent, then downscale to 96px wide
alpha = src.split()[3]
target_w = 96
target_h = round(h * target_w / w)
small = alpha.resize((target_w, target_h), Image.LANCZOS)
# binarise lightly so the mask keeps a crisp edge at small sizes
px = small.load()
for y in range(target_h):
    for x in range(target_w):
        px[x, y] = 255 if px[x, y] > 96 else 0
out = Image.new("RGBA", (target_w, target_h), (255, 255, 255, 0))
out.putalpha(small)
buf = io.BytesIO()
out.save(buf, format="PNG", optimize=True)
data = base64.b64encode(buf.getvalue()).decode()
print(len(buf.getvalue()), len(data), target_w, target_h)
with open(r"D:\Projects\dsh-chatroom\design\mcp\whale-mask.txt", "w", encoding="ascii") as f:
    f.write(data)
