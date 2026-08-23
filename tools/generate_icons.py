#!/usr/bin/env python3
"""Генератор іконок для PWA "Облік ЗІП: Механік".

Запуск:  python3 tools/generate_icons.py
Потрібен Pillow:  pip install pillow

Малює шестерню (символ ЗІП / механіки) на смарагдовому фоні —
кольори збігаються з темою застосунку (--active-btn-bg: #10b981).
"""

import math
import os

from PIL import Image, ImageDraw

SS = 8  # supersampling для згладжування
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

GREEN_TOP = (16, 185, 129)     # #10b981
GREEN_BOTTOM = (5, 122, 85)    # темніший смарагд для градієнта
WHITE = (255, 255, 255, 255)
TRANSPARENT = (255, 255, 255, 0)


def gradient_bg(size, radius_ratio):
    """Фон: вертикальний градієнт зі скругленими кутами."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(round(GREEN_TOP[i] + (GREEN_BOTTOM[i] - GREEN_TOP[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = color + (255,)

    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    radius = round(size * radius_ratio)
    if radius > 0:
        md.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    else:
        md.rectangle([0, 0, size - 1, size - 1], fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def gear_layer(size, outer_ratio, teeth=8):
    """Прозорий шар із білою шестернею по центру."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cx = cy = size / 2
    r_out = size * outer_ratio / 2          # вершини зубців
    r_body = r_out * 0.76                   # тіло шестерні
    r_hole = r_out * 0.34                   # центральний отвір
    half_tooth = math.pi / teeth * 0.30     # півширина зубця у радіанах

    for i in range(teeth):
        a = 2 * math.pi * i / teeth
        pts = []
        for sign, r in ((-1, r_body * 0.98), (1, r_body * 0.98)):
            ang = a + sign * half_tooth * 1.55
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
        for sign, r in ((1, r_out), (-1, r_out)):
            ang = a + sign * half_tooth
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
        d.polygon(pts, fill=WHITE)

    d.ellipse([cx - r_body, cy - r_body, cx + r_body, cy + r_body], fill=WHITE)
    d.ellipse([cx - r_hole, cy - r_hole, cx + r_hole, cy + r_hole], fill=TRANSPARENT)
    return layer


def build(size, *, gear_ratio, radius_ratio, opaque=False):
    big = size * SS
    bg = gradient_bg(big, radius_ratio)
    icon = Image.alpha_composite(bg, gear_layer(big, gear_ratio))
    icon = icon.resize((size, size), Image.LANCZOS)
    if opaque:
        flat = Image.new("RGB", (size, size), GREEN_TOP)
        flat.paste(icon, (0, 0), icon)
        return flat
    return icon


def save(img, name):
    path = os.path.join(OUT_DIR, name)
    img.save(path, "PNG", optimize=True)
    print(f"  {name:<28} {os.path.getsize(path):>6} B")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("Генерую іконки:")

    # purpose: any — зі скругленими кутами, іконка займає майже все полотно
    for s in (192, 512):
        save(build(s, gear_ratio=0.66, radius_ratio=0.22), f"icon-{s}.png")

    # purpose: maskable — фон на весь квадрат, малюнок у безпечній зоні (80%)
    for s in (192, 512):
        save(build(s, gear_ratio=0.50, radius_ratio=0.0), f"icon-maskable-{s}.png")

    # iOS: без прозорості, систему сама скруглює кути
    save(build(180, gear_ratio=0.60, radius_ratio=0.0, opaque=True), "apple-touch-icon-180.png")

    # favicon
    for s in (32, 16):
        save(build(s, gear_ratio=0.78, radius_ratio=0.15), f"favicon-{s}.png")


if __name__ == "__main__":
    main()
