from PIL import Image, ImageDraw
import os

os.makedirs(r"D:\DeepSeek\aplikasi\build", exist_ok=True)
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded square background with gradient-ish layers
def rounded(box, radius, fill):
    d.rounded_rectangle(box, radius=radius, fill=fill)

rounded((32, 32, S - 32, S - 32), 200, (43, 92, 255, 255))
rounded((92, 92, S - 92, S - 92), 160, (15, 17, 21, 255))

# chat bubble
bubble = (250, 270, 774, 640)
rounded(bubble, 90, (230, 236, 255, 255))
tail = [(400, 620), (330, 740), (500, 640)]
d.polygon(tail, fill=(230, 236, 255, 255))

# three dots
for i, cx in enumerate((370, 512, 654)):
    d.ellipse((cx - 42, 425, cx + 42, 509), fill=(43, 92, 255, 255))

# cursor arrow (agent control)
arrow = [(640, 560), (640, 850), (710, 782), (760, 900), (812, 878), (762, 762), (856, 762)]
d.polygon(arrow, fill=(255, 255, 255, 255))
d.polygon(arrow, outline=(15, 17, 21, 255))

img.save(r"D:\DeepSeek\aplikasi\build\icon.png")
img.resize((256, 256), Image.LANCZOS).save(
    r"D:\DeepSeek\aplikasi\build\icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icon written")
