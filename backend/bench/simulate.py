"""Learning benchmark: a simulated teacher runs Lessons through the real API and we measure Pixel.

    cd backend
    python -m bench.simulate                                   # synthetic scenes, fake embedder (seconds)
    python -m bench.simulate --profile balanced --size 640x480 --images 40      # real models
    python -m bench.simulate --profile light --coco path/_annotations.coco.json --images-dir path

The teacher behaves like a careful user in the Lesson: accepts correct guesses, fixes the class of
wrong ones, rejects the rest, and draws the boxes Pixel missed. It never sees the held-out images.

Reported, before each teaching step and on the held-out set at checkpoints:
- precision / recall / F1 of the proposals (IoU >= 0.5 and the right class);
- recall on TOUCHING objects (piles) and on BROKEN objects (split by a gap);
- "count ok": images where Pixel proposes exactly as many objects per class as there are;
- teacher effort: boxes drawn by hand vs guesses simply accepted.
This is the yardstick for every change to the engine: if the curves don't go up, it didn't help.

With --detector MODEL a real detector (LibreYOLO) is trained on the finished images after --detector-after
lessons, made the project's active detector, and from then on every held-out checkpoint is measured twice:
with Pixel using the detector's evidence and without (`detector` = on / off in the curve). The teaching
itself uses whatever --set use_detector=... says (default off).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path


def _setup_env(args) -> None:
    os.environ["KWEETO_DATA_DIR"] = tempfile.mkdtemp(prefix="kweeto-bench-")
    if args.profile:  # real models; single fields can still be overridden
        os.environ["KWEETO_PROFILE"] = args.profile
        for env, val in (("KWEETO_EMBEDDER", args.embedder), ("KWEETO_SEGMENTER", args.segmenter)):
            if val:
                os.environ[env] = val
            else:
                os.environ.pop(env, None)
    else:  # default: fake embedder + simple segmenter, seconds and no torch
        os.environ["KWEETO_EMBEDDER"] = args.embedder or "pixels"
        os.environ["KWEETO_SEGMENTER"] = args.segmenter or "simple"
    os.environ["KWEETO_PROPOSER"] = args.proposer
    shared = Path(__file__).resolve().parent.parent / "data" / "libreyolo"
    if args.detector and shared.exists() and not os.getenv("KWEETO_DETECTOR_WEIGHTS"):
        os.environ["KWEETO_DETECTOR_WEIGHTS"] = str(shared)  # no re-download of the pretrained weights
    os.environ["KWEETO_QUEUE_SEED"] = str(args.seed)
    os.environ.setdefault("KWEETO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],testserver")  # TestClient's host


# ---------- ground truth ----------

def synthetic(n: int, size: tuple[int, int], seed: int):
    from .scenes import CLASSES, make_scene

    scenes = [make_scene(seed * 10_000 + i, *size) for i in range(n)]
    files = [(s.name, s.png()) for s in scenes]
    gt = {s.name: [{"cls": o.cls, "box": o.box, "touching": o.touching, "broken": o.broken} for o in s.objects]
          for s in scenes}
    return list(CLASSES), files, gt


def coco(path: str, images_dir: str, n: int, seed: int):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cats = {c["id"]: c["name"] for c in data["categories"]}
    imgs = {i["id"]: i for i in data["images"]}
    anns: dict[int, list] = {}
    for a in data["annotations"]:
        if a.get("iscrowd"):
            continue
        im = imgs[a["image_id"]]
        x, y, w, h = a["bbox"]
        anns.setdefault(a["image_id"], []).append({"cls": cats[a["category_id"]], "touching": False, "broken": False,
                                                   "box": (x / im["width"], y / im["height"],
                                                           w / im["width"], h / im["height"])})
    for objs in anns.values():  # "touching" = boxes that overlap or almost touch another object
        for o in objs:
            o["touching"] = any(p is not o and _gap(o["box"], p["box"]) < 0.01 for p in objs)
    ids = sorted(anns)
    random.Random(seed).shuffle(ids)
    ids = ids[:n]
    files = [(imgs[i]["file_name"], (Path(images_dir) / imgs[i]["file_name"]).read_bytes()) for i in ids]
    gt = {imgs[i]["file_name"]: anns[i] for i in ids}
    return sorted({o["cls"] for v in gt.values() for o in v}), files, gt


# ---------- scoring ----------

def _gap(a, b) -> float:
    dx = max(0.0, max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[1] + a[3], b[1] + b[3]))
    return max(dx, dy)


def _iou(a, b) -> float:
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def match(props: list[dict], gt: list[dict], cls_id: dict[str, int], thr: float = 0.5):
    """Greedy class-agnostic matching by IoU. Returns [(proposal_idx, gt_idx)] and the unmatched sets."""
    pairs = sorted(((_iou((p["x"], p["y"], p["w"], p["h"]), g["box"]), i, j)
                    for i, p in enumerate(props) for j, g in enumerate(gt)), reverse=True)
    used_p, used_g, out = set(), set(), []
    for v, i, j in pairs:
        if v < thr:
            break
        if i in used_p or j in used_g:
            continue
        used_p.add(i)
        used_g.add(j)
        out.append((i, j))
    return out, set(range(len(props))) - used_p, set(range(len(gt))) - used_g


class Tally:
    def __init__(self) -> None:
        self.c = Counter()

    def add(self, props, gt, cls_id) -> None:
        pairs, _fp, _fn = match(props, gt, cls_id)
        tp_g = {j for i, j in pairs if props[i]["class_id"] == cls_id[gt[j]["cls"]]}
        self.c["props"] += len(props)
        self.c["gt"] += len(gt)
        self.c["tp"] += len(tp_g)
        for j, g in enumerate(gt):
            for flag in ("touching", "broken"):
                if g[flag]:
                    self.c[f"{flag}_gt"] += 1
                    self.c[f"{flag}_tp"] += j in tp_g
        want = Counter(g["cls"] for g in gt)
        got = Counter(p["class_id"] for p in props)
        self.c["images"] += 1
        self.c["count_ok"] += all(got.get(cls_id[k], 0) == v for k, v in want.items()) and \
            sum(got.values()) == sum(want.values())

    def report(self) -> dict:
        c = self.c
        p = c["tp"] / c["props"] if c["props"] else 0.0
        r = c["tp"] / c["gt"] if c["gt"] else 0.0
        f1 = 2 * p * r / (p + r) if p + r else 0.0
        out = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f1, 3),
               "count_ok": round(c["count_ok"] / c["images"], 3) if c["images"] else 0.0, "images": c["images"]}
        for flag in ("touching", "broken"):
            if c[f"{flag}_gt"]:
                out[f"{flag}_recall"] = round(c[f"{flag}_tp"] / c[f"{flag}_gt"], 3)
        return out


# ---------- the run ----------

def ceiling(by_id: dict[int, list], with_detector: bool = False) -> dict:
    """Segmentation ceiling: share of objects that have at least one candidate region with IoU >= 0.5.

    Nothing Pixel learns can propose an object above this line: if a metric is stuck, check here first.
    """
    from app import engine as eng

    st = eng.store
    c = Counter()
    with st.lock:
        n = st.n
        win = st.active[:n] & ((st.kind[:n] == eng.KIND_WINDOW)
                               | ((st.kind[:n] == eng.KIND_DETECTOR) if with_detector else False))
        for iid, objs in by_id.items():
            geoms = [tuple(g) for g in st.geom[:n][win & (st.image_id[:n] == iid)]]
            for o in objs:
                hit = any(_iou(g, o["box"]) >= 0.5 for g in geoms)
                c["all"] += 1
                c["all_hit"] += hit
                for flag in ("touching", "broken"):
                    if o[flag]:
                        c[flag] += 1
                        c[f"{flag}_hit"] += hit
    return {k: round(c[f"{k}_hit"] / c[k], 3) for k in ("all", "touching", "broken") if c[k]}


def run(args) -> dict:
    _setup_env(args)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from fastapi.testclient import TestClient

    from app.main import app

    size = tuple(int(v) for v in args.size.split("x"))
    if args.coco:
        classes, files, gt = coco(args.coco, args.images_dir, args.images, args.seed)
    else:
        classes, files, gt = synthetic(args.images, size, args.seed)

    t0 = time.time()
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Benchmark"}).raise_for_status()
        for s in range(0, len(files), 20):
            c.post("/api/images/upload", files=[("files", (n, b, "image/png")) for n, b in files[s:s + 20]])
        while True:
            st = c.get("/api/stats").json()
            if st["images"]["embedded"] >= len(files) and not st["worker"]["running"]:
                break
            if st["worker"]["error"]:
                raise RuntimeError(st["worker"]["error"])
            time.sleep(0.3)
        ingest_s = time.time() - t0
        if args.set:  # ablations, e.g. --set use_background=false --set probe_weight=0
            kv = dict(s.split("=", 1) for s in args.set)
            def _val(v: str):
                if v.lower() in ("true", "false"):
                    return v.lower() == "true"
                try:
                    return float(v)
                except ValueError:
                    return v  # e.g. probe=mlp
            conv = {k: _val(v) for k, v in kv.items()}
            c.put("/api/settings", json=conv).raise_for_status()
        cls_id = {name: c.post("/api/classes", json={"name": name}).json()["id"] for name in classes}
        imgs = c.get("/api/images", params={"limit": 500}).json()["items"]
        by_id = {i["id"]: gt[i["filename"]] for i in imgs}
        ids = sorted(by_id)
        rng = random.Random(args.seed)
        holdout = set(rng.sample(ids, min(args.holdout, len(ids) // 3)))
        checkpoints = sorted({k for k in (1, 3, 5, 10, 20, 30, 50, 80) if k <= args.lessons} | {args.lessons})

        def evaluate() -> dict:
            t = Tally()
            for i in sorted(holdout):
                t.add(c.get(f"/api/images/{i}").json()["proposals"], by_id[i], cls_id)
            return t.report()

        detector_info: dict = {}

        def checkpoint(k: int) -> list[dict]:
            if not detector_info.get("run"):
                return [{"lessons": k, **evaluate()}]
            rows = []
            cur = c.get("/api/settings").json()["settings"]
            keep = {k2: cur[k2] for k2 in ("use_detector", "detector_weight", "detector_veto")}
            c.put("/api/settings", json={"use_detector": False}).raise_for_status()
            rows.append({"lessons": k, "detector": "off", **evaluate()})
            variants = [tuple(float(x) for x in v.split(":")) for v in args.detector_variants.split(",") if v]                 or [(keep["detector_weight"], keep["detector_veto"])]
            for w, veto in variants:
                c.put("/api/settings", json={"use_detector": True, "detector_weight": w,
                                             "detector_veto": veto}).raise_for_status()
                label = "on" if len(variants) == 1 else f"{w:g}:{veto:g}"
                rows.append({"lessons": k, "detector": label, **evaluate()})
            c.put("/api/settings", json=keep).raise_for_status()
            return rows

        def train_detector(k: int) -> None:
            t = time.time()
            r = c.post("/api/training", json={"model": args.detector, "epochs": args.detector_epochs,
                                              "imgsz": args.detector_imgsz, "patience": args.detector_epochs,
                                              "batch": 8})
            if r.status_code != 200:
                raise RuntimeError(f"detector training refused: {r.text}")
            rid = r.json()["id"]
            while True:
                st = c.get(f"/api/training/{rid}").json()
                if st["state"] not in ("preparing", "running"):
                    break
                time.sleep(3)
            if st["state"] != "done":
                raise RuntimeError(f"detector training ended as {st['state']}: {st.get('error')}")
            c.post(f"/api/training/{rid}/activate").raise_for_status()
            while True:  # the worker looks at the images still to annotate
                s = c.get("/api/stats").json()
                d = s.get("detector") or {}
                if d.get("todo") == 0 and not s["worker"]["running"]:
                    break
                time.sleep(0.5)
            best = st.get("best")
            detector_info.update(run=rid, after_lessons=k, train_seconds=round(time.time() - t), images=st["dataset"],
                                 best=best, stats=d)

        curve = checkpoint(0)
        online, blocks, seen = Tally(), [], []
        block = Tally()
        effort = Counter()
        t1 = time.time()
        for k in range(1, args.lessons + 1):
            nxt = c.get("/api/queue/next", params={"position": k - 1,
                                                   "exclude": ",".join(map(str, sorted(holdout) + seen))}).json()
            iid = nxt["image_id"]
            if iid is None:
                break
            seen.append(iid)
            d = c.get(f"/api/images/{iid}").json()
            props, truth = d["proposals"], by_id[iid]
            online.add(props, truth, cls_id)
            block.add(props, truth, cls_id)
            pairs, fp, fn = match(props, truth, cls_id)
            boxes, rejected = [], []
            for i, j in pairs:
                p, want = props[i], cls_id[truth[j]["cls"]]
                boxes.append({"class_id": want, "x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"],
                              "proposal_region_id": p["region_id"], "proposal_class_id": p["class_id"]})
                effort["accepted" if p["class_id"] == want else "relabelled"] += 1
            for i in fp:
                p = props[i]
                rejected.append({"region_id": p["region_id"], "class_id": p["class_id"],
                                 "x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"]})
                effort["rejected"] += 1
            for j in fn:
                x, y, w, h = truth[j]["box"]
                boxes.append({"class_id": cls_id[truth[j]["cls"]], "x": x, "y": y, "w": w, "h": h})
                effort["drawn"] += 1
            res = c.put(f"/api/images/{iid}/annotations", json={"boxes": boxes, "rejected": rejected, "done": True}).json()
            effort["propagated"] += res["delta_count"]
            if k % args.block == 0:
                blocks.append({"lessons": k, **block.report()})
                block = Tally()
            if args.detector and k == args.detector_after:
                train_detector(k)
                curve += checkpoint(k)
            elif k in checkpoints:
                curve += checkpoint(k)
        teach_s = time.time() - t1
        st = c.get("/api/stats").json()
    return {"config": {k: v for k, v in vars(args).items() if k not in ("out",)},
            "ingest_seconds": round(ingest_s, 1), "teach_seconds": round(teach_s, 1),
            "engine": st["engine"],
            "regions_per_image": round(st["engine"]["vectors"] / max(1, len(files)), 1),
            "candidate_ceiling": ceiling(by_id),
            "candidate_ceiling_with_detector": ceiling(by_id, True) if detector_info else None,
            "detector": detector_info or None,
            "heldout_curve": curve, "online_blocks": blocks, "online_total": online.report(),
            "effort": dict(effort), "track": st["track"], "learning": st["learning"],
            "probe": st["engine"]["probe"]}


def _print(rep: dict) -> None:
    cols = ("precision", "recall", "f1", "count_ok", "touching_recall", "broken_recall")
    print(f"ingest {rep['ingest_seconds']}s ({rep['regions_per_image']} regions/image), "
          f"teaching {rep['teach_seconds']}s")
    print("segmentation ceiling (objects with a candidate region, IoU >= 0.5):", rep["candidate_ceiling"])
    if rep.get("detector"):
        d = rep["detector"]
        print(f"detector {d['run']} trained after {d['after_lessons']} lessons in {d['train_seconds']}s "
              f"on {d['images']}; best epoch {d['best']}; {d['stats']}")
        print("ceiling with the detector's regions:", rep["candidate_ceiling_with_detector"])
    for title, rows in (("held-out images, after N lessons", rep["heldout_curve"]),
                        ("online (before each teaching step), per block", rep["online_blocks"])):
        print(f"\n{title}")
        print("lessons     det " + " ".join(f"{c:>15}" for c in cols))
        for r in rows:
            print(f"{r['lessons']:>7} {r.get('detector', '-'):>7} "
                  + " ".join(f"{r.get(c, float('nan')):>15.3f}" for c in cols))
    print("\neffort:", rep["effort"])
    print("learning:", rep["learning"])


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", type=int, default=90)
    ap.add_argument("--holdout", type=int, default=30)
    ap.add_argument("--lessons", type=int, default=40)
    ap.add_argument("--block", type=int, default=10)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--size", default="320x240")
    ap.add_argument("--profile", choices=["light", "balanced", "accurate"],
                    help="engine profile with real models (default: fake embedder + simple segmenter)")
    ap.add_argument("--embedder", help="override: pixels | dinov2 | siglip")
    ap.add_argument("--segmenter", help="override: simple | sam | sam2")
    ap.add_argument("--proposer", default="segments")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                    help="engine setting to apply before teaching (repeatable), e.g. use_background=false")
    ap.add_argument("--detector", help="train this LibreYOLO model (e.g. yolo9-t) after --detector-after lessons")
    ap.add_argument("--detector-after", type=int, default=20)
    ap.add_argument("--detector-epochs", type=int, default=60)
    ap.add_argument("--detector-imgsz", type=int, default=320)
    ap.add_argument("--detector-variants", default="",
                    help="weight:veto pairs measured at every checkpoint, e.g. 0.5:0.5,0.5:0,0.3:0.2 (default: current)")
    ap.add_argument("--coco")
    ap.add_argument("--images-dir")
    ap.add_argument("--out", help="write the JSON report here")
    ap.add_argument("--json", action="store_true", help="print only the JSON report")
    args = ap.parse_args(argv)
    rep = run(args)
    if args.out:
        Path(args.out).write_text(json.dumps(rep, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(rep))
    else:
        _print(rep)


if __name__ == "__main__":
    main()
