from PIL import Image
import os

src = r"D:\.deepseek\resources\icon.png"
out_dir = r"D:\Projects\dsh-chatroom\design\assets"
os.makedirs(out_dir, exist_ok=True)

im = Image.open(src).convert("RGBA")
w, h = im.size
flat = Image.new("RGB", (w, h), (255, 255, 255))
flat.paste(im, (0, 0), im)
px = flat.load()

mask = Image.new("L", (w, h), 0)
mp = mask.load()
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if 0.2126 * r + 0.7152 * g + 0.0722 * b < 130:
            mp[x, y] = 255

bbox = mask.getbbox()
crop = mask.crop(bbox)
mw, mh = crop.size
cp = crop.load()

def make(color):
    img = Image.new("RGBA", (mw, mh), color + (0,))
    p = img.load()
    for y in range(mh):
        for x in range(mw):
            a = cp[x, y]
            if a:
                p[x, y] = color + (a,)
    return img

black = make((0, 0, 0))
white = make((255, 255, 255))
black.save(os.path.join(out_dir, "whale-black.png"))
white.save(os.path.join(out_dir, "whale-white.png"))
black.resize((mw // 2, mh // 2), Image.LANCZOS).save(os.path.join(out_dir, "whale-black-half.png"))

print("bbox", bbox, "size", (mw, mh))
for f in ("whale-black.png", "whale-white.png", "whale-black-half.png"):
    print(f, os.path.getsize(os.path.join(out_dir, f)))
