import { Check } from "lucide-react";

import type { LabelClass } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Examples needed for a class to count as "learned" on the path. */
export const CLASS_TARGET = 30;

/** Pixel's path: each class is a stop with a progress ring. */
export function ClassPath({ classes }: { classes: LabelClass[] }) {
  if (!classes.length) {
    return <p className="text-sm text-muted-foreground">The path is empty: add the first class below.</p>;
  }
  const current = classes.findIndex((c) => c.box_count < CLASS_TARGET);

  return (
    <div className="overflow-x-auto pb-2">
      <ol className="flex min-w-max items-start px-1 py-3">
        {classes.map((c, i) => {
          const p = Math.min(1, c.box_count / CLASS_TARGET);
          const done = p >= 1;
          const isCurrent = i === current;
          const prevDone = i > 0 && classes[i - 1].box_count >= CLASS_TARGET;
          return (
            <li key={c.id} className="flex items-start">
              {i > 0 && (
                <div className="mt-9 h-1.5 w-14 rounded-full"
                  style={{ background: prevDone ? classes[i - 1].color : "hsl(var(--border))" }} />
              )}
              <div className="flex w-28 flex-col items-center gap-2 text-center">
                <Ring progress={p} color={c.color} pulse={isCurrent}>
                  {done ? <Check className="h-6 w-6" style={{ color: c.color }} strokeWidth={3} />
                    : <span className="text-lg font-bold" style={{ color: c.color }}>{c.name.slice(0, 1).toUpperCase()}</span>}
                </Ring>
                <span className="max-w-full truncate text-sm font-semibold">{c.name}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium",
                  done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : isCurrent ? "bg-pixel/10 text-pixel" : "text-muted-foreground")}>
                  {done ? "learned" : isCurrent ? "learn now" : `${c.box_count}/${CLASS_TARGET}`}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Ring({ progress, color, pulse, children }: { progress: number; color: string; pulse?: boolean; children: React.ReactNode }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-[76px] w-[76px]">
      {pulse && <span className="absolute inset-2 animate-ping rounded-full opacity-25" style={{ backgroundColor: color }} />}
      <svg viewBox="0 0 76 76" className="absolute inset-0 -rotate-90">
        <circle cx="38" cy="38" r={r} fill="hsl(var(--card))" stroke="hsl(var(--border))" strokeWidth="7" />
        <circle cx="38" cy="38" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - progress)} style={{ transition: "stroke-dashoffset 600ms ease" }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}
