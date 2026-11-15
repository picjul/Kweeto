"use client";

import { Download, Loader2, PackageOpen, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { formatEta } from "@/components/analysis-status";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/page-loading";
import { PixelAvatar } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type ExportFormat, type ExportInfo, type ExportJob } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

const FORMAT_TITLES: Record<ExportFormat, string> = {
  coco: "COCO", yolo: "YOLO", voc: "Pascal VOC", csv: "CSV", masks: "PNG masks",
};
const SPLITS: { label: string; v: [number, number, number] }[] = [
  { label: "All in one", v: [1, 0, 0] },
  { label: "80 / 20", v: [0.8, 0.2, 0] },
  { label: "70 / 20 / 10", v: [0.7, 0.2, 0.1] },
];

export default function ExportPage() {
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [formats, setFormats] = useState<Set<ExportFormat>>(new Set(["coco", "yolo"]));
  const [masks, setMasks] = useState(true);
  const [images, setImages] = useState(true);
  const [scope, setScope] = useState<"annotated" | "boxed">("annotated");
  const [split, setSplit] = useState<[number, number, number]>([0.8, 0.2, 0]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.exports().then(setInfo).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const running = info?.jobs.find((j) => j.status === "queued" || j.status === "running");
  useEffect(() => { // follow a running export
    if (!running) return;
    const t = setInterval(async () => {
      const j = await api.exportJob(running.id).catch(() => null);
      if (j && j.status !== "running" && j.status !== "queued") {
        play(j.status === "done" ? "done" : "oops");
        load();
      } else if (j) {
        setInfo((x) => (x ? { ...x, jobs: x.jobs.map((k) => (k.id === j.id ? j : k)) } : x));
      }
    }, 1000);
    return () => clearInterval(t);
  }, [running?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (f: ExportFormat) => setFormats((s) => {
    const n = new Set(s);
    if (n.has(f)) n.delete(f); else n.add(f);
    if (f === "masks" && !n.has("masks")) return n;
    if (n.has("masks")) setMasks(true);
    return n;
  });

  const start = async () => {
    setError(null);
    try {
      await api.createExport({ formats: [...formats], masks, images, scope, train: split[0], val: split[1], test: split[2] });
      play("click");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!info) return <PageLoading />;
  const c = info.candidates;
  const nImages = scope === "annotated" ? c.annotated : c.boxed;
  const missingMasks = Math.max(0, c.boxes - c.cached_masks);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={<PackageOpen />} title="Export"
        description="Take what you taught out of Kweeto, ready for training: boxes and masks in the usual formats, as one zip." />

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader><CardTitle>Formats</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(info.formats) as ExportFormat[]).map((f) => (
                <button key={f} type="button" onClick={() => toggle(f)}
                  className={cn("lift rounded-2xl border p-4 text-left transition",
                    formats.has(f) ? "border-pixel bg-pixel/10 ring-1 ring-pixel" : "hover:bg-accent")}>
                  <p className="font-semibold">{FORMAT_TITLES[f]}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{info.formats[f]}</p>
                </button>
              ))}
            </div>

            <div className="space-y-3 rounded-2xl bg-muted/60 p-4 text-sm">
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--pixel))]" checked={masks}
                  disabled={formats.has("masks")} onChange={(e) => setMasks(e.target.checked)} />
                <span>
                  <b>Masks</b> (COCO polygons, YOLO segmentation, PNG masks). They are <i>drawn by the segmenter inside your boxes</i>,
                  not by you: check them before training a segmentation model.
                  {masks && missingMasks > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {missingMasks} of {c.boxes} boxes still need a mask: the first export takes a few seconds per image, later ones reuse them.
                    </span>
                  )}
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--pixel))]" checked={images}
                  onChange={(e) => setImages(e.target.checked)} />
                <span><b>Include the images</b> (each format folder is self-contained; uncheck for labels only).</span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Images:</span>
                {([["annotated", `finished or boxed (${c.annotated}), empty ones as negatives`], ["boxed", `only with boxes (${c.boxed})`]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setScope(k)}
                    className={cn("rounded-full border px-3 py-1 text-xs", scope === k ? "border-pixel bg-pixel text-white" : "bg-card")}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Split train / val / test:</span>
                {SPLITS.map((s) => (
                  <button key={s.label} type="button" onClick={() => setSplit(s.v)}
                    className={cn("rounded-full border px-3 py-1 text-xs", split.join() === s.v.join() ? "border-pixel bg-pixel text-white" : "bg-card")}>
                    {s.label}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground">(random but reproducible)</span>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button variant="pixel" size="lg" className="rounded-full" disabled={!!running || !formats.size || !nImages} onClick={start}>
              {running ? <Loader2 className="animate-spin" /> : <Download />}
              Export {nImages} {nImages === 1 ? "image" : "images"} · {c.boxes} boxes
            </Button>
            {!nImages && <p className="text-sm text-muted-foreground">Nothing to export yet: teach a few images first.</p>}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {running && <RunningCard job={running} />}
          <Card>
            <CardHeader><CardTitle className="text-base">Your exports</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {info.jobs.filter((j) => j.status !== "running" && j.status !== "queued").length === 0 && (
                <p className="text-sm text-muted-foreground">None yet.</p>
              )}
              {info.jobs.filter((j) => j.status !== "running" && j.status !== "queued").map((j) => (
                <ExportRow key={j.id} job={j} onDelete={async () => { await api.deleteExport(j.id); load(); }} />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function RunningCard({ job }: { job: ExportJob }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const what = job.phase === "masks" ? "Drawing the masks inside your boxes" : job.phase === "writing" ? "Writing the files" : "Starting…";
  return (
    <Card className="border-pixel/40">
      <CardContent className="space-y-2 pt-5">
        <div className="flex items-center gap-3">
          <PixelAvatar mood="thinking" size={40} track={false} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-pixel">{what}…</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {job.done} / {job.total} images{job.phase === "masks" && job.eta_s != null ? ` · ${formatEta(job.eta_s)}` : ""}
            </p>
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-pixel transition-all duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}

function ExportRow({ job, onDelete }: { job: ExportJob; onDelete: () => void }) {
  const k = job.counts;
  const mb = (job.size / 1024 / 1024).toFixed(job.size > 10 * 1024 * 1024 ? 0 : 1);
  return (
    <div className="space-y-1.5 rounded-xl border p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{job.options.formats.map((f) => FORMAT_TITLES[f]).join(", ")}</span>
        <span className="ml-auto text-xs text-muted-foreground">{new Date(job.created_at).toLocaleString()}</span>
      </div>
      {job.status === "done" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {k.images} images · {k.boxes} boxes{job.options.masks ? ` · masks: ${k.masks_segmenter} drawn, ${k.masks_box_fallback} = box` : ""}
            {k.splits ? ` · ${Object.entries(k.splits).map(([s, n]) => `${s} ${n}`).join(" / ")}` : ""} · {mb} MB
          </p>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="pixel"><a href={api.exportDownloadUrl(job.id)} download><Download /> Download</a></Button>
            <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={onDelete}><Trash2 /></Button>
          </div>
        </>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="h-3.5 w-3.5" /> {job.status === "cancelled" ? "Cancelled" : `Failed: ${job.error}`}
        </p>
      )}
    </div>
  );
}
