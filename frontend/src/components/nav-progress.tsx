"use client";

import { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Feedback for page changes: a thin bar at the top starts the moment you click a link (or a page calls
 * `navStart()` before `router.push`, or you go back/forward) and completes when the new page is there.
 * While it runs the cursor shows "progress". Instant navigations just flash the end of the bar.
 */

const START = "kweeto:nav-start";
const SAFETY_MS = 15_000; // never leave the bar running if a navigation is cancelled

/** Call right before `router.push(...)` so programmatic navigations show the bar too. */
export function navStart() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(START));
}

const key = (u: URL) => u.pathname + u.search;

/** Would clicking this anchor make the app router navigate to another page? */
function isPageChange(a: HTMLAnchorElement, e: MouseEvent): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return false;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  const to = new URL(a.href, window.location.href);
  if (to.origin !== window.location.origin) return false;
  if (to.pathname.startsWith("/api/") || to.pathname.startsWith("/files/")) return false;
  return key(to) !== key(new URL(window.location.href));
}

function Bar() {
  const path = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [width, setWidth] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const running = useRef(false);
  const rendered = useRef<string | null>(null); // the URL of the page on screen

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  const start = () => {
    if (running.current) return;
    running.current = true;
    clear();
    setState("running");
    setWidth(8);
    document.documentElement.classList.add("nav-pending");
    // trickle: quick at first, then slower and slower towards 90% (we can't know the real progress)
    let w = 8;
    const tick = () => {
      w = w + (90 - w) * (w < 40 ? 0.25 : 0.08);
      setWidth(w);
      later(tick, 250);
    };
    later(tick, 60);
    later(() => finish(), SAFETY_MS);
  };

  const finish = () => {
    if (!running.current) return;
    running.current = false;
    clear();
    document.documentElement.classList.remove("nav-pending");
    setWidth(100);
    setState("done");
    later(() => { setState("idle"); setWidth(0); }, 350);
  };

  // start: clicks on links (capture phase, before Next handles them), back/forward, navStart()
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (a instanceof HTMLAnchorElement && isPageChange(a, e)) start();
    };
    const onStart = () => start();
    // back/forward: Next may have rendered the page already when this runs; start only if it has not
    const onPop = () => { if (key(new URL(window.location.href)) !== rendered.current) start(); };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    window.addEventListener(START, onStart);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener(START, onStart);
      clear();
      document.documentElement.classList.remove("nav-pending");
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // done: the URL changed, i.e. the new page is rendered
  useEffect(() => {
    rendered.current = key(new URL(window.location.href));
    finish();
  }, [path, search]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "idle") return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]">
      <div
        className={cn("h-full rounded-r-full bg-gradient-to-r from-pixel via-fuchsia-500 to-amber-400 shadow-[0_0_10px_hsl(var(--pixel)/0.7)]",
          state === "done" ? "opacity-0 transition-[width,opacity] duration-300" : "transition-[width] duration-200 ease-out")}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function NavProgress() {
  // useSearchParams needs a Suspense boundary to keep the pages statically rendered
  return <Suspense fallback={null}><Bar /></Suspense>;
}

/** Inside a <Link>: a small spinner while that very link is loading its page. */
export function LinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-hidden className={cn("h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent transition-opacity",
      pending ? "animate-spin opacity-70" : "opacity-0", className)} />
  );
}
