from PIL import Image, ImageDraw, ImageFont

SRC = "public/icons/icon-512.png"
OUT = "public/icons"
CHARCOAL = (26, 22, 20, 255)
GOLD = (201, 162, 39, 255)
INK_ON_GOLD = (26, 22, 20, 255)
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Black.ttf"

crest = Image.open(SRC).convert("RGBA")

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size-1, size-1], radius=radius, fill=255)
    return m

def build(size, maskable=False):
    S = 512
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # full-bleed charcoal; OS applies the shape mask
        d.rectangle([0, 0, S, S], fill=CHARCOAL)
        crest_w = 250          # keep inside the ~80% safe zone
        crest_cy = 232
        band_top = 360
    else:
        margin = 6
        d.rounded_rectangle([margin, margin, S-1-margin, S-1-margin], radius=104, fill=CHARCOAL)
        d.rounded_rectangle([margin+10, margin+10, S-1-margin-10, S-1-margin-10],
                            radius=94, outline=GOLD, width=6)
        crest_w = 300
        crest_cy = 210
        band_top = 350

    # crest
    ratio = crest_w / crest.width
    c = crest.resize((crest_w, int(crest.height * ratio)), Image.LANCZOS)
    img.paste(c, (S//2 - c.width//2, crest_cy - c.height//2), c)

    # ADMIN band
    band_h = 96
    bx0, bx1 = (0, S) if maskable else (margin+18, S-margin-18)
    d.rounded_rectangle([bx0, band_top, bx1, band_top + band_h],
                        radius=0 if maskable else band_h//2, fill=GOLD)
    txt = "ADMIN"
    fs = 60
    font = ImageFont.truetype(FONT_PATH, fs)
    # manual letter-spacing
    tracking = 10
    widths = [d.textbbox((0,0), ch, font=font)[2] for ch in txt]
    total = sum(widths) + tracking * (len(txt) - 1)
    x = S//2 - total//2
    ty = band_top + band_h//2
    for ch, w in zip(txt, widths):
        bb = d.textbbox((0, 0), ch, font=font)
        d.text((x, ty - (bb[3]-bb[1])//2 - bb[1]), ch, font=font, fill=INK_ON_GOLD)
        x += w + tracking

    if not maskable:
        img.putalpha(Image.composite(img.getchannel("A"), Image.new("L",(S,S),0),
                                     rounded_mask(S, 104)))

    if size != S:
        img = img.resize((size, size), Image.LANCZOS)
    return img

build(512).save(f"{OUT}/admin-icon-512.png")
build(192).save(f"{OUT}/admin-icon-192.png")
build(512, maskable=True).save(f"{OUT}/admin-icon-512-maskable.png")

# apple-touch: opaque, no transparency, 180
at = build(512).convert("RGBA")
bg = Image.new("RGBA", at.size, CHARCOAL)
bg.paste(at, (0, 0), at)
bg.convert("RGB").resize((180, 180), Image.LANCZOS).save(f"{OUT}/admin-apple-touch-icon.png")

print("done")
