"""
Generate a bubble-gel blue texture for the popup frame ring.
Output: assets/design/Textures/frame-texture.png (380x600, RGBA)
"""
import random
from PIL import Image, ImageChops, ImageDraw, ImageFilter

W, H = 380, 600
SCALE = 2          # render at 2x, downsample for anti-aliasing
WW, HH = W * SCALE, H * SCALE

random.seed(42)

img = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)


def add_vertical_gradient(layer, top_rgb, bottom_rgb):
    painter = ImageDraw.Draw(layer)
    for y in range(HH):
        t = y / (HH - 1)
        color = tuple(int(top_rgb[i] + (bottom_rgb[i] - top_rgb[i]) * t) for i in range(3))
        painter.line([(0, y), (WW, y)], fill=(*color, 255))


def add_top_sheen(layer, height_ratio, alpha_top, alpha_bottom):
    painter = ImageDraw.Draw(layer)
    cap_h = int(HH * height_ratio)
    for y in range(cap_h):
        t = y / max(cap_h - 1, 1)
        alpha = int(alpha_top + (alpha_bottom - alpha_top) * (t ** 1.8))
        painter.line([(0, y), (WW, y)], fill=(255, 255, 255, alpha))


def draw_bubble_group(layer, center, radius, alpha_scale=1.0):
    cx, cy = center
    left = cx - radius
    top = cy - radius
    size = radius * 2

    bubble = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bubble_draw = ImageDraw.Draw(bubble)

    # Outer glass rim.
    bubble_draw.ellipse((0, 0, size - 1, size - 1), fill=(188, 225, 255, int(84 * alpha_scale)))
    inset = max(3, radius // 6)
    bubble_draw.ellipse(
        (inset, inset, size - inset - 1, size - inset - 1),
        fill=(110, 170, 232, int(28 * alpha_scale))
    )

    # Bright crescent highlight.
    crescent = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    crescent_draw = ImageDraw.Draw(crescent)
    crescent_draw.ellipse(
        (radius * 0.08, radius * 0.04, size - radius * 0.36, size - radius * 0.34),
        fill=(255, 255, 255, int(90 * alpha_scale))
    )
    crescent_draw.ellipse(
        (radius * 0.32, radius * 0.28, size - radius * 0.10, size - radius * 0.12),
        fill=(0, 0, 0, 0)
    )
    crescent = crescent.filter(ImageFilter.GaussianBlur(radius=max(2, radius // 10)))
    bubble.alpha_composite(crescent)

    # Small specular dot.
    dot_r = max(4, radius // 6)
    dot_box = (radius * 0.38, radius * 0.30, radius * 0.38 + dot_r * 2, radius * 0.30 + dot_r * 2)
    bubble_draw.ellipse(dot_box, fill=(255, 255, 255, int(170 * alpha_scale)))

    # Lower-right shadow for depth.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.ellipse(
        (radius * 0.24, radius * 0.26, size - radius * 0.08, size - radius * 0.10),
        fill=(28, 72, 138, int(44 * alpha_scale))
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(3, radius // 8)))
    bubble.alpha_composite(shadow)

    bubble = bubble.filter(ImageFilter.GaussianBlur(radius=max(1, radius // 18)))
    layer.alpha_composite(bubble, (int(left), int(top)))


def scatter_micro_bubbles(layer, count):
    bubble_draw = ImageDraw.Draw(layer)
    for _ in range(count):
        radius = random.randint(2, 7)
        x = random.randint(0, WW - 1)
        y = random.randint(0, HH - 1)
        alpha = random.randint(35, 90)
        bubble_draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(220, 244, 255, alpha))
        highlight_r = max(1, radius // 3)
        bubble_draw.ellipse(
            (x - radius * 0.35, y - radius * 0.45, x - radius * 0.35 + highlight_r * 2, y - radius * 0.45 + highlight_r * 2),
            fill=(255, 255, 255, min(180, alpha + 50))
        )


def scatter_micro_bubbles_in_region(layer, count, x0, y0, x1, y1, min_r=2, max_r=7, alpha_min=35, alpha_max=90):
    bubble_draw = ImageDraw.Draw(layer)
    for _ in range(count):
        radius = random.randint(min_r, max_r)
        x = random.randint(x0, x1)
        y = random.randint(y0, y1)
        alpha = random.randint(alpha_min, alpha_max)
        bubble_draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(220, 244, 255, alpha))
        highlight_r = max(1, radius // 3)
        bubble_draw.ellipse(
            (x - radius * 0.35, y - radius * 0.45, x - radius * 0.35 + highlight_r * 2, y - radius * 0.45 + highlight_r * 2),
            fill=(255, 255, 255, min(180, alpha + 50))
        )


# ── Base gel field ─────────────────────────────────────────────────────────
base = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
add_vertical_gradient(base, (186, 222, 255), (84, 152, 228))
img.alpha_composite(base)

# ── Top gloss and cool edge darkening ──────────────────────────────────────
sheen = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
add_top_sheen(sheen, 0.24, 150, 0)
img.alpha_composite(sheen)

edge_shadow = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
es = ImageDraw.Draw(edge_shadow)
for x in range(int(WW * 0.08)):
    t = x / max(int(WW * 0.08) - 1, 1)
    alpha = int((1 - t) * 48)
    es.line([(x, 0), (x, HH)], fill=(48, 96, 164, alpha))
    es.line([(WW - 1 - x, 0), (WW - 1 - x, HH)], fill=(48, 96, 164, alpha))
edge_shadow = edge_shadow.filter(ImageFilter.GaussianBlur(radius=8))
img.alpha_composite(edge_shadow)

# ── Bubble field ───────────────────────────────────────────────────────────
bubbles = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))

major_bubbles = [
    (0.09, 0.17, 44, 0.92),
    (0.19, 0.06, 22, 0.82),
    (0.31, 0.03, 30, 0.76),
    (0.52, 0.04, 12, 0.64),
    (0.69, 0.09, 14, 0.70),
    (0.83, 0.06, 18, 0.72),
    (0.93, 0.08, 48, 0.94),
    (0.94, 0.20, 24, 0.80),
    (0.90, 0.31, 18, 0.72),
    (0.06, 0.79, 10, 0.60),
    (0.03, 0.93, 48, 0.96),
    (0.21, 0.91, 18, 0.78),
    (0.80, 0.92, 12, 0.60),
    (0.92, 0.92, 20, 0.74),
    (0.98, 0.95, 54, 0.98),
]

for x_ratio, y_ratio, radius, alpha_scale in major_bubbles:
    draw_bubble_group(
        bubbles,
        (int(WW * x_ratio), int(HH * y_ratio)),
        radius,
        alpha_scale=alpha_scale,
    )

cluster_offsets = {
    (0.89, 0.10): [(-24, 18, 20), (-4, 32, 16), (22, 18, 18), (18, -10, 14), (-18, -8, 12)],
    (0.12, 0.88): [(-18, -22, 18), (10, -10, 15), (26, 10, 13), (0, 22, 10)],
}

for (x_ratio, y_ratio), offsets in cluster_offsets.items():
    base_x = int(WW * x_ratio)
    base_y = int(HH * y_ratio)
    for dx, dy, radius in offsets:
        draw_bubble_group(bubbles, (base_x + dx, base_y + dy), radius, alpha_scale=0.72)

# Tiny bubbles hug the perimeter bands, with the center kept much cleaner.
scatter_micro_bubbles_in_region(bubbles, 120, 0, 0, WW - 1, int(HH * 0.17), min_r=2, max_r=5, alpha_min=26, alpha_max=72)
scatter_micro_bubbles_in_region(bubbles, 80, 0, int(HH * 0.82), WW - 1, HH - 1, min_r=2, max_r=5, alpha_min=26, alpha_max=72)
scatter_micro_bubbles_in_region(bubbles, 55, 0, 0, int(WW * 0.10), HH - 1, min_r=2, max_r=5, alpha_min=26, alpha_max=68)
scatter_micro_bubbles_in_region(bubbles, 55, int(WW * 0.90), 0, WW - 1, HH - 1, min_r=2, max_r=5, alpha_min=26, alpha_max=68)
scatter_micro_bubbles_in_region(bubbles, 46, int(WW * 0.74), int(HH * 0.04), WW - 1, int(HH * 0.28), min_r=2, max_r=6, alpha_min=30, alpha_max=76)
scatter_micro_bubbles_in_region(bubbles, 30, int(WW * 0.05), int(HH * 0.12), int(WW * 0.22), int(HH * 0.32), min_r=2, max_r=5, alpha_min=26, alpha_max=70)
scatter_micro_bubbles_in_region(bubbles, 28, int(WW * 0.02), int(HH * 0.84), int(WW * 0.20), HH - 1, min_r=2, max_r=5, alpha_min=26, alpha_max=70)

# A light dusting in the center keeps it alive without fighting the UI.
scatter_micro_bubbles_in_region(bubbles, 65, int(WW * 0.22), int(HH * 0.18), int(WW * 0.78), int(HH * 0.80), min_r=1, max_r=3, alpha_min=14, alpha_max=34)
bubbles = bubbles.filter(ImageFilter.GaussianBlur(radius=1))
img.alpha_composite(bubbles)

# ── Inner glass rim for the frame band itself ──────────────────────────────
rim = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
rim_draw = ImageDraw.Draw(rim)
ring_outer = (12 * SCALE, 12 * SCALE, WW - 12 * SCALE, HH - 12 * SCALE)
rim_draw.rounded_rectangle(ring_outer, radius=22 * SCALE, outline=(255, 255, 255, 108), width=5)
rim_draw.rounded_rectangle(
    (ring_outer[0] + 10, ring_outer[1] + 10, ring_outer[2] - 10, ring_outer[3] - 10),
    radius=18 * SCALE,
    outline=(88, 144, 212, 66),
    width=4,
)
rim = rim.filter(ImageFilter.GaussianBlur(radius=2))
img.alpha_composite(rim)

# ── Subtle grain to prevent flat digital bands ─────────────────────────────
noise = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
pix = noise.load()
for y in range(HH):
    for x in range(WW):
        v = random.randint(210, 255)
        pix[x, y] = (v, v, v, random.randint(0, 8))
noise = noise.filter(ImageFilter.GaussianBlur(radius=0.5))
img.alpha_composite(noise)

# ── Downsample to 1x for crisp output ────────────────────────────────────
out = img.resize((W, H), Image.LANCZOS)

# ── Bake ring mask directly into the PNG alpha ────────────────────────────
# Outer: full 380x600, square corners. Inner cutout: 12px inset, rx=22.
# Pixels inside the inner rounded rect → fully transparent.
# Pixels outside the outer rect → also transparent (already are at edges).
from PIL import ImageDraw as ID2

THICK = 12
INNER_R = 22

ring_mask = Image.new("L", (W, H), 0)
rm = ID2.Draw(ring_mask)
# Draw the full outer rect white
rm.rectangle([(0, 0), (W - 1, H - 1)], fill=255)
# Punch out the inner rounded rect (black = transparent)
rm.rounded_rectangle(
    [(THICK, THICK), (W - THICK - 1, H - THICK - 1)],
    radius=INNER_R,
    fill=0
)

# Apply ring mask to alpha channel
r, g, b, a = out.split()
# Multiply existing alpha by ring mask
new_a = ImageChops.multiply(a, ring_mask)
out = Image.merge("RGBA", (r, g, b, new_a))

import os
os.makedirs("assets/design/Textures", exist_ok=True)
out.save("assets/design/Textures/frame-texture.png")
print(f"Saved assets/design/Textures/frame-texture.png ({W}x{H})")
