"use client";

import { Check, FileInput, FolderOpen, HeartPulse, Loader2, RotateCcw, Sparkles, TriangleAlert, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Aurora } from "@/components/fx";
import { PageHeader } from "@/components/page-header";
import { PixelAvatar, PixelBurst, Typewriter } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type ImportFormat, type ImportJob, type ImportPreview } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

const FORMAT_TITLES: Record<ImportFormat, string> = {
  coco: "COCO", yolo: "YOLO", voc: "Pascal VOC", labelstudio: "Label Studio", cvat: "CVAT",
};
const ACCEPT = /\.(jpe?g|png|webp|bmp|json|xml|txt|ya?ml|names|zip)$/i;
const CHUNK_FILES = 40;
const CHUNK_BYTES = 64 * 1024 * 1024;

type Staged = { file: File; path: string };

/** Files of a drop, folders included (with their relative paths: YOLO pairs images/ and labels/ by folder). */
async function filesFromDrop(dt: DataTransfer): Promise<Staged[]> {
  // the entries must be taken synchronously: the DataTransfer is emptied after the event
  const entries = Array.from(dt.items).map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files).map((f) => ({ file: f, path: f.name }));
  const out: Staged[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file: f, path: prefix + f.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export default function ImportPage() {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [sending, setSending] = useState<{ sent: number; total: number } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [format, setFormat] = useState<ImportFormat | null>(null);
  const [complete, setComplete] = useState(true);
  const [emptyNegative, setEmptyNegative] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [burst, setBurst] = useState(0);

  useEffect(() => { folderRef.current?.setAttribute("webkitdirectory", ""); }, []);

  // follow the import job
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const j = await api.importJob(job.id).catch(() => null);
      if (!j) return;
      setJob(j);
      if (j.status !== "running") {
        play(j.status === "done" ? "levelup" : "oops");
        if (j.status === "done" && j.counts.boxes) setBurst((b) => b + 1);
      }
    }, 700);
    return () => clearInterval(t);
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (list: Staged[]) => {
    const files = list.filter((f) => ACCEPT.test(f.path));
    if (!files.length) {
      setError("None of these files can be imported: send images, annotation files (.json, .xml, .txt, .yaml) or a .zip.");
      return;
    }
    setError(null);
    try {
      const id = jobId ?? (await api.createImport()).id;
      setJobId(id);
      setSending({ sent: 0, total: files.length });
      let chunk: Staged[] = [];
      let bytes = 0;
      let sent = 0;
      const flush = async () => {
        if (!chunk.length) return;
        await api.importFiles(id, chunk);
        sent += chunk.length;
        setSending({ sent, total: files.length });
        chunk = [];
        bytes = 0;
      };
      for (const f of files) {
        if (chunk.length >= CHUNK_FILES || (chunk.length && bytes + f.file.size > CHUNK_BYTES)) await flush();
        chunk.push(f);
        bytes += f.file.size;
      }
      await flush();
      const p = await api.importPreview(id, format);
      setPreview(p);
      setFormat(p.format);
      play(p.format ? "happy" : "hello");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(null);
    }
  };

  const switchFormat = async (f: ImportFormat) => {
    if (!jobId) return;
    setFormat(f);
    setPreview(await api.importPreview(jobId, f));
    setSkip(new Set());
  };

  const reset = async () => {
    if (jobId && job?.status !== "done") await api.discardImport(jobId).catch(() => undefined);
    setJobId(null);
    setPreview(null);
    setFormat(null);
    setJob(null);
    setSkip(new Set());
    setError(null);
  };

  const commit = async () => {
    if (!jobId || !preview) return;
    setError(null);
    try {
      const j = await api.commitImport(jobId, { format, complete, empty_negative: emptyNegative, skip_classes: [...skip] });
      setJob(j);
      play("click");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onPick = (list: FileList | null) => {
    if (list) send(Array.from(list).map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  };

  const importing = job && job.status === "running";
  const finished = job && job.status !== "running" && job.status !== "staging";
  const newImages = preview ? preview.images_uploaded - preview.already_here : 0;
  const keptBoxes = preview ? preview.classes.filter((c) => !skip.has(c.name)).reduce((a, c) => a + c.boxes, 0) : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={<FileInput />} title="Import"
        description="Bring a dataset you already labelled, even half of it: COCO, YOLO, Pascal VOC, Label Studio or CVAT. Your boxes become examples, so Pixel starts out already taught." />

      {!preview && !finished && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => { e.preventDefault(); setOver(false); send(await filesFromDrop(e.dataTransfer)); }}
          className={cn("relative overflow-hidden rounded-[2rem] border-2 border-dashed bg-card p-8 text-center transition sm:p-12",
            over ? "border-pixel bg-pixel/5" : "border-border")}>
          <Aurora />
          <div className="relative flex flex-col items-center gap-4">
            <PixelAvatar mood={sending ? "thinking" : over ? "surprised" : "curious"} size={110} />
            <div className="max-w-xl space-y-1">
              <p className="text-lg font-semibold">
                {sending ? `Receiving your files… ${sending.sent} / ${sending.total}` : "Drop the dataset folder or its .zip here"}
              </p>
              <p className="text-sm text-muted-foreground">
                Images and annotation files together. I&apos;ll recognise the format, show you what I found, and import nothing until you say so.
              </p>
            </div>
            {sending ? (
              <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-pixel transition-all" style={{ width: `${Math.max(4, (sending.sent / sending.total) * 100)}%` }} />
              </div>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="pixel" className="rounded-full" onClick={() => folderRef.current?.click()}><FolderOpen /> Choose a folder</Button>
                <Button variant="outline" className="rounded-full" onClick={() => filesRef.current?.click()}><UploadCloud /> Choose files or a .zip</Button>
              </div>
            )}
            <input ref={filesRef} type="file" multiple hidden accept="image/*,.json,.xml,.txt,.yaml,.yml,.names,.zip"
              onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
            <input ref={folderRef} type="file" multiple hidden onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
          </div>
          <div className="relative mt-8 grid gap-2 text-left text-xs text-muted-foreground sm:grid-cols-5">
            {(["coco", "yolo", "voc", "labelstudio", "cvat"] as ImportFormat[]).map((f) => (
              <div key={f} className="rounded-xl bg-muted/60 p-3">
                <p className="font-semibold text-foreground">{FORMAT_TITLES[f]}</p>
                <p>{{
                  coco: "instances_*.json + images",
                  yolo: "images/ + labels/*.txt + data.yaml",
                  voc: "Annotations/*.xml + JPEGImages/",
                  labelstudio: "JSON export (full or MIN)",
                  cvat: "“CVAT for images” XML",
                }[f]}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mt-4 flex items-center gap-2 text-sm text-destructive"><TriangleAlert className="h-4 w-4" /> {error}</p>}

      {preview && !finished && (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                What I found
                {Object.keys(preview.formats).length > 1 && (
                  <span className="text-xs font-normal text-muted-foreground">(several formats: pick one)</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {preview.format == null ? (
                <div className="flex items-start gap-3 rounded-2xl bg-muted/60 p-4 text-sm">
                  <PixelAvatar mood="curious" size={44} track={false} />
                  <p>
                    I received {preview.files} files but no annotations I can read.
                    {preview.images_uploaded > 0 && ` I can still import the ${preview.images_uploaded} images, to teach me from scratch.`}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {(Object.entries(preview.formats) as [ImportFormat, { title: string; images: number; boxes: number }][]).map(([f, info]) => (
                      <button key={f} type="button" onClick={() => switchFormat(f)} disabled={!!importing}
                        className={cn("lift rounded-2xl border px-4 py-2 text-left text-sm transition",
                          format === f ? "border-pixel bg-pixel/10 ring-1 ring-pixel" : "hover:bg-accent")}>
                        <span className="font-semibold">{FORMAT_TITLES[f]}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{info.images} images · {info.boxes} boxes</span>
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Stat n={preview.with_boxes} label="images with boxes" tone="pixel" />
                    <Stat n={preview.boxes} label="boxes" tone="pixel" />
                    <Stat n={preview.classes.length} label={preview.classes.length === 1 ? "class" : "classes"} />
                  </div>

                  <ul className="space-y-1.5 text-sm">
                    {preview.unlabelled > 0 && <Line ok>{preview.unlabelled} images without labels: imported as images still to teach.</Line>}
                    {preview.already_here > 0 && <Line ok>{preview.already_here} of the uploaded images are already in this project: they are not added twice.</Line>}
                    {preview.in_project > 0 && <Line ok>{preview.in_project} annotations match images already in this project.</Line>}
                    {preview.keeps_boxes > 0 && <Line>{preview.keeps_boxes} of those images already have your boxes: they keep yours.</Line>}
                    {preview.listed_empty > 0 && <Line>{preview.listed_empty} images are listed without any box.</Line>}
                    {preview.missing > 0 && (
                      <Line>
                        {preview.missing} annotations point to images I didn&apos;t receive
                        {preview.missing_examples.length > 0 && <> (e.g. <code className="rounded bg-muted px-1 text-xs">{preview.missing_examples[0]}</code>)</>}:
                        add those images, or they are skipped.
                      </Line>
                    )}
                    {preview.warnings.map((w) => <Line key={w}>{w}</Line>)}
                  </ul>

                  {preview.classes.length > 0 && (
                    <div className="overflow-hidden rounded-2xl border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                          <tr><th className="px-3 py-2">Import</th><th className="px-3 py-2">Class</th><th className="px-3 py-2 text-right">Boxes</th><th className="px-3 py-2 text-right">Images</th><th className="px-3 py-2">In this project</th></tr>
                        </thead>
                        <tbody>
                          {preview.classes.map((c) => (
                            <tr key={c.name} className={cn("border-t", skip.has(c.name) && "text-muted-foreground line-through")}>
                              <td className="px-3 py-2">
                                <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--pixel))]" checked={!skip.has(c.name)}
                                  aria-label={`Import ${c.name}`}
                                  onChange={() => setSkip((s) => { const n = new Set(s); if (n.has(c.name)) n.delete(c.name); else n.add(c.name); return n; })} />
                              </td>
                              <td className="px-3 py-2 font-medium">{c.name}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{c.boxes}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{c.images}</td>
                              <td className="px-3 py-2 text-xs">
                                {c.existing ? <span className="text-emerald-600 dark:text-emerald-400">same as “{c.existing}”</span> : <span className="text-muted-foreground">new class</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="space-y-3 rounded-2xl bg-muted/60 p-4 text-sm">
                    <label className="flex items-start gap-3">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--pixel))]" checked={complete}
                        onChange={(e) => setComplete(e.target.checked)} />
                      <span>
                        <b>These images are fully labelled</b>: every object of these classes has a box.
                        <span className="block text-xs text-muted-foreground">
                          Then they count as finished, and what is <i>not</i> boxed teaches me what is not an object. Uncheck it if some objects were left out.
                          {skip.size > 0 && " Images with a class you leave out are not marked finished."}
                        </span>
                      </span>
                    </label>
                    {preview.listed_empty > 0 && (
                      <label className="flex items-start gap-3">
                        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--pixel))]" checked={emptyNegative}
                          onChange={(e) => setEmptyNegative(e.target.checked)} />
                        <span>
                          <b>The {preview.listed_empty} images without boxes really contain no objects</b> (negatives).
                          <span className="block text-xs text-muted-foreground">
                            Many tools list every image of a task, labelled or not: leave it unchecked and they are imported as still to teach.
                          </span>
                        </span>
                      </label>
                    )}
                  </div>
                </>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="pixel" size="lg" className="rounded-full" onClick={commit}
                  disabled={!!importing || (!keptBoxes && !newImages)}>
                  {importing ? <Loader2 className="animate-spin" /> : <Check />}
                  {preview.format ? `Import ${keptBoxes} boxes` : `Import ${newImages} images`}
                  {newImages > 0 && preview.format ? ` · ${newImages} new images` : ""}
                </Button>
                <Button variant="outline" className="rounded-full" disabled={!!importing} onClick={() => filesRef.current?.click()}>
                  <UploadCloud /> Add files
                </Button>
                <Button variant="ghost" className="rounded-full" disabled={!!importing} onClick={reset}><RotateCcw /> Start over</Button>
              </div>
              <input ref={filesRef} type="file" multiple hidden accept="image/*,.json,.xml,.txt,.yaml,.yml,.names,.zip"
                onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
            </CardContent>
          </Card>

          <div className="space-y-4">
            {importing && job && (
              <Card className="border-pixel/40">
                <CardContent className="space-y-2 pt-5">
                  <div className="flex items-center gap-3">
                    <PixelAvatar mood="thinking" size={40} track={false} />
                    <p className="text-sm font-semibold text-pixel">Importing… {job.done} / {job.total}</p>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-pixel transition-all duration-500"
                      style={{ width: `${Math.max(3, job.total ? (job.done / job.total) * 100 : 0)}%` }} />
                  </div>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader><CardTitle className="text-base">What happens</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>Each imported box becomes an example I learn from, just like a box you draw in a Lesson.</p>
                <p>Images already here are matched by content or file name; their boxes are never overwritten.</p>
                <p>Then I study the images as usual: my first guesses on the unlabelled ones come right after.</p>
                <p>Labels made elsewhere can hide mistakes: the <Link href="/health" className="font-medium text-pixel underline-offset-2 hover:underline">Health</Link> page helps you find them.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {finished && job && (
        <div className="relative mx-auto max-w-xl space-y-6 pt-6 text-center">
          <PixelBurst trigger={burst} count={30} />
          <div className="flex justify-center"><PixelAvatar mood={job.status === "done" ? "proud" : "sleepy"} size={140} bounce={burst} /></div>
          <p className="text-lg font-semibold" aria-live="polite">
            {job.status === "done" ? <Typewriter text={job.message ?? "Done."} /> : job.status === "cancelled" ? "Import cancelled." : `The import failed: ${job.error}`}
          </p>
          {job.status === "done" && (
            <p className="text-sm text-muted-foreground">
              {job.counts.images ?? 0} new images · {job.counts.boxes ?? 0} boxes · {job.counts.finished ?? 0} finished images
              {job.counts.classes_new ? ` · ${job.counts.classes_new} new classes` : ""}
              {job.counts.duplicates ? ` · ${job.counts.duplicates} copies of images already here` : ""}
              {job.counts.outside ? ` · ${job.counts.outside} boxes outside their image skipped` : ""}
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {(job.counts.boxes ?? 0) > 0 && (
              <Button asChild variant="pixel"><Link href="/health"><HeartPulse /> Check the imported labels</Link></Button>
            )}
            <Button asChild variant="outline"><Link href="/overview"><Sparkles /> Overview</Link></Button>
            <Button variant="ghost" onClick={reset}><FileInput /> Import more</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "pixel" }) {
  return (
    <div className="rounded-2xl border bg-card p-3">
      <p className={cn("text-2xl font-bold tabular-nums", tone === "pixel" && "text-pixel")}>{n}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Line({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
      <span>{children}</span>
    </li>
  );
}
