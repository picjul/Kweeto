"""Synthetic scenes with ground truth: the images of the one-click demo project (demo.py) and of the learning
benchmark (bench/simulate.py, which knows the ground truth).

Made to stress exactly what matters for proposals:
- piles: 2-4 objects of the SAME class touching each other (one proposal per object, not one per pile);
- broken objects: a pipe interrupted by a gap (one proposal for the whole pipe, not one per piece);
- look-alike classes side by side (tomato vs lime) and plain isolated objects.

Every object carries flags (`touching`, `broken`) so the benchmark can report those cases separately.
Coordinates are normalised 0..1 (x, y, w, h).
"""
from __future__ import annotations

import io
import math
import random
from dataclasses import dataclass, field

from PIL import Image, ImageDraw, ImageFilter

CLASSES = ("tomato", "lime", "pipe")
COLORS = {"tomato": (196, 42, 36), "lime": (92, 168, 52), "pipe": (88, 108, 150)}


@dataclass
class Obj:
    cls: str
    box: tuple[float, float, float, float]
    touching: bool = False
    broken: bool = False


@dataclass
class Scene:
    name: str
    image: Image.Image
    objects: list[Obj] = field(default_factory=list)

    def png(self) -> bytes:
        buf = io.BytesIO()
        self.image.save(buf, "PNG")
        return buf.getvalue()


def _background(rng: random.Random, W: int, H: int) -> Image.Image:
    base = rng.choice([(214, 208, 198), (205, 207, 210), (222, 216, 204)])
    img = Image.new("RGB", (W, H), base)
    d = ImageDraw.Draw(img)
    for _ in range(W // 6):  # faint grain, well below the foreground threshold
        y = rng.randint(0, H)
        shade = rng.randint(-6, 6)
        d.line([(0, y), (W, y + rng.randint(-H // 8, H // 8))],
               fill=tuple(max(0, min(255, c + shade)) for c in base), width=rng.randint(1, 3))
    return img.filter(ImageFilter.GaussianBlur(0.6))


def _shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c)


def _fruit(d: ImageDraw.ImageDraw, cls: str, cx: float, cy: float, r: float, rng: random.Random) -> None:
    col = _shade(COLORS[cls], rng.uniform(0.9, 1.1))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col, outline=_shade(col, 0.7), width=max(1, int(r / 10)))
    hr = r * 0.32
    d.ellipse([cx - r * 0.45 - hr, cy - r * 0.45 - hr, cx - r * 0.45 + hr, cy - r * 0.45 + hr],
              fill=_shade(col, 1.35))  # highlight
    if cls == "tomato":
        d.polygon([(cx, cy - r * 0.95), (cx - r * 0.25, cy - r * 0.7), (cx + r * 0.25, cy - r * 0.7)], fill=(60, 120, 40))


def _box(cx, cy, r, W, H):
    return ((cx - r) / W, (cy - r) / H, 2 * r / W, 2 * r / H)


def _free(box, taken, margin=0.02) -> bool:
    x, y, w, h = box
    if x < 0.01 or y < 0.01 or x + w > 0.99 or y + h > 0.99:
        return False
    for tx, ty, tw, th in taken:
        if x < tx + tw + margin and tx < x + w + margin and y < ty + th + margin and ty < y + h + margin:
            return False
    return True


def _place_pile(d, rng, W, H, cls, n, taken, objs) -> None:
    r = rng.uniform(0.065, 0.085) * W
    for _ in range(60):
        cx, cy = rng.uniform(r, W - r * (2 * n + 1)), rng.uniform(r * 2, H - r * 2)
        ang = rng.uniform(-0.5, 0.5)
        centres = [(cx + k * 1.9 * r * math.cos(ang), cy + k * 1.9 * r * math.sin(ang)) for k in range(n)]
        if n >= 3 and rng.random() < 0.5:  # compact cluster instead of a row: every item touches another
            ca, sa = math.cos(ang), math.sin(ang)
            offs = [(0, 0), (1.9, 0), (0.95, 1.65), (2.85, 1.65)][:n]
            centres = [(cx + (u * ca - v * sa) * r, cy + (u * sa + v * ca) * r) for u, v in offs]
        boxes = [_box(x, y, r, W, H) for x, y in centres]
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        hull = (x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0)
        if _free(hull, taken):
            taken.append(hull)
            for (x, y), b in zip(centres, boxes):
                _fruit(d, cls, x, y, r, rng)
                objs.append(Obj(cls, b, touching=n > 1))
            return


def _place_single(d, rng, W, H, cls, taken, objs) -> None:
    r = rng.uniform(0.06, 0.09) * W * (0.85 if cls == "lime" else 1.0)
    for _ in range(60):
        cx, cy = rng.uniform(r, W - r), rng.uniform(r, H - r)
        b = _box(cx, cy, r, W, H)
        if _free(b, taken):
            taken.append(b)
            _fruit(d, cls, cx, cy, r, rng)
            objs.append(Obj(cls, b))
            return


def _place_pipe(img, bg, rng, W, H, taken, objs, broken: bool) -> None:
    d = ImageDraw.Draw(img)
    for _ in range(60):
        L, T = rng.uniform(0.38, 0.55) * W, rng.uniform(0.05, 0.075) * W
        x0, y0 = rng.uniform(0.02 * W, W - L - 0.02 * W), rng.uniform(0.05 * H, H - T - 0.05 * H)
        b = (x0 / W, y0 / H, L / W, T / H)
        if not _free(b, taken):
            continue
        taken.append(b)
        col = _shade(COLORS["pipe"], rng.uniform(0.9, 1.1))
        d.rounded_rectangle([x0, y0, x0 + L, y0 + T], radius=T / 3, fill=col, outline=_shade(col, 0.6), width=2)
        d.rectangle([x0 + T * 0.4, y0 + T * 0.2, x0 + L - T * 0.4, y0 + T * 0.38], fill=_shade(col, 1.3))
        if broken:  # something thin and background-coloured hides the middle: two separate pieces
            gx = x0 + L * rng.uniform(0.35, 0.6)
            gw = rng.uniform(0.04, 0.08) * L
            box = (int(gx), int(y0 - 3), int(gx + gw), int(y0 + T + 4))
            img.paste(bg.crop(box), box[:2])
        objs.append(Obj("pipe", b, broken=broken))
        return


def make_scene(seed: int, W: int = 320, H: int = 240) -> Scene:
    rng = random.Random(seed)
    img = _background(rng, W, H)
    bg = img.copy()
    d = ImageDraw.Draw(img)
    taken: list[tuple] = []
    objs: list[Obj] = []
    kind = rng.choices(["pile", "mixed", "pipe"], weights=[0.4, 0.25, 0.35])[0]
    if kind == "pile":
        _place_pile(d, rng, W, H, "tomato", rng.randint(2, 4), taken, objs)
        if rng.random() < 0.6:
            _place_single(d, rng, W, H, "lime", taken, objs)
    elif kind == "mixed":
        for _ in range(rng.randint(1, 2)):
            _place_single(d, rng, W, H, "tomato", taken, objs)
        if rng.random() < 0.5:
            _place_pile(d, rng, W, H, "lime", 2, taken, objs)
        else:
            _place_single(d, rng, W, H, "lime", taken, objs)
    else:
        _place_pipe(img, bg, rng, W, H, taken, objs, broken=rng.random() < 0.7)
        d = ImageDraw.Draw(img)
        _place_single(d, rng, W, H, rng.choice(["tomato", "lime"]), taken, objs)
    return Scene(name=f"scene_{seed:04d}.png", image=img, objects=objs)
