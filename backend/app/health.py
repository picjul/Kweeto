"""Dataset health: class balance, near-duplicate images, and boxes that look mislabelled.

Every finding is a plain fact Pixel can show you, never a guess dressed up as a score:
- looks_like: leave-one-out on your own boxes. Among the boxes most similar to this one (cosine of the same
  embeddings Pixel learns from), N of another class come before the first one of its own class.
  "This box is 'bolt', but 12 'nut' look more like it than any other 'bolt'."
- size:       a box far bigger or smaller than the typical box of its class (robust z-score of log area).
- double:     two boxes of the same class on the same object (IoU >= 0.85); conflict: two classes on it.
- tiny:       a box a few pixels wide (a slip of the mouse?).
- duplicates: images that are almost pixel-identical (same shot resized, recompressed or lightly edited):
  a difference hash of the thumbnail picks the candidates, a 32x32 pixel comparison confirms them.
Findings you mark as right are remembered (`health_dismissals`) and not shown again.
"""
from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import engine as eng
from . import pixel, services, workspace
from .models import Box, HealthDismissal, ImageItem, LabelClass, Region, Verification

K_NEIGHBOURS = 30
SIZE_FACTOR = 8.0       # at least 8x bigger / smaller than the class median area...
SIZE_Z = 3.5            # ... and a robust z-score this far out
SIZE_MIN_BOXES = 8
DOUBLE_IOU = 0.85
TINY_PX = 3
DHASH_MAX = 6           # of 64 bits: candidates for near-duplicates
PIXEL_MAD_MAX = 4.0     # mean absolute difference (0-255) of the 32x32 grey thumbnails: confirmed
MAX_DUP_IMAGES = 20000
MAX_SUSPECTS = 200

_thumb_cache: dict[str, tuple[int, np.ndarray]] = {}


def _image_out(img: ImageItem) -> dict:
    return {"id": img.id, "filename": img.filename, "url": f"/files/images/{img.stored_name}",
            "thumb_url": f"/files/thumbs/{img.thumb_name}", "width": img.width, "height": img.height,
            "status": img.status}


def _box_ref(b, imgs: dict) -> dict:
    bid, iid, cid, x, y, w, h = b
    return {"box_id": bid, "class_id": cid, "x": x, "y": y, "w": w, "h": h, "image": _image_out(imgs[iid])}


# ---------- look-alikes (leave-one-out on your boxes) ----------

def _look_alikes(db: Session, boxes: dict, imgs: dict, names: dict) -> list[dict]:
    region_box = dict(db.execute(select(Region.id, Region.box_id).where(Region.kind == "box")).all())
    st = eng.store
    with st.lock:
        n = st.n
        rows = np.nonzero(st.active[:n] & (st.kind[:n] == eng.KIND_BOX))[0]
        rids = st.region_id[rows].copy()
        vecs = st.vec[rows].copy()
    keep = [i for i, r in enumerate(rids) if region_box.get(int(r)) in boxes]
    if len(keep) < 6:
        return []
    bids = [region_box[int(rids[i])] for i in keep]
    V = vecs[keep]
    labels = np.array([boxes[b][2] for b in bids])
    per_class = Counter(labels.tolist())
    if len(per_class) < 2:
        return []
    sims, idx = eng.topk_ip(V, V, min(len(bids), K_NEIGHBOURS + 1))
    out = []
    for i, bid in enumerate(bids):
        c = int(labels[i])
        if per_class[c] < 3:  # too few other examples of its own class to judge it
            continue
        nb = [(int(j), float(s)) for j, s in zip(idx[i], sims[i]) if int(j) != i and j >= 0]
        first_own = next((t for t, (j, _s) in enumerate(nb) if labels[j] == c), None)
        before = nb[:first_own] if first_own is not None else nb
        if not before:
            continue
        other, hits = Counter(int(labels[j]) for j, _s in before).most_common(1)[0]
        need = min(5, max(3, per_class[other] // 3))
        if hits < need or int(labels[before[0][0]]) != other:
            continue
        like = [_box_ref(boxes[bids[j]], imgs) for j, _s in before if labels[j] == other][:4]
        own = _box_ref(boxes[bids[nb[first_own][0]]], imgs) if first_own is not None else None
        at_least = first_own is None
        out.append({"key": f"like:{bid}:{c}", "kind": "looks_like", **_box_ref(boxes[bid], imgs),
                    "suggest_class_id": other, "count": hits, "at_least": at_least, "like": like, "own": own,
                    "rank": (3, hits, before[0][1]),
                    "text": pixel.health_looks_like(names[c], names[other], hits, at_least, len(before))})
    return out


# ---------- sizes, doubles, slips ----------

def _sizes(boxes: dict, imgs: dict, names: dict) -> list[dict]:
    by_class: dict[int, list] = defaultdict(list)
    for b in boxes.values():
        by_class[b[2]].append(b)
    out = []
    for c, bs in by_class.items():
        if len(bs) < SIZE_MIN_BOXES:
            continue
        la = np.log(np.array([max(1e-6, b[5] * b[6]) for b in bs]))
        med = float(np.median(la))
        mad = float(np.median(np.abs(la - med))) * 1.4826
        if mad < 1e-6:
            continue
        for b, v in zip(bs, la):
            factor = float(np.exp(v - med))
            z = abs(v - med) / mad
            if z >= SIZE_Z and (factor >= SIZE_FACTOR or factor <= 1 / SIZE_FACTOR):
                bigger = factor > 1
                times = factor if bigger else 1 / factor
                out.append({"key": f"size:{b[0]}", "kind": "size", **_box_ref(b, imgs), "factor": round(times, 1),
                            "bigger": bigger, "rank": (2, times, 0),
                            "text": pixel.health_size(names[c], times, bigger)})
    return out


def _doubles_and_slips(boxes: dict, imgs: dict, names: dict) -> list[dict]:
    by_img: dict[int, list] = defaultdict(list)
    for b in boxes.values():
        by_img[b[1]].append(b)
    out = []
    for iid, bs in by_img.items():
        img = imgs[iid]
        for b in bs:
            if b[5] * img.width < TINY_PX or b[6] * img.height < TINY_PX:
                px = (max(1, round(b[5] * img.width)), max(1, round(b[6] * img.height)))
                out.append({"key": f"tiny:{b[0]}", "kind": "tiny", **_box_ref(b, imgs), "pixels": px,
                            "rank": (1, 0, 0), "text": pixel.health_tiny(names[b[2]], *px)})
        bs = sorted(bs)
        for i, a in enumerate(bs):
            for b in bs[i + 1:]:
                if eng.iou(a[3:], b[3:]) < DOUBLE_IOU:
                    continue
                same = a[2] == b[2]
                out.append({"key": f"{'double' if same else 'conflict'}:{a[0]}:{b[0]}",
                            "kind": "double" if same else "conflict", **_box_ref(b, imgs),
                            "other": _box_ref(a, imgs), "rank": (4 if not same else 3, 0, 0),
                            "text": pixel.health_double(names[a[2]]) if same
                            else pixel.health_conflict(names[a[2]], names[b[2]])})
    return out


# ---------- near-duplicate images ----------

def _thumb_sig(img: ImageItem) -> tuple[int, np.ndarray] | None:
    hit = _thumb_cache.get(img.stored_name)
    if hit is not None:
        return hit
    try:
        with Image.open(workspace.thumbs_dir() / img.thumb_name) as im:
            g = im.convert("L")
            d = np.asarray(g.resize((9, 8), Image.BILINEAR), np.int16)
            small = np.asarray(g.resize((32, 32), Image.BILINEAR), np.uint8)
    except Exception:
        return None
    bits = (d[:, 1:] > d[:, :-1]).flatten()
    h = int.from_bytes(np.packbits(bits).tobytes(), "big")
    _thumb_cache[img.stored_name] = (h, small)
    return h, small


_POP = np.array([bin(i).count("1") for i in range(256)], np.uint8)


def near_duplicates(imgs: list[ImageItem], dismissed: set[str]) -> tuple[list[list[int]], bool]:
    """Groups of almost pixel-identical images (ids), and whether the project was too big to compare."""
    if len(imgs) > MAX_DUP_IMAGES:
        return [], True
    sigs = [(i, _thumb_sig(i)) for i in imgs]
    sigs = [(i.id, s) for i, s in sigs if s is not None]
    if len(sigs) < 2:
        return [], False
    ids = np.array([i for i, _ in sigs])
    hashes = np.array([s[0] for _, s in sigs], np.uint64)
    small = np.stack([s[1] for _, s in sigs]).astype(np.int16)
    parent = {int(i): int(i) for i in ids}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for s in range(0, len(ids), 256):
        x = hashes[s:s + 256, None] ^ hashes[None, :]
        dist = _POP[x.view(np.uint8)].reshape(x.shape[0], x.shape[1], 8).sum(axis=2)
        for r, c in zip(*np.nonzero(dist <= DHASH_MAX)):
            a, b = s + int(r), int(c)
            if b <= a:
                continue
            if float(np.abs(small[a] - small[b]).mean()) > PIXEL_MAD_MAX:
                continue
            ia, ib = int(ids[a]), int(ids[b])
            if f"dup:{ia}:{ib}" in dismissed:
                continue
            parent[find(ib)] = find(ia)
    groups: dict[int, list[int]] = defaultdict(list)
    for i in ids:
        groups[find(int(i))].append(int(i))
    return sorted((sorted(g) for g in groups.values() if len(g) > 1), key=lambda g: (-len(g), g[0])), False


# ---------- the report ----------

def report(db: Session) -> dict:
    imgs = {i.id: i for i in db.scalars(select(ImageItem).order_by(ImageItem.id))}
    classes = list(db.scalars(select(LabelClass).order_by(LabelClass.id)))
    names = {c.id: c.name for c in classes}
    boxes = {b[0]: tuple(b) for b in db.execute(
        select(Box.id, Box.image_id, Box.class_id, Box.x, Box.y, Box.w, Box.h)).all() if b[1] in imgs}
    verified = set(db.scalars(select(Verification.image_id)))
    dismissed = set(db.scalars(select(HealthDismissal.key)))

    # classes
    n_boxes, n_imgs = Counter(), defaultdict(set)
    for b in boxes.values():
        n_boxes[b[2]] += 1
        n_imgs[b[2]].add(b[1])
    cls = [{"id": c.id, "name": c.name, "color": c.color, "boxes": n_boxes[c.id], "images": len(n_imgs[c.id])}
           for c in classes]
    with_boxes = [c for c in cls if c["boxes"]]
    balance = None
    if len(with_boxes) >= 2:
        most = max(with_boxes, key=lambda c: c["boxes"])
        least = min(with_boxes, key=lambda c: c["boxes"])
        ratio = most["boxes"] / max(1, least["boxes"])
        balance = {"most": most["id"], "least": least["id"], "ratio": round(ratio, 1), "skewed": ratio >= 5,
                   "text": pixel.health_balance(most["name"], most["boxes"], least["name"], least["boxes"])}
    never = [c["name"] for c in cls if not c["boxes"]]

    # images
    boxed = {b[1] for b in boxes.values()}
    unfinished = sorted(boxed - verified)
    counts = Counter(i.status for i in imgs.values())
    images = {"total": len(imgs), "finished": len(verified & set(imgs)), "unfinished": len(unfinished),
              "unfinished_ids": unfinished[:500], "to_teach": counts.get("embedded", 0),
              "pending": counts.get("pending", 0), "errors": counts.get("error", 0)}

    # suspicious boxes
    found = _look_alikes(db, boxes, imgs, names) + _sizes(boxes, imgs, names) + _doubles_and_slips(boxes, imgs, names)
    seen: set[str] = set()
    suspects = []
    for f in sorted(found, key=lambda f: f.pop("rank"), reverse=True):
        if f["key"] in dismissed or f["key"] in seen:
            continue
        seen.add(f["key"])
        suspects.append(f)
    by_kind = Counter(f["kind"] for f in suspects)

    groups, too_many = near_duplicates(list(imgs.values()), dismissed)
    box_count = Counter(b[1] for b in boxes.values())
    dup = [[{**_image_out(imgs[i]), "box_count": box_count.get(i, 0), "verified": i in verified} for i in g]
           for g in groups[:50]]

    out = {"classes": cls, "balance": balance, "never_taught": never, "images": images,
           "suspects": suspects[:MAX_SUSPECTS], "suspect_counts": dict(by_kind), "suspects_total": len(suspects),
           "duplicates": dup, "duplicate_groups": len(groups), "duplicates_skipped": too_many,
           "dismissed": len(dismissed), "boxes": len(boxes)}
    out["pixel_message"] = pixel.health_summary(out)
    return out


def dismiss(db: Session, key: str) -> None:
    if db.get(HealthDismissal, key) is None:
        db.add(HealthDismissal(key=key))
        db.commit()


def restore(db: Session) -> int:
    n = db.query(HealthDismissal).delete()
    db.commit()
    return n


def relabel(db: Session, box_id: int, class_id: int) -> dict:
    """Changes the class of one of your boxes: a correction Pixel learns from (it re-learns at once)."""
    from .models import Event

    b = db.get(Box, box_id)
    if b is None:
        raise KeyError(box_id)
    to, frm = db.get(LabelClass, class_id), db.get(LabelClass, b.class_id)
    if to is None:
        raise ValueError(f"Class {class_id} does not exist")
    if b.class_id == class_id:
        return {"delta_count": 0, "message": "Nothing to change."}
    ev = Event(type="correct", image_id=b.image_id, class_id=class_id, from_class_id=b.class_id,
               payload={"source": "health", "box_id": b.id})
    b.class_id = class_id
    db.add(ev)
    db.commit()
    delta = services.recompute(db, ev.id)
    return {"delta_count": delta, "message": pixel.after_save("correct", delta, to.name, frm.name if frm else "?")}


def delete_box(db: Session, box_id: int) -> dict:
    """Removes one of your boxes (and what Pixel learned from it)."""
    b = db.get(Box, box_id)
    if b is None:
        raise KeyError(box_id)
    rids = list(db.scalars(select(Region.id).where(Region.box_id == box_id)))
    for r in db.scalars(select(Region).where(Region.box_id == box_id)):
        db.delete(r)
    image_id = b.image_id
    db.delete(b)
    db.flush()
    img = db.get(ImageItem, image_id)
    left = db.scalar(select(Box.id).where(Box.image_id == image_id).limit(1))
    if img is not None and left is None and img.status == "annotated" and db.get(Verification, image_id) is None:
        img.status = "embedded"
    db.commit()
    eng.store.remove(rids)
    delta = services.recompute(db)
    return {"delta_count": delta, "message": "Box removed: I forgot what it taught me."
            + (f" I changed my mind on {delta} images." if delta else "")}
