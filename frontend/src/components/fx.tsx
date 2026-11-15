"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** Animated blurred colour blobs behind a section (parent must be `relative overflow-hidden`). */
export function Aurora({ variant, className }: { variant?: "emerald"; className?: string }) {
  return (
    <div aria-hidden className={cn("aurora", variant, className)}>
      <span /><span /><span />
    </div>
  );
}

/** Number that counts up to its new value. */
export function CountUp({ value, duration = 700, className }: { value: number; duration?: number; className?: string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    if (a === value) return;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={cn("tabular-nums", className)}>{shown}</span>;
}
