from PIL import Image
import os
d = r"D:\Projects\dsh-chatroom\design\assets"
for name, bg in (("whale-white.png", (21, 21, 23)), ("whale-black.png", (245, 245, 244))):
    im = Image.open(os.path.join(d, name)).convert("RGBA")
    w, h = im.size
    # scale into a 360x260 panel
    scale = min(320 / w, 220 / h)
    im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (360, 260), bg + (255,))
    canvas.alpha_composite(im, ((360 - im.width) // 2, (260 - im.height) // 2))
    canvas.convert("RGB").save(os.path.join(d, "preview-" + name.replace(".png", ".png")))
print("ok")
