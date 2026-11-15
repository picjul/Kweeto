"use client";

import { FileInput, FolderOpen, ImagePlus, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AnalysisDone, AnalysisStatus, isAnalysing } from "@/components/analysis-status";
import { DemoButton } from "@/components/demo";
import { Aurora } from "@/components/fx";
import { PageHeader } from "@/components/page-header";
import { PixelAvatar, PixelBurst, Typewriter, type PixelMood } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { api, type Stats } from "@/lib/api";
import { cn } from "@/lib/utils";

const CHUNK = 25;
const IMAGE_RE = /\.(jpe?g|png|webp|bmp)$/i;

export default function UploadPage() {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [result, setResult] = useState({ uploaded: 0, duplicates: 0, rejected: 0 });
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [burst, setBurst] = useState(0);
  const wasRunning = useRef(false);

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    const tick = () => api.stats().then(setStats).catch(() => undefined);
    tick();
    const t = setInterval(tick, 1500);
    return () => clearInterval(t);
  }, []);

  // celebrate when the analysis finishes
  useEffect(() => {
    const running = !!stats?.worker.running;
    if (wasRunning.current && !running) setBurst((b) => b + 1);
    wasRunning.current = running;
  }, [stats]);

  const send = async (list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list).filter((f) => IMAGE_RE.test(f.name));
    if (!files.length) return;
    setError(null);
    setProgress({ sent: 0, total: files.length });
    const acc = { uploaded: 0, duplicates: 0, rejected: 0 };
    try {
      for (let i = 0; i < files.length; i += CHUNK) {
        const r = await api.upload(files.slice(i, i + CHUNK));
        acc.uploaded += r.uploaded;
        acc.duplicates += r.duplicates;
        acc.rejected += r.rejected;
        setResult({ ...acc });
        setProgress({ sent: Math.min(files.length, i + CHUNK), total: files.length });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const w = stats?.worker;
  const uploading = progress && progress.sent < progress.total;
  const mood: PixelMood = over ? "surprised" : uploading || w?.running ? "thinking" : burst ? "proud" : stats && stats.images.total > 0 ? "happy" : "curious";
  const line = over ? "Ooh, drop them right here!"
    // no live counts in the bubble: the progress cards below show them (a changing sentence is distracting)
    : uploading ? "Receiving your images…"
    : w?.running && w.phase === "loading" ? "Waking up my eyes (loading the vision models)…"
    : w?.running ? "Upload done. Now I'm looking at your images one by one: you can follow the progress below."
    : stats && stats.images.total > 0 ? `I've seen ${stats.images.total} images. Ready to learn whenever you are.`
    : "Show me your images. I'll look at each of them once, then you can teach me what they contain.";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader icon={<UploadCloud />} title="Upload" description="JPG, PNG, WEBP or BMP. Exact duplicates are skipped."
        actions={<Button asChild variant="outline" size="sm" className="rounded-full">
          <Link href="/import" title="COCO, YOLO, Pascal VOC, Label Studio, CVAT"><FileInput /> Already labelled? Import it</Link>
        </Button>} />
      {stats && stats.images.total === 0 && !uploading && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-dashed bg-card px-4 py-3 text-sm">
          <p className="flex-1 text-muted-foreground">No images at hand? The demo project has 36 ready to teach, with a short tour.</p>
          <DemoButton size="sm" label="Try the demo project" />
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
        className={cn("relative overflow-hidden rounded-[2rem] border-2 border-dashed bg-card p-10 text-center transition",
          over ? "scale-[1.01] border-pixel shadow-2xl shadow-pixel/20" : "border-border")}
      >
        <Aurora className={cn("transition-opacity", over ? "opacity-80" : "opacity-40")} />
        <div className="relative flex flex-col items-center gap-5">
          <div className="relative">
            <PixelBurst trigger={burst} count={30} />
            <PixelAvatar mood={mood} size={130} bounce={burst} />
          </div>
          <div className="bubble glass max-w-lg text-base"><Typewriter text={line} /></div>
          <div className="flex flex-wrap justify-center gap-3">
            <Button variant="pixel" size="lg" className="rounded-full shadow-lg shadow-pixel/25" onClick={() => folderRef.current?.click()}>
              <FolderOpen /> Choose a folder
            </Button>
            <Button variant="outline" size="lg" className="rounded-full bg-card" onClick={() => filesRef.current?.click()}>
              <ImagePlus /> Choose files
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">…or drag &amp; drop images anywhere in this box</p>
          <input ref={folderRef} type="file" multiple hidden onChange={(e) => send(e.target.files)} />
          <input ref={filesRef} type="file" multiple accept="image/*" hidden onChange={(e) => send(e.target.files)} />
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {progress && (
          <ProgressCard title="Uploading" done={progress.sent} total={progress.total}
            hint={`${result.uploaded} uploaded · ${result.duplicates} duplicates · ${result.rejected} rejected`} color="bg-sky-500" />
        )}
      </div>
      {stats && isAnalysing(stats) && <div className="mt-4"><AnalysisStatus stats={stats} variant="card" /></div>}
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

      {stats && stats.images.total > 0 && !isAnalysing(stats) && !uploading && (
        <div className="mt-6 space-y-3">
          {burst > 0 && stats.worker.last && (
            <AnalysisDone count={stats.worker.last.count} seconds={stats.worker.last.seconds} onClose={() => setBurst(0)} />
          )}
          <div className="flex animate-in fade-in slide-in-from-bottom-2 items-center justify-between rounded-2xl border bg-card p-4 shadow-sm">
            <p className="text-sm">All {stats.images.total} images analysed: embeddings ready.</p>
            <Button asChild variant="pixel" className="rounded-full"><Link href="/overview">Go to the overview</Link></Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressCard({ title, done, total, hint, color }: { title: string; done: number; total: number; hint?: string; color: string }) {
  return (
    <div className="space-y-2 rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex justify-between text-sm font-medium"><span>{title}</span><span className="tabular-nums">{done}/{total}</span></div>
      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
