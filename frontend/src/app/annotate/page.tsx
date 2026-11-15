"use client";

import {
  ArrowRight, Check, Expand, Eye, EyeOff, Flag, Flame, Keyboard, Minimize, Redo2, SkipForward, Sparkles, Sprout, Trash2, Undo2, X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoxCanvas, type DraftBox } from "@/components/box-canvas";
import { LeverageCounter } from "@/components/leverage-counter";
import { PixelAvatar, PixelBurst, PixelSays, Typewriter, type PixelMood } from "@/components/pixel";
import { useProject } from "@/components/project-context";
import { tourEvent } from "@/components/tour";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, fileUrl, type ImageDetail, type LabelClass, type Proposal, type SimilarImage } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn, LEVEL_LABEL } from "@/lib/utils";

export default function AnnotatePage() {
  return (
    <Suspense fallback={<div className="flex justify-center pt-24"><PixelAvatar mood="thinking" size={100} /></div>}>
      <Lesson />
    </Suspense>
  );
}

let keySeq = 0;
const newKey = () => `n${++keySeq}`;

function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

const COMBO_LINES: Record<number, string> = {
  3: "Three in a row! I think I'm getting the hang of this.",
  5: "Five correct guesses in a row. Your examples are paying off!",
  10: "Ten in a row?! Okay, now I'm showing off.",
};

function Lesson() {
  const params = useSearchParams();
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [activeClass, setActiveClass] = useState<number | null>(null);
  const [image, setImage] = useState<ImageDetail | null>(null);
  const [boxes, setBoxes] = useState<DraftBox[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarImage[]>([]);
  const [position, setPosition] = useState(0);
  const [harvest, setHarvest] = useState(0);
  const [taught, setTaught] = useState(0);
  const [combo, setCombo] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [cheer, setCheer] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [waiting, setWaiting] = useState(false); // images still being scanned: the first one is not ready yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<PixelMood | null>(null);
  const [bounce, setBounce] = useState(0);
  const [burst, setBurst] = useState(0);
  const [seeking, setSeeking] = useState<{ x: number; y: number } | null>(null);
  const [snap, setSnap] = useState(true);
  const [showGuesses, setShowGuesses] = useState(true);
  const [focus, setFocus] = useState(false);
  const [guessFocus, setGuessFocus] = useState<number | null>(null); // a guess highlighted from the keyboard (G)
  const [announce, setAnnounce] = useState(""); // screen-reader announcements (aria-live)
  const visibleArea = useRef({ x: 0, y: 0, w: 1, h: 1 });
  const say = useCallback((msg: string) => {
    setAnnounce("");
    requestAnimationFrame(() => setAnnounce(msg)); // same text twice is announced twice
  }, []);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // undo / redo over the edits of the current image (boxes + rejected guesses)
  type Snapshot = { boxes: DraftBox[]; hidden: Set<number> };
  const now = useRef<Snapshot>({ boxes, hidden });
  now.current = { boxes, hidden };
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [, setHistoryTick] = useState(0);
  const remember = useCallback(() => {
    past.current = [...past.current.slice(-99), now.current];
    future.current = [];
    setHistoryTick((t) => t + 1);
  }, []);
  const edit = useCallback((fn: (bs: DraftBox[]) => DraftBox[]) => {
    remember();
    setBoxes(fn);
  }, [remember]);
  const travel = useCallback((from: typeof past, to: typeof past) => {
    const s = from.current.pop();
    if (!s) return;
    to.current.push(now.current);
    setBoxes(s.boxes);
    setHidden(s.hidden);
    setSelected((k) => (k && s.boxes.some((b) => b.key === k) ? k : null));
    setHistoryTick((t) => t + 1);
  }, []);
  const undo = useCallback(() => travel(past, future), [travel]);
  const redo = useCallback(() => travel(future, past), [travel]);

  // the teaching session behind the end-of-lesson recap (BEFORE / AFTER): resumed on a reload of this tab
  const { project } = useProject();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const sessionKey = `kweeto-lesson:${project?.id ?? "-"}`;
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    let stored: number | null = null;
    try { stored = Number(sessionStorage.getItem(sessionKey)) || null; } catch { /* ignore */ }
    api.startSession(stored).then((s) => {
      setSessionId(s.id);
      try { sessionStorage.setItem(sessionKey, String(s.id)); } catch { /* ignore */ }
    }).catch(() => setSessionId(null));
  }, [projectId, sessionKey]);
  const endLesson = useCallback(() => {
    try { sessionStorage.removeItem(sessionKey); } catch { /* ignore */ }
  }, [sessionKey]);

  const queue = useRef<number[]>([]);
  const forced = useRef<number | null>(null);
  const seen = useRef<number[]>([]);
  const started = useRef(false);

  useEffect(() => {
    api.classes().then((cs) => {
      setClasses(cs);
      setActiveClass((cur) => cur ?? cs[0]?.id ?? null);
    });
    api.settings().then((s) => setSnap(s.settings.snap_boxes)).catch(() => undefined);
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  const loadImage = useCallback(async (id: number) => {
    api.prepareSegment(id).catch(() => undefined); // warm the segmenter so the first click is fast
    const d = await api.image(id);
    setImage(d);
    setBoxes(d.boxes.map((b) => ({ key: `b${b.id}`, id: b.id, class_id: b.class_id, x: b.x, y: b.y, w: b.w, h: b.h })));
    setHidden(new Set());
    setSelected(null);
    setGuessFocus(null);
    past.current = [];
    future.current = [];
    api.similar(id, 12).then((s) => setSimilar(s.filter((x) => x.box_count > 0).slice(0, 6))).catch(() => setSimilar([]));
  }, []);

  const loadNext = useCallback(async (pos: number) => {
    setError(null);
    let id: number | null = null;
    if (forced.current != null) {
      id = forced.current;
      forced.current = null;
    } else if (queue.current.length) {
      id = queue.current.shift() ?? null;
    } else {
      const r = await api.next(pos, seen.current.slice(-300));
      id = r.image_id;
      if (id == null && r.reason === "waiting") { // Pixel is still looking at the images: wait, don't say "done"
        setImage(null);
        setWaiting(true);
        timers.current.push(setTimeout(() => { loadNext(pos).catch((e) => setError((e as Error).message)); }, 2000));
        return;
      }
    }
    setWaiting(false);
    if (id == null) {
      setImage(null);
      setFinished(true);
      return;
    }
    seen.current.push(id);
    await loadImage(id);
  }, [loadImage]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const img = params.get("image");
    const q = params.get("queue");
    if (img) forced.current = Number(img);
    if (q) queue.current = q.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    loadNext(0).catch((e) => setError((e as Error).message));
  }, [params, loadNext]);

  const acceptedRegions = useMemo(() => new Set(boxes.map((b) => b.proposal_region_id).filter(Boolean)), [boxes]);
  const visible = useMemo(
    () => (image?.proposals ?? []).filter((p) => !hidden.has(p.id) && !acceptedRegions.has(p.region_id)),
    [image, hidden, acceptedRegions],
  );

  const acceptAll = useCallback((ps: Proposal[]) => {
    if (!ps.length) return;
    play("click");
    edit((bs) => [...bs, ...ps.map((p) => ({
      key: newKey(), class_id: p.class_id, x: p.x, y: p.y, w: p.w, h: p.h,
      proposal_region_id: p.region_id, proposal_class_id: p.class_id,
    }))]);
    tourEvent("box");
  }, [edit]);
  const rejectAll = useCallback((ps: Proposal[]) => {
    if (!ps.length) return;
    remember();
    setHidden((h) => { const n = new Set(h); ps.forEach((p) => n.add(p.id)); return n; });
  }, [remember]);
  const accept = useCallback((p: Proposal) => acceptAll([p]), [acceptAll]);
  const reject = useCallback((p: Proposal) => rejectAll([p]), [rejectAll]);

  const setBoxClass = useCallback((key: string, classId: number) => {
    edit((bs) => bs.map((b) => (b.key === key ? { ...b, class_id: classId } : b)));
  }, [edit]);
  const deleteBox = useCallback((key: string) => {
    edit((bs) => bs.filter((b) => b.key !== key));
    setSelected((k) => (k === key ? null : k));
  }, [edit]);
  const moveBox = useCallback((key: string, g: { x: number; y: number; w: number; h: number }) => {
    edit((bs) => bs.map((b) => (b.key === key ? { ...b, ...g } : b)));
  }, [edit]);

  // click an object -> the segmenter draws a tight box around it
  const magicBox = useCallback(async (x: number, y: number) => {
    if (!image || activeClass == null || seeking) return;
    setSeeking({ x, y });
    try {
      const r = await api.segment(image.id, { points: [[x, y]] });
      if (r.box) {
        edit((bs) => [...bs, { key: newKey(), class_id: activeClass, ...r.box! }]);
        tourEvent("box");
      } else {
        setFeedback("I couldn't find an object there. Try drawing a box around it.");
      }
    } catch (e) {
      setFeedback((e as Error).message);
    } finally {
      setSeeking(null);
    }
  }, [image, activeClass, seeking, edit]);

  // hand-drawn box: add it right away, then let the segmenter snap it to the object
  // (the snap is part of the same undo step: undo removes the box)
  const addDrawnBox = useCallback(async (b: Omit<DraftBox, "key">) => {
    const key = newKey();
    edit((bs) => [...bs, { ...b, key }]);
    tourEvent("box");
    if (!snap || !image) return;
    try {
      const r = await api.segment(image.id, { box: [b.x, b.y, b.w, b.h] });
      if (r.box && iou(r.box, b) > 0.3) {
        setBoxes((bs) => bs.map((x) => (x.key === key ? { ...x, ...r.box! } : x)));
      }
    } catch {
      /* keep the hand-drawn box */
    }
  }, [snap, image, edit]);

  const save = useCallback(async () => {
    if (!image || busy) return;
    setBusy(true);
    try {
      const top = image.proposals[0];
      const guessedRight = !!top && boxes.some((b) => b.proposal_region_id === top.region_id && b.class_id === top.class_id);
      const accepted = new Set(boxes.map((b) => b.proposal_region_id).filter(Boolean));
      const rejected = image.proposals
        .filter((p) => !accepted.has(p.region_id))
        .map((p) => ({ region_id: p.region_id, class_id: p.class_id, x: p.x, y: p.y, w: p.w, h: p.h }));
      const res = await api.saveAnnotations(image.id, {
        boxes: boxes.map(({ key: _k, ...b }) => b),
        rejected,
        done: true,
      });

      // combo = consecutive images where Pixel's top guess was right (a real signal, reset without penalty)
      const nextCombo = guessedRight ? combo + 1 : 0;
      setCombo(nextCombo);
      setBestCombo((b) => Math.max(b, nextCombo));
      setCheer(guessedRight && COMBO_LINES[nextCombo] ? COMBO_LINES[nextCombo] : null);

      setHarvest((h) => h + res.delta_count);
      tourEvent("saved");
      setTaught((t) => t + 1);
      setFeedback(res.message);
      const big = res.delta_count >= 10 || (guessedRight && COMBO_LINES[nextCombo]);
      setCelebrate(res.delta_count > 0 || guessedRight ? "proud" : "happy");
      play(guessedRight && COMBO_LINES[nextCombo] ? "levelup" : res.delta_count > 0 ? "proud" : guessedRight ? "happy" : "hello");
      if (res.delta_count > 0 || guessedRight) setBounce((b) => b + 1);
      if (big) setBurst((b) => b + 1);
      later(() => setCelebrate(null), res.delta_count > 0 ? 2600 : 1300);

      const next = position + 1;
      setPosition(next);
      await loadNext(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [image, busy, boxes, position, loadNext, combo]);

  const skip = useCallback(async () => {
    const next = position + 1;
    setPosition(next);
    setFeedback(null);
    setCheer(null);
    await loadNext(next).catch((e) => setError((e as Error).message));
  }, [position, loadNext]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; // palette or share card open
      const onCanvas = !!target?.hasAttribute?.("data-canvas"); // the canvas itself (not the zoom buttons in it)
      const k = e.key.toLowerCase();
      const sel = boxes.find((b) => b.key === selected);
      if ((e.ctrlKey || e.metaKey) && k.startsWith("arrow") && sel) {
        // resize the selected box from its right / bottom edge; Shift = 5x
        e.preventDefault();
        const step = e.shiftKey ? 0.02 : 0.004;
        const dw = k === "arrowright" ? step : k === "arrowleft" ? -step : 0;
        const dh = k === "arrowdown" ? step : k === "arrowup" ? -step : 0;
        const w = Math.max(0.005, Math.min(1 - sel.x, sel.w + dw)), h = Math.max(0.005, Math.min(1 - sel.y, sel.h + dh));
        moveBox(sel.key, { x: sel.x, y: sel.y, w, h });
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); say("Undone"); }
        else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); say("Redone"); }
        return;
      }
      if (e.altKey) return;
      const guess = guessFocus != null ? visible.find((p) => p.id === guessFocus) : undefined;
      if (/^[1-9]$/.test(k)) {
        const c = classes[Number(k) - 1];
        if (!c) return;
        if (sel) { if (sel.class_id !== c.id) { setBoxClass(sel.key, c.id); say(`Box changed to ${c.name}`); } }
        else { setActiveClass(c.id); say(`Drawing ${c.name}`); }
      } else if (k === "a") {
        if (!showGuesses) return;
        if (guess) { accept(guess); say(`Accepted: ${name(guess.class_id)}`); nextGuess(guess.id); }
        else if (visible.length) { acceptAll(visible); say(`Accepted ${visible.length} ${visible.length === 1 ? "guess" : "guesses"}`); }
      } else if (k === "x") {
        if (!showGuesses) return;
        if (guess) { reject(guess); say(`Rejected: ${name(guess.class_id)}`); nextGuess(guess.id); }
        else if (visible.length) { rejectAll(visible); say(`Rejected ${visible.length} ${visible.length === 1 ? "guess" : "guesses"}`); }
      } else if (k === "g" && showGuesses && visible.length) {
        // walk through Pixel's guesses one by one
        const i = visible.findIndex((p) => p.id === guessFocus);
        const n = i < 0 ? (e.shiftKey ? visible.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + visible.length) % visible.length;
        const p = visible[n];
        setSelected(null);
        setGuessFocus(p.id);
        say(`Guess ${n + 1} of ${visible.length}: ${name(p.class_id)}, ${LEVEL_LABEL[p.level]}${p.detector?.class_id != null
          ? p.detector.class_id === p.class_id ? ", the detector agrees" : `, the detector says ${name(p.detector.class_id)}` : ""}. A to accept, X to reject.`);
      } else if (k === "n") {
        // a new box from the keyboard, in the middle of what is visible; then arrows move it, Ctrl+arrows resize it
        if (activeClass == null) { say("Pick a class first: keys 1 to 9"); return; }
        const v = visibleArea.current;
        const w = Math.min(0.2, v.w * 0.3), h = Math.min(0.2, v.h * 0.3);
        const key = newKey();
        edit((bs) => [...bs, { key, class_id: activeClass, x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h }]);
        tourEvent("box");
        setSelected(key);
        setGuessFocus(null);
        say(`New ${name(activeClass)} box. Arrows move it, Ctrl+arrows resize it, Escape when done.`);
      } else if (k === "h") {
        setShowGuesses((s) => !s);
      } else if (k === "f") {
        setFocus((f) => !f);
      } else if (k === "enter") {
        if (tag === "BUTTON") return; // let Enter press the focused button
        e.preventDefault();
        save();
      } else if (k === "s") {
        skip();
      } else if ((k === "delete" || k === "backspace") && sel) {
        e.preventDefault();
        deleteBox(sel.key);
        say(`Deleted the ${name(sel.class_id)} box`);
      } else if (k === "tab" && onCanvas && boxes.length) {
        // on the canvas, Tab walks through the boxes; past the last one it leaves the canvas as usual
        const i = boxes.findIndex((b) => b.key === selected);
        const n = i < 0 ? (e.shiftKey ? boxes.length - 1 : 0) : i + (e.shiftKey ? -1 : 1);
        if (n < 0 || n >= boxes.length) { // leave the canvas: next (or previous) focusable element outside it
          e.preventDefault();
          setSelected(null);
          const canvas = target!;
          const all = Array.from(document.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex='-1'])"))
            .filter((el) => !canvas.contains(el) && el.offsetParent !== null);
          const after = all.filter((el) => canvas.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
          const before = all.filter((el) => canvas.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
          (e.shiftKey ? before[before.length - 1] : after[0])?.focus();
          return;
        }
        e.preventDefault();
        setSelected(boxes[n].key);
        setGuessFocus(null);
        say(`Box ${n + 1} of ${boxes.length}: ${name(boxes[n].class_id)}. Arrows move it, Ctrl+arrows resize it, 1 to 9 change its class, Delete removes it.`);
      } else if (k.startsWith("arrow") && sel) {
        // nudge the selected box; Shift = 10x
        e.preventDefault();
        const step = e.shiftKey ? 0.01 : 0.002;
        const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0;
        const dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
        moveBox(sel.key, {
          x: Math.max(0, Math.min(1 - sel.w, sel.x + dx)), y: Math.max(0, Math.min(1 - sel.h, sel.y + dy)), w: sel.w, h: sel.h,
        });
      } else if (k === "escape") {
        if (guessFocus != null) setGuessFocus(null);
        else if (selected) setSelected(null);
        else if (focus) setFocus(false);
      }
    };
    // after acting on a highlighted guess, move to the next one still there
    const nextGuess = (doneId: number) => {
      const rest = visible.filter((p) => p.id !== doneId);
      const i = visible.findIndex((p) => p.id === doneId);
      setGuessFocus(rest.length ? rest[Math.min(i, rest.length - 1)].id : null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [classes, boxes, selected, visible, showGuesses, focus, guessFocus, activeClass, accept, reject, acceptAll, rejectAll,
    setBoxClass, deleteBox, moveBox, edit, undo, redo, save, skip, say]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map(classes.map((c) => [c.id, c]));
  const name = (id: number | null | undefined) => (id != null ? byId.get(id)?.name ?? "?" : "?");
  const selectedBox = boxes.find((b) => b.key === selected) ?? null;
  const top = visible[0];

  const pixelLine: string | null = (() => {
    if (!classes.length) return null;
    if (!image) return null;
    if (!top) {
      if (boxes.length) return "Perfect. Press Enter to save and move on to the next one.";
      return "I have no idea about this one. Draw a box around each object and tell me what it is.";
    }
    const count = visible.filter((p) => p.class_id === top.class_id).length;
    const what = count > 1 ? `${count} × “${name(top.class_id)}”` : `“${name(top.class_id)}”`;
    // the confidence sentence comes from the backend: a template backed by Pixel's real track record
    const why = top.id === image.proposals[0]?.id && image.track_line ? ` ${image.track_line}` : "";
    if (top.level === "unsure") {
      return `Lots of doubts here: maybe ${what}${top.second_class_id != null ? ` or “${name(top.second_class_id)}”` : ""}?${why} Teach me.`;
    }
    return `I think I see ${what}.${why}${top.level === "fair" ? " Am I right?" : ""}`;
  })();

  const mood: PixelMood = celebrate
    ?? (seeking ? "thinking"
      : !classes.length ? "sleepy"
      : !image ? "thinking"
      : top ? (top.level === "sure" ? "happy" : top.level === "fair" ? "curious" : "thinking")
      : boxes.length ? "happy" : "curious");

  // the tour waits for Pixel's first guesses to be really on screen
  useEffect(() => {
    if (image && showGuesses && visible.length > 0) tourEvent("guesses");
  }, [image?.id, showGuesses, visible.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // screen readers: a new image is announced with what Pixel thinks of it
  const lineRef = useRef("");
  lineRef.current = pixelLine ?? "";
  useEffect(() => {
    if (image) say(`Image ${position + 1}. Pixel: ${lineRef.current}`);
  }, [image?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (finished) {
    return (
      <div className="mx-auto max-w-md space-y-6 pt-10 text-center">
        <div className="relative">
          <PixelBurst trigger={1} count={28} />
          <PixelSays vertical mood="proud" size={140} bounce={1}>
            {`That's all I have for now! You taught me ${taught} images, I changed my mind on ${harvest} more, and my best streak was ${bestCombo}.`}
          </PixelSays>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {sessionId && (
            <Button asChild variant="pixel"><Link href={`/recap?s=${sessionId}`} onClick={endLesson}><Flag /> Before / after</Link></Button>
          )}
          <Button asChild variant={sessionId ? "outline" : "pixel"}><Link href="/batch"><Sprout /> Go to the harvest</Link></Button>
          <Button asChild variant="outline"><Link href="/overview">Overview</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card px-4 py-3 shadow-sm">
        <h1 className="text-lg font-bold tracking-tight">Lesson</h1>
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
          image {position + 1} · {taught} taught
        </span>
        {combo >= 2 && (
          <span key={combo} className="flex animate-in zoom-in-50 items-center gap-1 rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-3 py-1 text-xs font-bold text-white shadow duration-300">
            <Flame className="h-3.5 w-3.5" /> Combo ×{combo}
          </span>
        )}
        <span className="hidden items-center gap-1 rounded-full bg-pixel/10 px-3 py-1 text-xs font-medium text-pixel md:flex">
          <Sparkles className="h-3.5 w-3.5" /> click an object for a magic box
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span data-tour="leverage"><LeverageCounter value={harvest} /></span>
          {harvest > 0 && (
            <Button asChild size="sm" variant="secondary"><Link href="/batch"><Sprout /> Harvest</Link></Button>
          )}
          {sessionId && (
            <Button asChild size="sm" variant="outline" title="End the lesson and see what changed: my score at the start vs now">
              <Link href={`/recap?s=${sessionId}`} onClick={endLesson} data-tour="end-lesson"><Flag /> End lesson</Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className={cn("flex flex-col overflow-hidden",
          focus ? "fixed inset-0 z-50 rounded-none border-0" : "h-[72vh] min-h-[420px] lg:h-[calc(100dvh-9.5rem)]")}>
          {/* canvas toolbar */}
          <div className="flex flex-wrap items-center gap-1.5 border-b bg-card px-3 py-2 text-sm">
            <ToolButton title="Undo (Ctrl+Z)" onClick={undo} disabled={!past.current.length}><Undo2 /></ToolButton>
            <ToolButton title="Redo (Ctrl+Y)" onClick={redo} disabled={!future.current.length}><Redo2 /></ToolButton>
            <span className="mx-1 h-5 w-px bg-border" />
            <ToolButton title="Show / hide Pixel's guesses (H)" onClick={() => setShowGuesses((s) => !s)} active={!showGuesses}>
              {showGuesses ? <Eye /> : <EyeOff />}
              <span className="hidden sm:inline">{showGuesses ? "Guesses" : "Guesses hidden"}</span>
              {visible.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{visible.length}</span>}
            </ToolButton>
            <span className="text-xs text-muted-foreground">
              {boxes.length} {boxes.length === 1 ? "box" : "boxes"}
              {selectedBox && <> · selected <b style={{ color: byId.get(selectedBox.class_id)?.color }}>{name(selectedBox.class_id)}</b></>}
            </span>
            {focus && pixelLine && (
              <span className="hidden min-w-0 flex-1 items-center gap-2 truncate px-2 text-xs text-muted-foreground lg:flex">
                <PixelAvatar mood={mood} size={22} /> <span className="truncate">{cheer ?? pixelLine}</span>
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {focus && <LeverageCounter value={harvest} />}
              <ToolButton title={focus ? "Leave focus mode (F)" : "Focus mode: the image fills the screen (F)"} onClick={() => setFocus((f) => !f)}>
                {focus ? <Minimize /> : <Expand />}<span className="hidden sm:inline">{focus ? "Exit focus" : "Focus"}</span>
              </ToolButton>
            </div>
          </div>

          {image ? (
            <BoxCanvas
              className="min-h-0 flex-1"
              src={fileUrl(image.url)} classes={classes} boxes={boxes} proposals={showGuesses ? visible : []}
              activeClassId={activeClass} selectedKey={selected}
              onAddBox={addDrawnBox} onPointClick={magicBox} pending={seeking}
              onSelect={setSelected} onChangeBox={moveBox} onChangeClass={setBoxClass} onDeleteBox={deleteBox}
              onAcceptProposal={accept} onRejectProposal={reject}
              focusedProposalId={showGuesses ? guessFocus : null}
              onVisibleChange={(g) => { visibleArea.current = g; }}
              label={`Image ${position + 1}: ${boxes.length} ${boxes.length === 1 ? "box" : "boxes"}, ${showGuesses ? visible.length : 0} ${visible.length === 1 ? "guess" : "guesses"} from Pixel`}
              describedBy="canvas-help"
            />
          ) : (
            <div className="canvas-grid flex min-h-0 flex-1 items-center justify-center">
              <p className="max-w-sm px-6 text-center text-white/70" role="status">
                {error ?? (waiting ? "I'm still looking at your images for the first time: the first one is almost ready…" : "Loading…")}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t bg-card px-3 py-2.5">
            <span data-tour="classes-bar" className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{selectedBox ? "Change to" : "Draw"}</span>
            {classes.map((c, i) => {
              const on = selectedBox ? selectedBox.class_id === c.id : activeClass === c.id;
              return (
                <button key={c.id} type="button" onClick={() => {
                  if (selectedBox) { if (selectedBox.class_id !== c.id) setBoxClass(selectedBox.key, c.id); }
                  else setActiveClass(c.id);
                }}
                  title={selectedBox ? `Change the selected box to ${c.name}` : `Draw ${c.name} boxes`}
                  className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition",
                    on ? "text-white shadow-sm" : "hover:bg-accent", selectedBox && !on && "border-dashed")}
                  style={on ? { backgroundColor: c.color, borderColor: c.color } : undefined}>
                  {!on && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />}
                  {i < 9 && <kbd className="text-[10px] opacity-90">{i + 1}</kbd>}{c.name}
                </button>
              );
            })}
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => acceptAll(visible)} disabled={!visible.length || !showGuesses}><Check /> Correct <Kbd>A</Kbd></Button>
              <Button variant="outline" size="sm" onClick={() => rejectAll(visible)} disabled={!visible.length || !showGuesses}><X /> Not there <Kbd>X</Kbd></Button>
              <Button variant="ghost" size="sm" onClick={skip}><SkipForward /> Skip <Kbd>S</Kbd></Button>
              <Button variant="pixel" size="sm" onClick={save} disabled={busy || !image} data-tour="save">Save &amp; next <ArrowRight /> <Kbd>⏎</Kbd></Button>
            </div>
          </div>
          {error && image && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{error}</p>}
          {/* screen readers: what each keyboard action did, and how the canvas works */}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{announce}</p>
          <p id="canvas-help" className="sr-only">
            Keyboard: N adds a box of the active class, Tab walks through your boxes, arrows move the selected box,
            Control plus arrows resize it, 1 to 9 change its class, Delete removes it. G walks through Pixel&apos;s guesses,
            A accepts and X rejects the highlighted one, or all of them when none is highlighted. Plus and minus zoom,
            0 fits the image. Enter saves and goes to the next image, S skips it.
          </p>
        </Card>

        <aside className="space-y-4">
          {boxes.length > 0 && (
            <Card>
              <CardContent className="space-y-2 pt-4">
                <p className="flex items-center justify-between text-sm font-medium">
                  Your boxes <span className="text-xs font-normal text-muted-foreground">Tab to step through</span>
                </p>
                <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                  {boxes.map((b, i) => {
                    const c = byId.get(b.class_id);
                    const corrected = b.proposal_class_id != null && b.proposal_class_id !== b.class_id;
                    return (
                      <li key={b.key}
                        className={cn("flex items-center gap-2 rounded-lg border px-2 py-1 text-sm transition",
                          selected === b.key ? "border-pixel/50 bg-pixel/10" : "border-transparent hover:bg-accent")}>
                        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelected(selected === b.key ? null : b.key)}>
                          <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: c?.color }} />
                          <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                          {corrected && <span className="truncate text-[11px] text-amber-600 dark:text-amber-400" title="You corrected Pixel's class: this teaches it the most">was {name(b.proposal_class_id)}</span>}
                        </button>
                        <select value={b.class_id} aria-label="Class of this box"
                          onChange={(e) => setBoxClass(b.key, Number(e.target.value))}
                          className="h-7 max-w-[8.5rem] rounded-md border bg-background px-1.5 text-xs">
                          {classes.map((cl) => <option key={cl.id} value={cl.id}>{cl.name}</option>)}
                        </select>
                        <button type="button" title="Delete" aria-label={`Delete box ${i + 1}`} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => deleteBox(b.key)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="relative flex justify-center bg-gradient-to-b from-pixel/15 to-card pb-1 pt-6 dark:from-pixel/20">
              <PixelBurst trigger={burst} />
              <PixelAvatar mood={mood} size={104} bounce={bounce} />
            </div>
            <CardContent className="space-y-3 pt-3">
              {!classes.length ? (
                <div className="bubble">
                  Before starting, create at least one class on the <Link className="underline" href="/#classes">Overview</Link>.
                </div>
              ) : pixelLine && (
                <div className="bubble">
                  <span className="absolute -top-[7px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-pixel/25 bg-card" />
                  <Typewriter key={image?.id} text={cheer ?? pixelLine} />
                </div>
              )}
              {feedback && (
                <div key={feedback + taught} role="status"
                  className="animate-in zoom-in-95 fade-in rounded-xl bg-gradient-to-r from-amber-100 to-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 duration-300 dark:from-amber-950/60 dark:to-amber-900/30 dark:text-amber-100 dark:ring-amber-800/60">
                  ⚡ {feedback}
                </div>
              )}
              {visible.length > 0 && (
                <ul className="space-y-2 pt-1" data-tour="guesses">
                  {visible.map((p) => (
                    <li key={p.id} className={cn("space-y-1 rounded-lg text-xs", guessFocus === p.id && "bg-pixel/10 ring-2 ring-pixel")}
                      aria-current={guessFocus === p.id ? "true" : undefined}>
                      <div className="flex justify-between font-medium">
                        <span style={{ color: byId.get(p.class_id)?.color }}>{name(p.class_id)}</span>
                        <span className="text-muted-foreground" title="How often guesses like this were right lately">
                          {LEVEL_LABEL[p.level]}
                          {p.track && p.track.total >= 10 ? ` · ${p.track.right}/${p.track.total} right` : ""}
                        </span>
                      </div>
                      {p.detector && (
                        <p className={cn("text-[11px]", p.detector.class_id == null ? "text-muted-foreground"
                          : p.detector.class_id === p.class_id ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}
                          title="Your trained detector's opinion (its own score, not a probability)">
                          {p.detector.class_id == null ? "Detector: saw nothing here"
                            : p.detector.class_id === p.class_id ? `Detector agrees · ${p.detector.score.toFixed(2)}`
                            : `Detector says “${name(p.detector.class_id)}” · ${p.detector.score.toFixed(2)}`}
                        </p>
                      )}
                      <div className="flex gap-0.5">
                        {(["unsure", "fair", "sure"] as const).map((lv, i) => (
                          <div key={lv} className="h-1.5 flex-1 rounded-full"
                            style={{ backgroundColor: i <= ["unsure", "fair", "sure"].indexOf(p.level) ? byId.get(p.class_id)?.color : "hsl(var(--muted))" }} />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {similar.length > 0 && (
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="text-sm font-medium">It reminds me of these examples you taught me</p>
                <div className="grid grid-cols-3 gap-2">
                  {similar.map((s) => (
                    <Link key={s.image_id} href={`/images/${s.image_id}`} target="_blank" className="space-y-0.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fileUrl(s.thumb_url)} alt="" className="aspect-square w-full rounded-lg object-cover ring-1 ring-border" />
                      <div className="flex gap-0.5">
                        {s.classes.map((c) => (
                          <span key={c} className="truncate rounded px-1 text-[10px] text-white" style={{ backgroundColor: byId.get(c)?.color }}>
                            {byId.get(c)?.name}
                          </span>
                        ))}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <details className="group rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-foreground">
              <Keyboard className="h-4 w-4" /> Shortcuts
            </summary>
            <div className="mt-2 space-y-1.5">
              <p><Kbd>click</Kbd> an object: Pixel draws the box for you (<Kbd>Alt</Kbd>+click inside a box too)</p>
              <p><Kbd>drag</Kbd> draw a box with the active class{snap ? " (snaps to the object)" : ""}</p>
              <p><Kbd>click</Kbd> a box to select it, then drag it or its handles · <Kbd>←↑→↓</Kbd> nudge (<Kbd>Shift</Kbd> = more)</p>
              <p><Kbd>N</Kbd> new box from the keyboard · <Kbd>Ctrl</Kbd>+<Kbd>←↑→↓</Kbd> resize the selected box</p>
              <p><Kbd>1-9</Kbd> pick the class (or change the selected box&apos;s class) · <Kbd>Tab</Kbd> next box (on the image)</p>
              <p><Kbd>G</Kbd> next guess · <Kbd>A</Kbd> accept · <Kbd>X</Kbd> reject (the highlighted guess, or all) · <Kbd>H</Kbd> hide them</p>
              <p><Kbd>Ctrl</Kbd>+<Kbd>K</Kbd> command palette</p>
              <p><Kbd>wheel</Kbd> or <Kbd>+</Kbd> <Kbd>-</Kbd> zoom · <Kbd>0</Kbd> fit · <Kbd>Space</Kbd>+drag move around</p>
              <p><Kbd>F</Kbd> focus mode · <Kbd>Ctrl+Z</Kbd> undo · <Kbd>Ctrl+Y</Kbd> redo</p>
              <p><Kbd>Del</Kbd> delete the selected box · <Kbd>Esc</Kbd> deselect</p>
              <p><Kbd>⏎</Kbd> save &amp; next · <Kbd>S</Kbd> skip</p>
              <p className="pt-1">Saving tells Pixel every object here is boxed: everything else it looked at
                (pieces, piles, clutter) becomes an example of &ldquo;not an object&rdquo;. Unsure? Skip instead.</p>
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}

function ToolButton({ children, title, onClick, disabled, active }: {
  children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; active?: boolean;
}) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className={cn("flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition hover:bg-accent disabled:pointer-events-none disabled:opacity-35 [&_svg]:h-4 [&_svg]:w-4",
        active && "bg-accent text-foreground")}>
      {children}
    </button>
  );
}
