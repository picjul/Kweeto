"use client";

import { Brain, CheckCircle2, Download, ScanSearch, Sparkles } from "lucide-react";

import { PixelAvatar } from "@/components/pixel";
import { usePixelTraits } from "@/components/project-context";
import type { Stats, WorkerProgress } from "@/lib/api";
import { cn } from "@/lib/utils";

export const isAnalysing = (s: Stats | null) => !!s && (s.worker.running || s.images.pending > 0);

export function formatEta(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  if (sec < 20) return "a few seconds left";
  if (sec < 60) return `about ${Math.round(sec / 10) * 10} s left`;
  if (sec < 3600) return `about ${Math.round(sec / 60)} min left`;
  const h = Math.floor(sec / 3600);
  return `about ${h} h ${Math.round((sec - h * 3600) / 60)} min left`;
}

function describe(w: WorkerProgress, pending: number, name: string) {
  if (!w.running) {
    return { icon: <ScanSearch />, title: `${pending} ${pending === 1 ? "image" : "images"} waiting to be analysed`,
      text: `${name} will start in a moment.` };
  }
  switch (w.phase) {
    case "loading":
      return { icon: <Download />, title: `Loading ${name}'s vision models…`,
        text: "The very first time this downloads the models (a few hundred MB), so it can take a few minutes." };
    case "boxes":
      return { icon: <Brain />, title: "Re-learning your boxes with the new models…",
        text: "The engine profile changed: every box you drew gets a new embedding. Nothing you taught is lost." };
    case "detector":
      return { icon: <ScanSearch />, title: "Your trained detector is looking at the images",
        text: `Once per image still to annotate: ${name} can use what it sees as a second opinion (Training page).` };
    case "learning":
      return { icon: <Sparkles />, title: `Updating ${name}'s guesses…`, text: "Almost done." };
    default:
      return {
        icon: <ScanSearch />,
        title: w.kind === "rescan" ? "Re-scanning your images with the new engine" : "Computing the embeddings of your images",
        text: `${name} looks at every image once: it finds the objects in it and computes an embedding for each. `
          + "Images still in the queue get no guesses yet; you can keep working meanwhile.",
      };
  }
}

/** Prominent status of the background analysis. `card` = large (Upload page), `banner` = every other page. */
export function AnalysisStatus({ stats, variant = "banner" }: { stats: Stats; variant?: "banner" | "card" }) {
  const pixel = usePixelTraits();
  const w = stats.worker;
  const d = describe(w, stats.images.pending, pixel.name);
  const indeterminate = !w.running || w.phase === "loading" || w.phase === "boxes" || w.total === 0;
  const pct = w.total ? Math.min(100, Math.round((w.done / w.total) * 100)) : 0;
  const counted = w.phase === "scanning" || w.phase === "detector";
  const eta = counted ? formatEta(w.eta_s) : null;
  const big = variant === "card";

  return (
    <div role="status" aria-live="polite"
      className={cn("relative overflow-hidden rounded-2xl border border-pixel/40 bg-card shadow-lg shadow-pixel/10 animate-in fade-in slide-in-from-top-2",
        big ? "p-6" : "mb-6 p-4")}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-pixel/10 via-transparent to-pixel/5" />
      <div className="relative flex items-center gap-4">
        <PixelAvatar mood="thinking" size={big ? 72 : 48} track={false} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-2 font-semibold text-pixel [&_svg]:h-4 [&_svg]:w-4">{d.icon}{d.title}</span>
            {w.total > 0 && w.running && (
              <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                {counted ? `${w.done} / ${w.total} images · ${pct}%` : `${w.total} images`}
                {eta ? ` · ${eta}` : ""}
              </span>
            )}
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-muted">
            {indeterminate ? (
              <div className="analysis-indeterminate h-full w-1/3 rounded-full bg-pixel" />
            ) : (
              <div className="h-full rounded-full bg-gradient-to-r from-pixel to-pixel/60 transition-all duration-700"
                style={{ width: `${Math.max(3, pct)}%` }} />
            )}
          </div>
          <p className={cn("text-muted-foreground", big ? "text-sm" : "text-xs")}>
            {d.text}
            {w.seconds_per_image != null && w.phase === "scanning" && ` (${w.seconds_per_image.toFixed(1)} s per image on this computer)`}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Short-lived confirmation once the analysis is over. */
export function AnalysisDone({ count, seconds, onClose }: { count: number; seconds: number; onClose: () => void }) {
  const pixel = usePixelTraits();
  const mins = seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
  return (
    <div role="status" className="mb-6 flex animate-in fade-in slide-in-from-top-2 items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100">
      <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <p className="flex-1">
        <b>{pixel.name} has analysed {count} {count === 1 ? "image" : "images"}</b> in {mins}: embeddings ready, guesses updated.
      </p>
      <button type="button" onClick={onClose} className="text-xs font-medium underline-offset-2 hover:underline">Dismiss</button>
    </div>
  );
}
