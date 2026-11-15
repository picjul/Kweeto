"use client";

import { Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** ⚡ counter: images Pixel changed its mind about thanks to you in this session. */
export function LeverageCounter({ value, className }: { value: number; className?: string }) {
  const [bump, setBump] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (value > prev.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 460);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return (
    <div title="Images Pixel changed its mind about thanks to your teaching"
      className={cn("inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
        bump && "animate-bump", className)}>
      <Zap className="h-4 w-4 fill-amber-500 text-amber-500" />×{value}
    </div>
  );
}
