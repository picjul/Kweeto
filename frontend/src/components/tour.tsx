"use client";

import { ArrowRight, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { navStart } from "@/components/nav-progress";
import { PixelAvatar, type PixelMood } from "@/components/pixel";
import { usePixelTraits, useProject } from "@/components/project-context";
import { Button } from "@/components/ui/button";
import { play } from "@/lib/sound";

/**
 * The guided tour (started by the demo project, or from the command palette): coach marks on the real UI.
 *
 * Steps that ask for an action wait for it (the Lesson emits `tourEvent(...)` when a box is added, an image is
 * saved, Pixel's guesses appear), so the tour never claims something that did not happen (product rule 2): the
 * "look, it is guessing" step only shows once guesses are really on screen. The spotlight never blocks the page.
 * State lives in localStorage, so a reload or a page change resumes where you were.
 */

const KEY = "kweeto-tour";
const EVENT = "kweeto:tour";
const CHANGED = "kweeto:tour-changed";

type TourEventType = "box" | "saved" | "guesses";
type TourState = { step: number; counts: Partial<Record<TourEventType, number>> };

type Step = {
  page: string;
  /** CSS selector of the element to highlight (data-tour="...") */
  target?: string;
  title: string;
  text: (name: string, images: number) => string;
  mood?: PixelMood;
  /** wait for N events of this type (counted since the tour started) instead of a Next button */
  wait?: { type: TourEventType; count: number };
  /** Next navigates here; arriving here by any other way also moves the tour on */
  goto?: string;
};

const STEPS: Step[] = [
  { page: "/overview", target: '[data-tour="pixel"]', title: "Meet your apprentice", mood: "happy",
    text: (n, k) => `Hi! I'm ${n}. This demo project has ${k} synthetic images of tomatoes, limes and pipes, and nothing `
      + "is labelled: I know nothing yet. Teach me and watch me learn." },
  { page: "/overview", target: '[data-tour="classes"]', title: "Three classes, ready", mood: "curious",
    text: () => "Tomato, lime and pipe are already here. In your own projects you create the classes right here." },
  { page: "/overview", target: '[data-tour="start"]', title: "Start a lesson", goto: "/annotate",
    text: () => "A lesson shows you one image at a time, the ones I can learn the most from." },
  { page: "/annotate", target: '[data-tour="classes-bar"]', title: "Pick a class", mood: "curious",
    text: () => "This is what you are boxing. Keys 1, 2 and 3 switch between tomato, lime and pipe." },
  { page: "/annotate", target: "[data-canvas]", title: "Click an object", mood: "curious", wait: { type: "box", count: 1 },
    text: () => "Click on an object of that class: I draw a tight box around it. You can also drag to draw one yourself." },
  { page: "/annotate", target: '[data-tour="save"]', title: "Box them all, then save", wait: { type: "saved", count: 1 },
    text: () => "Box every tomato, lime and pipe in this image (switch class with 1 to 3), then Save & next, or press Enter." },
  { page: "/annotate", target: "[data-canvas]", title: "Keep going", mood: "thinking", wait: { type: "guesses", count: 1 },
    text: () => "Good! Teach me another image or two the same way. I learn from every box, and from what you leave "
      + "unboxed too. As soon as I have seen enough, my guesses appear as dashed boxes." },
  { page: "/annotate", target: '[data-tour="guesses"]', title: "My guesses", mood: "proud",
    text: () => "Those dashed boxes are my guesses, with how sure I am. A accepts them all, X rejects them, and fixing a "
      + "wrong class teaches me the most." },
  { page: "/annotate", target: '[data-tour="leverage"]', title: "The ⚡ counter", mood: "happy",
    text: () => "Every time you teach me, I look at all the other images again. ⚡ counts how many of them I changed my mind about." },
  { page: "*", target: '[data-tour="palette"]', title: "Everything from the keyboard",
    text: () => "Ctrl+K (⌘K on a Mac) opens the command palette: any page, any action, any image by name." },
  { page: "*", title: "That's the loop", mood: "proud",
    text: (n) => `Teach a few images, accept my guesses, and when I'm sure the Harvest lets you approve dozens at once. `
      + `When you're ready, create a project with your own images. ${n} out!` },
];

function read(): TourState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TourState) : null;
  } catch {
    return null;
  }
}

function write(s: TourState | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the tour lasts this page only */ }
  window.dispatchEvent(new Event(CHANGED));
}

export function startTour() {
  write({ step: 0, counts: {} });
}

export function stopTour() {
  write(null);
}

/** Called by the pages when something the tour may wait for happens. */
export function tourEvent(type: TourEventType) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: type }));
}

type Rect = { top: number; left: number; width: number; height: number };

export function Tour() {
  const path = usePathname();
  const router = useRouter();
  const { project } = useProject();
  const pixel = usePixelTraits();
  const [state, setState] = useState<TourState | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => setState(read());
    sync();
    window.addEventListener(CHANGED, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(CHANGED, sync); window.removeEventListener("storage", sync); };
  }, []);

  const step = state ? STEPS[state.step] : undefined;
  const onPage = !!step && (step.page === "*" || step.page === path);

  const go = useCallback((n: number) => {
    const cur = read();
    if (!cur) return;
    if (n >= STEPS.length) { write(null); play("levelup"); return; }
    write({ ...cur, step: n });
  }, []);

  // events from the pages: count them, and move on when the step's wait is satisfied
  useEffect(() => {
    const onEvent = (e: Event) => {
      const type = (e as CustomEvent<TourEventType>).detail;
      const cur = read();
      if (!cur) return;
      const counts = { ...cur.counts, [type]: (cur.counts[type] ?? 0) + 1 };
      const st = STEPS[cur.step];
      const done = st?.wait && st.wait.type === type && (counts[type] ?? 0) >= st.wait.count;
      write({ step: done ? cur.step + 1 : cur.step, counts });
      if (done) play("happy");
    };
    window.addEventListener(EVENT, onEvent);
    return () => window.removeEventListener(EVENT, onEvent);
  }, []);

  // a wait already satisfied (e.g. guesses were on screen before the step came up) moves on at once
  useEffect(() => {
    if (!state || !step?.wait) return;
    if ((state.counts[step.wait.type] ?? 0) >= step.wait.count) go(state.step + 1);
  }, [state, step, go]);

  // arriving on the step's destination by any route moves the tour on
  useEffect(() => {
    if (state && step?.goto && path === step.goto) go(state.step + 1);
  }, [path, state, step, go]);

  // follow the target (layout changes, scrolling, zoom)
  useEffect(() => {
    if (!onPage || !step?.target) { setRect(null); return; }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(step.target!);
      const r = el?.getBoundingClientRect();
      setRect((old) => {
        if (!r || (r.width === 0 && r.height === 0)) return null;
        const next = { top: r.top, left: r.left, width: r.width, height: r.height };
        return old && Math.abs(old.top - next.top) < 1 && Math.abs(old.left - next.left) < 1
          && Math.abs(old.width - next.width) < 1 && Math.abs(old.height - next.height) < 1 ? old : next;
      });
      raf = window.setTimeout(measure, 250);
    };
    const el = document.querySelector(step.target);
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    measure();
    return () => clearTimeout(raf);
  }, [onPage, step, path]);

  // the primary button gets the focus when the step needs a click (never while waiting for the user to act)
  useEffect(() => {
    if (onPage && step && !step.wait) card.current?.querySelector<HTMLButtonElement>("button[data-primary]")?.focus({ preventScroll: true });
  }, [onPage, step]);

  if (!state || !step || !project) return null;

  if (!onPage) { // the tour continues on another page
    return (
      <div role="status" className="fixed bottom-5 right-5 z-[80] flex max-w-xs items-center gap-3 rounded-2xl border bg-card p-3 shadow-2xl animate-in fade-in slide-in-from-bottom-2">
        <PixelAvatar size={36} mood="curious" render="2d" track={false} />
        <p className="flex-1 text-sm">The tour continues in the {step.page === "/annotate" ? "Lesson" : "Overview"}.</p>
        <Button size="sm" variant="pixel" className="rounded-full" onClick={() => { navStart(); router.push(step.page); }}>Go</Button>
        <button type="button" aria-label="End the tour" onClick={stopTour} className="rounded-lg p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
      </div>
    );
  }

  const n = state.step;
  const last = n === STEPS.length - 1;
  const pad = 8;
  const spot: CSSProperties | undefined = rect ? {
    top: rect.top - pad, left: rect.left - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad,
  } : undefined;
  // the card: below the target if there is room, else above, else bottom-right; always inside the window
  const W = 340;
  let cardStyle: CSSProperties = { right: 20, bottom: 20, width: W };
  if (rect && typeof window !== "undefined") {
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(12, Math.min(vw - W - 12, rect.left + rect.width / 2 - W / 2));
    if (rect.top + rect.height + 220 < vh) cardStyle = { top: rect.top + rect.height + pad + 12, left, width: W };
    else if (rect.top > 240) cardStyle = { bottom: vh - rect.top + pad + 12, left, width: W };
    else cardStyle = { right: 20, bottom: 20, width: W };
  }

  const next = () => {
    if (step.goto) { navStart(); router.push(step.goto); return; } // the path effect moves the tour on
    go(n + 1);
  };

  return (
    <>
      {spot && (
        <div aria-hidden className="pointer-events-none fixed z-[79] rounded-2xl ring-4 ring-pixel transition-all duration-300"
          style={{ ...spot, boxShadow: "0 0 0 9999px rgba(10, 8, 30, 0.45)" }} />
      )}
      <div ref={card} role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-text"
        className="fixed z-[81] rounded-2xl border bg-card p-4 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        style={cardStyle}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); stopTour(); } }}>
        <div className="flex items-start gap-3">
          <PixelAvatar size={44} mood={step.mood ?? "idle"} render="2d" track={false} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Tour · {n + 1} of {STEPS.length}
            </p>
            <h2 id="tour-title" className="font-bold">{step.title}</h2>
          </div>
          <button type="button" aria-label="End the tour" onClick={stopTour}
            className="rounded-lg p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <p id="tour-text" className="mt-2 text-sm text-muted-foreground" aria-live="polite">
          {step.text(pixel.name, project.stats.images)}
        </p>
        <div className="mt-3 flex items-center gap-2">
          {n > 0 && !step.wait && <Button size="sm" variant="ghost" onClick={() => go(n - 1)}>Back</Button>}
          {step.wait ? (
            <span className="flex items-center gap-2 text-xs font-medium text-pixel">
              <span className="h-2 w-2 animate-pulse rounded-full bg-pixel" />
              {step.wait.type === "guesses" ? `Your turn · ${state.counts.saved ?? 0} saved` : "Your turn"}
            </span>
          ) : null}
          <span className="flex-1" />
          {step.wait ? (
            <Button size="sm" variant="ghost" onClick={() => go(n + 1)}>Skip this step</Button>
          ) : (
            <Button size="sm" variant="pixel" data-primary className="rounded-full" onClick={last ? stopTour : next}>
              {last ? "Finish" : step.goto ? <>Let&apos;s go <ArrowRight /></> : <>Next <ArrowRight /></>}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
