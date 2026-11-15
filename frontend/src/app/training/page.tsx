"use client";

import { BrainCircuit, CheckCircle2, Cpu, Download, Eye, Loader2, Pause, Play, RotateCcw, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { formatEta } from "@/components/analysis-status";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/page-loading";
import { PixelSays, type PixelMood } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type DetectorModel, type DetectorState, type TrainingEpoch, type TrainingInfo, type TrainingRun } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

const SIZES = [320, 416, 640, 800];
const LIVE = new Set(["preparing", "running"]);
const pct = (v: number | null | undefined) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
const STATE_LABEL: Record<TrainingRun["state"], string> = {
  preparing: "starting", running: "training", done: "done", stopped: "stopped", interrupted: "interrupted", failed: "failed",
};

/** Ad-hoc detector training (LibreYOLO): train a real detector on the finished images, download it. */
export default function TrainingPage() {
  const [info, setInfo] = useState<TrainingInfo | null>(null);
  const [model, setModel] = useState("yolo9-t");
  const [epochs, setEpochs] = useState(100);
  const [imgsz, setImgsz] = useState(640);
  const [patience, setPatience] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [det, setDet] = useState<DetectorState | null>(null);
  const loadDet = useCallback(() => api.stats().then((s) => setDet(s.detector)).catch(() => undefined), []);
  const load = useCallback(() => {
    loadDet();
    return api.training().then(setInfo).catch((e) => setError((e as Error).message));
  }, [loadDet]);
  useEffect(() => { // follow the detector's pass over the images
    if (!det || det.todo === 0) return;
    const t = setInterval(loadDet, 2000);
    return () => clearInterval(t);
  }, [det, loadDet]);
  useEffect(() => { load(); }, [load]);
  const live = info?.runs.find((r) => LIVE.has(r.state));
  useEffect(() => { // follow the run in progress (or check now and then if another project is training)
    const t = setInterval(async () => {
      const prev = live?.state;
      const next = await api.training().catch(() => null);
      if (!next) return;
      const was = live && next.runs.find((r) => r.id === live.id);
      if (prev && was && !LIVE.has(was.state)) play(was.state === "done" ? "done" : "oops");
      setInfo(next);
    }, live ? 2500 : 15000);
    return () => clearInterval(t);
  }, [live?.id, live?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!info) return <div className="mx-auto max-w-5xl"><PageHeader icon={<BrainCircuit />} title="Training" /><PageLoading /></div>;
  const ds = info.dataset;
  const fixedSize = info.models.find((m) => m.id === model)?.fixed_imgsz ?? null;
  const otherProject = info.busy && !live;
  const done = info.runs.find((r) => r.state === "done");
  // while the detector trains, Pixel works out too: warm-up run while preparing, then dumbbells and running in turns
  const activity = !live ? null : live.state === "preparing" || Math.floor(Date.now() / 12000) % 2 ? "run" : "lift";
  const [mood, line]: [PixelMood, string] = live
    ? ["thinking", live.state === "preparing" ? `Warming up: ${live.phase ?? "starting"}…`
      : `Training hard: epoch ${live.epoch ?? 0} of ${live.total_epochs ?? live.epochs}.`]
    : !ds.ready ? ["curious", `To train a real detector I need at least ${ds.min_images} images you finished in a Lesson. ${ds.images} so far.`]
    : done?.best?.map50 != null ? ["proud", `My last detector scored mAP50 ${pct(done.best.map50)} on ${done.dataset.val} images it never studied. Want another round?`]
    : ["happy", `I can study ${ds.images} finished images: ${ds.train} to learn from, ${ds.val} to test myself. It takes a while: a good job for tonight.`];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader icon={<BrainCircuit />} title="Training"
        description="Train a full object detector (LibreYOLO) on the images you finished: run it for hours, download it, use it anywhere." />

      <PixelSays mood={mood} size={110} activity={activity} bubbleClassName="max-w-2xl text-base">{line}</PixelSays>

      {error && (
        <p className="flex items-center gap-2 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          <TriangleAlert className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {!info.available && (
        <p className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {info.unavailable_reason}
        </p>
      )}

      {live && <LiveRun run={live} busy={busy} onStop={() => act(() => api.stopTraining(live.id))} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader><CardTitle>What it learns from</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2 text-center">
              {[["finished images", ds.images], ["to learn", ds.train], ["to test", ds.val]].map(([l, v]) => (
                <div key={l as string} className="rounded-2xl bg-muted px-2 py-3">
                  <p className="text-2xl font-bold tabular-nums">{v}</p><p className="text-xs text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(ds.classes).map(([name, n]) => (
                <span key={name} className="rounded-full bg-pixel/10 px-2.5 py-0.5 text-xs font-medium text-pixel">{name} · {n}</span>
              ))}
              {ds.background > 0 && <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{ds.background} with nothing to find</span>}
            </div>
            <p className="text-xs text-muted-foreground">
              Only images you finished with &ldquo;Save &amp; next&rdquo;: there every object is boxed. The test images are never used
              for learning, so the score you see is honest. Pixel&apos;s own guesses are never used.
            </p>
            {ds.reasons.map((r) => <p key={r} className="text-xs font-medium text-amber-700 dark:text-amber-300">{r}</p>)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>New training</CardTitle>
            {info.device && (
              <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs">
                <Cpu className="h-3.5 w-3.5" /> trains on {info.device}
              </span>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <ModelChooser models={info.models} more={info.more_families ?? []} value={model} onChange={setModel} />
            <div className="grid grid-cols-3 gap-3 text-sm">
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Epochs (max)</span>
                <input type="number" min={1} max={2000} value={epochs} onChange={(e) => setEpochs(Number(e.target.value) || 1)}
                  className="w-full rounded-xl border bg-background px-3 py-2" /></label>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Image size</span>
                <select value={fixedSize ?? imgsz} disabled={!!fixedSize} onChange={(e) => setImgsz(Number(e.target.value))}
                  title={fixedSize ? `This family only runs at ${fixedSize} px` : undefined}
                  className="w-full rounded-xl border bg-background px-3 py-2 disabled:opacity-70">
                  {(fixedSize && !SIZES.includes(fixedSize) ? [...SIZES, fixedSize] : SIZES).map((s) => <option key={s} value={s}>{s} px</option>)}
                </select></label>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Stop if no progress for</span>
                <input type="number" min={0} max={1000} value={patience} onChange={(e) => setPatience(Number(e.target.value) || 0)}
                  className="w-full rounded-xl border bg-background px-3 py-2" /></label>
            </div>
            {info.device === "cpu" && (
              <p className="text-xs text-muted-foreground">
                No CUDA GPU here, so it trains on the CPU: expect hours for bigger models. Perfect overnight. The finished model then
                runs on the app&apos;s ONNX Runtime, GPU included.
              </p>
            )}
            <Button variant="pixel" size="lg" className="w-full rounded-full" disabled={!ds.ready || !!info.busy || busy}
              onClick={() => act(() => api.startTraining({ model, epochs, imgsz: fixedSize ?? imgsz, patience, batch: 8 }))}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />} Start training
            </Button>
            {otherProject && <p className="text-xs text-amber-700 dark:text-amber-300">Another project is training right now: one training at a time.</p>}
          </CardContent>
        </Card>
      </div>

      {det && info.active && (
        <PixelUsesDetector det={det} run={info.runs.find((r) => r.id === info.active)} busy={busy}
          onToggle={() => act(() => api.updateSettings({ use_detector: !det.used }))} />
      )}

      {info.runs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Trained detectors</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {info.runs.map((r) => (
              <RunRow key={r.id} run={r} busy={busy || !!info.busy} active={info.active === r.id}
                onActivate={() => act(() => (info.active === r.id ? api.deactivateTraining() : api.activateTraining(r.id)))}
                onResume={() => act(() => api.resumeTraining(r.id))}
                onDelete={() => { if (confirm("Delete this trained detector and its files?")) act(() => api.deleteTraining(r.id)); }} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LiveRun({ run, busy, onStop }: { run: TrainingRun; busy: boolean; onStop: () => void }) {
  const total = run.total_epochs ?? run.epochs;
  const p = total ? Math.min(100, ((run.epoch ?? 0) / total) * 100) : 0;
  const eta = formatEta(run.eta_s);
  return (
    <Card className="border-pixel/40 shadow-lg shadow-pixel/10">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-pixel" />
          <p className="font-semibold">{run.model_info.title} ({run.model_info.family}-{run.model_info.size}) · {run.device}</p>
          <span className="text-sm tabular-nums text-muted-foreground">
            {run.state === "preparing" ? run.phase : `epoch ${run.epoch ?? 0} / ${total}`}{eta && run.state === "running" ? ` · ${eta}` : ""}
          </span>
          <Button variant="outline" size="sm" className="ml-auto rounded-full" disabled={busy} onClick={onStop}><Pause /> Stop</Button>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-gradient-to-r from-pixel to-pixel/60 transition-all duration-700" style={{ width: `${Math.max(2, p)}%` }} />
        </div>
        <Curve history={run.history} />
        <p className="text-xs text-muted-foreground">
          Score = mAP50 on the {run.dataset.val} test images (never learned from). Stopping keeps the best epoch so far; you can resume later.
        </p>
      </CardContent>
    </Card>
  );
}

/** mAP50 per epoch, as a small line chart. */
function Curve({ history }: { history: TrainingEpoch[] }) {
  const pts = history.filter((h) => h.map50 != null);
  if (pts.length < 2) return <p className="text-sm text-muted-foreground">The learning curve appears after the first epochs.</p>;
  const W = 600, H = 120, n = Math.max(...pts.map((h) => h.epoch));
  const x = (e: number) => 8 + ((e - 1) / Math.max(1, n - 1)) * (W - 16);
  const y = (v: number) => H - 8 - v * (H - 16);
  const best = pts.reduce((a, b) => ((b.map50 ?? 0) > (a.map50 ?? 0) ? b : a));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" role="img" aria-label="mAP50 per epoch">
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={0} x2={W} y1={y(g)} y2={y(g)} className="stroke-border" strokeDasharray="4 4" />)}
        <polyline fill="none" className="stroke-pixel" strokeWidth={2.5} strokeLinejoin="round"
          points={pts.map((h) => `${x(h.epoch)},${y(h.map50 ?? 0)}`).join(" ")} />
        <circle cx={x(best.epoch)} cy={y(best.map50 ?? 0)} r={5} className="fill-amber-400" />
      </svg>
      <p className="text-xs text-muted-foreground">best mAP50 {pct(best.map50)} at epoch {best.epoch} · mAP50-95 {pct(best.map50_95)}</p>
    </div>
  );
}

/** LibreYOLO families (from the backend catalog, plugins included), then the sizes of the chosen one. */
function ModelChooser({ models, more, value, onChange }: {
  models: DetectorModel[]; more: TrainingInfo["more_families"]; value: string; onChange: (id: string) => void;
}) {
  const families: { id: string; models: DetectorModel[] }[] = [];
  for (const m of models) {
    const f = families.find((x) => x.id === m.family_id);
    if (f) f.models.push(m); else families.push({ id: m.family_id, models: [m] });
  }
  const current = models.find((m) => m.id === value);
  const fam = families.find((f) => f.id === current?.family_id) ?? families[0];
  if (!fam) return <p className="text-sm text-muted-foreground">No detector family available.</p>;
  const head = fam.models[0];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {families.map((f) => (
          <button key={f.id} type="button" onClick={() => onChange(f.models[0].id)}
            className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition",
              f.id === fam.id ? "border-pixel bg-pixel text-white" : "hover:bg-accent")}>
            {f.models[0].family}
            {f.models[0].kind === "transformer" && <span className={cn("rounded px-1 text-[9px] font-semibold uppercase",
              f.id === fam.id ? "bg-white/25" : "bg-muted text-muted-foreground")}>DETR</span>}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {head.family_summary} <span className="font-mono">· weights {head.license}</span>
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {fam.models.map((m) => (
          <button key={m.id} type="button" onClick={() => onChange(m.id)}
            className={cn("lift rounded-2xl border p-3 text-left transition",
              value === m.id ? "border-pixel bg-pixel/10 ring-1 ring-pixel" : "hover:bg-accent")}>
            <p className="text-sm font-semibold">{m.title} <span className="font-normal text-muted-foreground">· {m.family}-{m.size}</span></p>
            <p className="mt-0.5 text-xs text-muted-foreground">{m.summary}</p>
          </button>
        ))}
      </div>
      {more.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">LibreYOLO has {more.length} more trainable families</summary>
          <p className="mt-1">
            {more.map((f) => f.family).join(", ")}. They are not offered until their license (code and pretrained
            weights) is checked to be compatible with Apache-2.0: some are non-commercial or GPL. To add one, register it in
            a plugin (see <span className="font-mono">backend/plugins/_example_plugin.py</span>).
          </p>
        </details>
      )}
    </div>
  );
}

/** The active detector as a second opinion in Pixel's guesses: off by default, the teacher decides. */
function PixelUsesDetector({ det, run, busy, onToggle }: {
  det: DetectorState; run: TrainingRun | undefined; busy: boolean; onToggle: () => void;
}) {
  const scanning = det.todo > 0;
  return (
    <Card className={cn(det.used && "border-pixel/50")}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-pixel" /> A second opinion for Pixel</CardTitle>
        <button type="button" role="switch" aria-checked={det.used} disabled={busy} onClick={onToggle}
          className={cn("relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50", det.used ? "bg-pixel" : "bg-muted-foreground/30")}
          title={det.used ? "Pixel uses the detector: click to stop" : "Let Pixel use the detector"}
          aria-label="Let Pixel use the detector as a second opinion">
          <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", det.used ? "left-[1.375rem]" : "left-0.5")} />
        </button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          With this on, Pixel still makes its own guesses from what you taught it, but it also listens to
          {run ? <b className="text-foreground"> {run.model_info.title} ({run.model_info.family}-{run.model_info.size})</b> : " the detector in use"}:
          where the detector sees the same object it gets surer, where it sees another class or nothing it gets humbler,
          and objects the detector found but Pixel&apos;s scan missed become places Pixel looks at. It never proposes
          anything on the detector&apos;s word alone, and it still learns only from your boxes.
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-muted px-2.5 py-1">
            {scanning ? <><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />looking at the images: {det.scanned} done, {det.todo} to go</>
              : <>looked at {det.scanned} {det.scanned === 1 ? "image" : "images"} still to annotate</>}
          </span>
          <span className="rounded-full bg-muted px-2.5 py-1">{det.boxes} boxes found</span>
          <span className="rounded-full bg-muted px-2.5 py-1">{det.regions} new places to look</span>
        </div>
        <p className="text-xs text-muted-foreground">
          On as soon as a detector is in use (in our benchmark it found the objects Pixel&apos;s scan had missed), and you
          can switch it off at any time. Your Lesson shows its opinion next to each guess, and Pixel&apos;s track record
          keeps measuring how often the guesses are right.
        </p>
      </CardContent>
    </Card>
  );
}

function RunRow({ run, busy, active, onActivate, onResume, onDelete }: {
  run: TrainingRun; busy: boolean; active: boolean; onActivate: () => void; onResume: () => void; onDelete: () => void;
}) {
  const live = LIVE.has(run.state);
  const when = run.created_at ? new Date(run.created_at).toLocaleString() : "";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {run.model_info.title} <span className="font-normal text-muted-foreground">· {run.model_info.family}-{run.model_info.size} · {when}</span>
          {active && <span className="ml-2 rounded-full bg-pixel px-2 py-0.5 text-[10px] font-semibold text-white">in use</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          <span className={cn("mr-1.5 rounded-full px-2 py-0.5 font-medium",
            run.state === "done" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : run.state === "failed" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-muted")}>{STATE_LABEL[run.state]}</span>
          {run.best?.map50 != null ? `mAP50 ${pct(run.best.map50)} · mAP50-95 ${pct(run.best.map50_95)} (epoch ${run.best.epoch}) · ` : ""}
          {run.epoch ?? 0}/{run.total_epochs ?? run.epochs} epochs · {run.dataset.images} images · {run.imgsz} px
          {run.stopped_early && run.state === "done" ? " · stopped early (no more progress)" : ""}
        </p>
        {run.error && <p className="mt-1 truncate text-xs text-red-600 dark:text-red-400" title={run.error}>{run.error}</p>}
      </div>
      {run.has_model && !live && (
        <Button variant={active ? "pixel" : "outline"} size="sm" className="rounded-full" disabled={busy && !active} onClick={onActivate}
          title={active ? "Stop using this detector" : "Show this detector's boxes on your images and let Pixel use it as a second opinion"}>
          {active ? <><CheckCircle2 /> In use</> : <><Eye /> Use in Kweeto</>}
        </Button>
      )}
      {run.has_model && !live && (
        <>
          <Button asChild variant="outline" size="sm" className="rounded-full">
            <a href={api.trainingDownloadUrl(run.id, "onnx")}><Download /> ONNX</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="rounded-full">
            <a href={api.trainingDownloadUrl(run.id, "pt")}><Download /> .pt</a>
          </Button>
        </>
      )}
      {run.resumable && <Button variant="outline" size="sm" className="rounded-full" disabled={busy} onClick={onResume}><RotateCcw /> Resume</Button>}
      {!live && <Button variant="ghost" size="icon" aria-label="Delete" onClick={onDelete}><Trash2 /></Button>}
    </div>
  );
}
