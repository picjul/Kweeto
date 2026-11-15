"""Background thread: the one-off visual scan of every image of the active project
(candidate regions + embeddings), the re-embedding of boxes after an embedder change, and the pass of the
project's trained detector over the images still to annotate (detections + extra candidate regions).

The slow work (segmenting, embedding) runs with NO database session open, so switching or deleting a
project never waits for it; results are written under `workspace.lock` only if the project and the
engine profile are still the ones the work started with (`profiles.generation`).
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
from collections import defaultdict

from sqlalchemy import exists, select

from . import db, embedder, profiles, regions, segmenter, services, workspace
from . import engine as eng
from .config import BOX_PAD
from .models import Box, Detection, DetectorScan, ImageItem, LabelClass, Region, Verification

log = logging.getLogger("kweeto.worker")
CHUNK = 8
DET_REGION_MIN = 0.25   # detector boxes at least this strong become candidate regions when no window covers them
DET_COVERED_IOU = 0.8   # ... "covered" = an existing candidate with at least this IoU


def _todo(s) -> list[int]:
    """New images, plus already analysed ones whose candidate regions were dropped by a re-scan."""
    no_regions = ~exists().where(Region.image_id == ImageItem.id, Region.kind == "window")
    q = select(ImageItem.id).where((ImageItem.status == "pending")
                                   | (ImageItem.status.in_(["embedded", "annotated", "ignored"]) & no_regions))
    return list(s.scalars(q.order_by(ImageItem.id)))


def _detector_todo(s, run: str) -> list[int]:
    """Images still to annotate that this detector has not looked at yet."""
    done = exists().where(DetectorScan.image_id == ImageItem.id, DetectorScan.run == run)
    return list(s.scalars(select(ImageItem.id).where(ImageItem.status == "embedded", ~done).order_by(ImageItem.id)))


def _uncovered(image_id: int, boxes: list[dict]) -> list[tuple]:
    """The detector's confident boxes that no candidate region of the image already covers."""
    st = eng.store
    with st.lock:
        n = st.n
        rows = st.active[:n] & (st.image_id[:n] == image_id) & (st.kind[:n] != eng.KIND_BOX)
        have = [tuple(float(v) for v in g) for g in st.geom[:n][rows]]
    out: list[tuple] = []
    for b in boxes:
        g = (b["x"], b["y"], b["w"], b["h"])
        if b["score"] < DET_REGION_MIN or g[2] * g[3] < 1e-4:
            continue
        if any(eng.iou(g, h) >= DET_COVERED_IOU for h in have + out):
            continue
        out.append(g)
    return out


def _boxes_todo(s) -> list[Box]:
    """Confirmed boxes without a vector (the embedder changed): re-embedded from their crop."""
    return list(s.scalars(select(Box).where(~exists().where(Region.box_id == Box.id)).order_by(Box.image_id)))


class EmbeddingWorker:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self.progress: dict = {}
        self.reset_progress()

    def reset_progress(self) -> None:
        """What the UI shows. phase: idle | loading (models) | boxes (re-embedding your boxes) |
        scanning (finding objects + embeddings, `done`/`total` images) | learning (updating the guesses).
        kind: new (uploaded images) | rescan (profile change / re-scan) | mixed. eta_s from the measured speed."""
        self.progress = {"running": False, "phase": "idle", "kind": None, "done": 0, "total": 0,
                         "seconds_per_image": None, "eta_s": None, "started_at": None,
                         "model_ready": self.progress.get("model_ready", False) if self.progress else False,
                         "error": None, "last": self.progress.get("last") if self.progress else None}

    def _set(self, **kw) -> None:
        self.progress.update(kw)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True, name="embedding-worker")
            self._thread.start()
        self.wake()

    def wake(self) -> None:
        self._wake.set()

    def _warmup(self) -> None:
        try:
            embedder.warmup()
            self.progress.update(model_ready=True, error=None)
        except Exception as e:  # pragma: no cover
            self.progress["error"] = f"Model not loaded: {e}"
            log.exception("warmup failed")
        try:
            segmenter.warmup()
        except Exception:  # pragma: no cover - the segmenter is optional; the click endpoint reports errors
            log.exception("segmenter warmup failed")

    def _run(self) -> None:
        loaded = None
        while True:
            self._wake.wait(timeout=5)
            self._wake.clear()
            if workspace.current is None:  # no project open: nothing to do
                continue
            try:
                if loaded != profiles.active.signature + profiles.active.scan_signature:
                    with db.SessionLocal() as s:
                        waiting = len(_todo(s))
                    if waiting:  # say so: the first load can include a model download
                        self._set(running=True, phase="loading", done=0, total=waiting, eta_s=None, error=None)
                    loaded = profiles.active.signature + profiles.active.scan_signature
                    self.progress["model_ready"] = False
                    self._warmup()
                self._process_pending()
            except Exception as e:  # pragma: no cover
                self.progress["error"] = str(e)
                log.error(traceback.format_exc())
                self._set(running=False, phase="idle")

    def _stale(self, gen: int) -> bool:
        if gen == profiles.generation:
            return False
        self._set(running=False, phase="idle")
        self.wake()  # start again on the new project / profile
        return True

    def _tick(self, t0: float) -> None:
        p = self.progress
        p["done"] += 1
        rate = (time.time() - t0) / max(1, p["done"])
        p["seconds_per_image"] = round(rate, 2)
        p["eta_s"] = round(rate * max(0, p["total"] - p["done"]))

    def _process_pending(self) -> None:
        gen = profiles.generation
        with db.SessionLocal() as s:
            ids = _todo(s)
            n_boxes = len(_boxes_todo(s))
            n_new = len([i for i in s.scalars(select(ImageItem.id).where(ImageItem.status == "pending"))])
        if not ids and not n_boxes:
            n_det = self._detector_pass(gen)
            if n_det is None:
                return
            if n_det:
                self._learn(gen, 0, None)
            elif self.progress["running"]:
                self._set(running=False, phase="idle")
            return
        kind = "new" if n_new == len(ids) else "rescan" if n_new == 0 else "mixed"
        self._set(running=True, kind=kind, done=0, total=len(ids), eta_s=None, seconds_per_image=None,
                  started_at=time.time(), error=None)
        if n_boxes:
            self._set(phase="boxes")
            if not self._reembed_boxes(gen):
                return
        self._set(phase="scanning")
        t0 = time.time()
        for start in range(0, len(ids), CHUNK):
            with db.SessionLocal() as s:
                todo = [(i.id, workspace.images_dir() / i.stored_name)
                        for i in s.scalars(select(ImageItem).where(ImageItem.id.in_(ids[start:start + CHUNK])))]
            found: dict[int, list] = {}
            failed: dict[int, str] = {}
            for iid, path in todo:  # slow part: no DB session open
                if self._stale(gen):
                    return
                try:
                    found[iid] = regions.compute(str(path), embedder.load_image(path))
                except Exception as e:
                    failed[iid] = str(e)[:500]
                self._tick(t0)
            with workspace.lock:
                if self._stale(gen):
                    return
                with db.SessionLocal() as s:
                    new = [Region(image_id=iid, kind="window", x=g[0], y=g[1], w=g[2], h=g[3], is_full=full,
                                  embedding=v.astype("float32").tobytes())
                           for iid, items in found.items() for g, full, v in items]
                    # imported images can arrive with their boxes (or as finished): they are already "annotated"
                    taught = set(s.scalars(select(Box.image_id).where(Box.image_id.in_(list(found))))) | set(
                        s.scalars(select(Verification.image_id).where(Verification.image_id.in_(list(found)))))
                    for img in s.scalars(select(ImageItem).where(ImageItem.id.in_(list(found) + list(failed)))):
                        if img.id in failed:
                            img.status, img.error = "error", failed[img.id]
                        elif img.status == "pending":
                            img.status = "annotated" if img.id in taught else "embedded"
                    s.add_all(new)
                    s.commit()
                    eng.store.add([(r.id, r.image_id, eng.KIND_WINDOW, (r.x, r.y, r.w, r.h), r.is_full,
                                    services.vec_of(r)) for r in new])
        started = self.progress["started_at"]
        if self._detector_pass(gen) is None:
            return
        self._learn(gen, len(ids), kind, started)

    def _learn(self, gen: int, count: int, kind: str | None, started: float | None = None) -> None:
        self._set(running=True, phase="learning", eta_s=None)
        with workspace.lock:
            if self._stale(gen):
                return
            with db.SessionLocal() as s:
                services.recompute(s)
        last = self.progress.get("last")
        if count:
            last = {"count": count, "kind": kind, "finished_at": time.time(),
                    "seconds": round(time.time() - (started or time.time()))}
        self._set(running=False, phase="idle", eta_s=None, last=last)
        self.wake()  # more images may have arrived in the meantime

    def _detector_pass(self, gen: int) -> int | None:
        """The active detector looks at the images still to annotate (once per image and detector).

        Stores its boxes (Pixel may use them as evidence, settings.use_detector) and adds a candidate region
        where it saw an object no window covered. Returns how many images it looked at, None if stale.
        """
        from . import detector_infer

        try:
            run = detector_infer.active_id()
        except Exception:
            return 0
        if run is None:
            return 0
        with db.SessionLocal() as s:
            ids = _detector_todo(s, run)
            by_name = {c.name: (c.id, c.name) for c in s.scalars(select(LabelClass))}
        if not ids:
            return 0
        self._set(running=True, phase="detector", done=0, total=len(ids), eta_s=None, seconds_per_image=None,
                  started_at=self.progress.get("started_at") or time.time(), error=None)
        t0 = time.time()
        failed_once = False
        for start in range(0, len(ids), CHUNK):
            with db.SessionLocal() as s:
                todo = [(i.id, workspace.images_dir() / i.stored_name)
                        for i in s.scalars(select(ImageItem).where(ImageItem.id.in_(ids[start:start + CHUNK])))]
            found: dict[int, tuple[list, list]] = {}
            for iid, path in todo:  # slow part: no DB session open
                if self._stale(gen):
                    return None
                boxes, regs = [], []
                try:
                    boxes, pil = detector_infer.scan_image(run, path, by_name)
                    geoms = _uncovered(iid, boxes)
                    if geoms:
                        vecs = embedder.embed_images([embedder.crop_norm(pil, *g, pad=BOX_PAD) for g in geoms])
                        regs = list(zip(geoms, vecs))
                except Exception:
                    if not failed_once:
                        log.exception("the detector could not look at image %s", iid)
                        failed_once = True
                found[iid] = (boxes, regs)
                self._tick(t0)
            with workspace.lock:
                if self._stale(gen):
                    return None
                with db.SessionLocal() as s:
                    chunk = list(found)
                    s.execute(Detection.__table__.delete().where(Detection.image_id.in_(chunk)))
                    s.execute(DetectorScan.__table__.delete().where(DetectorScan.image_id.in_(chunk)))
                    s.add_all([Detection(image_id=iid, run=run, class_id=b["class_id"], score=b["score"],
                                         x=b["x"], y=b["y"], w=b["w"], h=b["h"])
                               for iid, (boxes, _r) in found.items() for b in boxes])
                    s.add_all([DetectorScan(image_id=iid, run=run) for iid in chunk])
                    new = [Region(image_id=iid, kind="detect", x=g[0], y=g[1], w=g[2], h=g[3], is_full=False,
                                  embedding=v.astype("float32").tobytes())
                           for iid, (_b, regs) in found.items() for g, v in regs]
                    s.add_all(new)
                    s.commit()
                    eng.store.add([(r.id, r.image_id, eng.KIND_DETECTOR, (r.x, r.y, r.w, r.h), False,
                                    services.vec_of(r)) for r in new])
        return len(ids)

    def _reembed_boxes(self, gen: int) -> bool:
        with db.SessionLocal() as s:
            by_img: dict[int, list] = defaultdict(list)
            for b in _boxes_todo(s):
                by_img[b.image_id].append((b.id, b.x, b.y, b.w, b.h))
            names = dict(s.execute(select(ImageItem.id, ImageItem.stored_name)
                                   .where(ImageItem.id.in_(list(by_img)))).all())
        vecs: list[tuple] = []
        for iid, boxes in by_img.items():
            if iid not in names:
                continue
            if self._stale(gen):
                return False
            pil = embedder.load_image(workspace.images_dir() / names[iid])
            vs = embedder.embed_images([embedder.crop_norm(pil, x, y, w, h, pad=BOX_PAD) for _b, x, y, w, h in boxes])
            vecs += [(iid, b, v) for b, v in zip(boxes, vs)]
        with workspace.lock:
            if self._stale(gen):
                return False
            with db.SessionLocal() as s:
                new = [Region(image_id=iid, kind="box", box_id=bid, x=x, y=y, w=w, h=h, is_full=False,
                              embedding=v.astype("float32").tobytes()) for iid, (bid, x, y, w, h), v in vecs]
                s.add_all(new)
                s.commit()
                eng.store.add([(r.id, r.image_id, eng.KIND_BOX, (r.x, r.y, r.w, r.h), False, services.vec_of(r))
                               for r in new])
        return True


worker = EmbeddingWorker()
