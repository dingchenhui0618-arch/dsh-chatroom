from PIL import Image
src = r"D:\.deepseek\resources\icon.png"
im = Image.open(src).convert("RGB")
w, h = im.size
px = im.load()
cols = [0] * w
rows = [0] * h
cnt = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if 0.2126 * r + 0.7152 * g + 0.0722 * b < 120:
            cols[x] += 1
            rows[y] += 1
            cnt += 1
print("dark px", cnt, "of", w * h)
print("first cols with >5:", [i for i, v in enumerate(cols) if v > 5][:5])
print("last cols with >5:", [i for i, v in enumerate(cols) if v > 5][-5:])
print("first rows with >5:", [i for i, v in enumerate(rows) if v > 5][:5])
print("last rows with >5:", [i for i, v in enumerate(rows) if v > 5][-5:])
print("corner colors", px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1])
print("edge row max", max(rows[:20]), max(rows[-20:]))
