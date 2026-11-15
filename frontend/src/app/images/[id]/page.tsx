"use client";

import { ArrowLeft, BrainCircuit, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { BoxCanvas } from "@/components/box-canvas";
import { PageLoading } from "@/components/page-loading";
import { Button } from "@/components/ui/button";
import { navStart } from "@/components/nav-progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, fileUrl, type DetectorView, type ImageDetail, type LabelClass, type SimilarImage, type TrainingRun } from "@/lib/api";
import { cn, pct } from "@/lib/utils";

type View = "pixel" | "detector" | "both";

export default function ImagePage() {
  const { id } = useParams<{ id: string }>();
  const imageId = Number(id);
  const [img, setImg] = useState<ImageDetail | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [similar, setSimilar] = useState<SimilarImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [det, setDet] = useState<DetectorView | null>(null);
  const [detRun, setDetRun] = useState<TrainingRun | null>(null);
  const [detError, setDetError] = useState<string | null>(null);
  const [view, setView] = useState<View>("pixel");
  const router = useRouter();

  const remove = async () => {
    await api.deleteImage(imageId);
    navStart();
    router.push("/gallery");
  };

  useEffect(() => {
    api.classes().then(setClasses);
    api.image(imageId).then(setImg).catch((e) => setError((e as Error).message));
    api.similar(imageId, 18).then(setSimilar).catch(() => setSimilar([]));
    // the project's trained detector, if any (Training page -> "Use in Kweeto")
    api.training().then((t) => {
      const run = t.runs.find((r) => r.id === t.active) ?? null;
      setDetRun(run);
      if (!run) return;
      api.imageDetector(imageId).then(setDet).catch((e) => setDetError((e as Error).message));
    }).catch(() => undefined);
  }, [imageId]);

  if (error) return <p className="text-destructive">{error}</p>;
  if (!img) return <PageLoading label="Loading the image…" />;

  const names = new Map(classes.map((c) => [c.id, c]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="rounded-full"><Link href="/gallery"><ArrowLeft /></Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">{img.filename}</h1>
          <p className="text-sm text-muted-foreground">
            {img.width}×{img.height} · {img.status} · solid = confirmed, dashed = Pixel&apos;s guesses{detRun ? ", thin with the label below = trained detector" : ""}
          </p>
        </div>
        {img.status !== "pending" && (
          <Button asChild variant="pixel" className="rounded-full"><Link href={`/annotate?image=${img.id}`}><Pencil /> Annotate</Link></Button>
        )}
        {!confirmDelete ? (
          <Button variant="ghost" className="rounded-full text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        ) : (
          <span className="flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/5 px-3 py-1 text-sm">
            Delete this image{img.box_count ? ` and its ${img.box_count} boxes` : ""}?
            <Button size="sm" variant="destructive" className="rounded-full" onClick={remove}>Delete</Button>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          </span>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card className="overflow-hidden">
          {detRun && (
            <div className="flex items-center gap-1 border-b px-4 py-2 text-sm">
              <span className="mr-2 text-xs text-muted-foreground">Show</span>
              {([["pixel", "Pixel"], ["detector", "Detector"], ["both", "Both"]] as [View, string][]).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setView(v)}
                  className={cn("rounded-full px-3 py-1 font-medium transition", view === v ? "bg-pixel text-white" : "hover:bg-accent")}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <BoxCanvas readOnly className="h-[65vh] min-h-[360px]" src={fileUrl(img.url)} classes={classes}
            proposals={view === "detector" ? [] : img.proposals}
            detections={view === "pixel" ? [] : det?.boxes ?? []}
            boxes={img.boxes.map((b) => ({ ...b, key: `b${b.id}` }))} />
        </Card>

        <div className="space-y-5">
        {detRun && (
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <BrainCircuit className="h-4 w-4 text-pixel" /><CardTitle className="text-base">Trained detector</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <b>{detRun.model_info.title}</b> <span className="text-muted-foreground">· {detRun.model_info.family}-{detRun.model_info.size}</span>
                {det?.provider && <span className="text-muted-foreground"> · on {det.provider}{det.ms != null ? `, ${det.ms} ms` : ""}</span>}
              </p>
              {detRun.best?.map50 != null && (
                <p className="text-xs text-muted-foreground">
                  mAP50 {pct(detRun.best.map50)} on the {detRun.dataset.val} test images it never studied (of {detRun.dataset.images} finished images).
                </p>
              )}
              {detError && <p className="text-xs text-destructive">{detError}</p>}
              {!det && !detError && <p className="text-xs text-muted-foreground">Looking…</p>}
              {det && (det.boxes.length ? (
                <ul className="space-y-1">
                  {det.boxes.map((b, i) => (
                    <li key={i} className={cn("flex items-center gap-2", b.score < 0.3 && "opacity-50")}>
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: names.get(b.class_id)?.color }} />
                      <span className="flex-1">{b.class_name}</span>
                      <span className="tabular-nums text-xs text-muted-foreground">score {b.score.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted-foreground">It finds nothing here (score at least 0.1).</p>)}
              <p className="text-[11px] text-muted-foreground">
                Scores are the detector&apos;s own, not calibrated: compare them with each other, not as a probability.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">Similar images</CardTitle></CardHeader>
          <CardContent>
            {similar.length === 0 && <p className="text-sm text-muted-foreground">No embeddings yet.</p>}
            <div className="stagger grid grid-cols-3 gap-2.5">
              {similar.map((s) => (
                <Link key={s.image_id} href={`/images/${s.image_id}`} className="group space-y-1">
                  <div className="relative overflow-hidden rounded-xl ring-1 ring-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(s.thumb_url)} alt="" loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-110" />
                    <span className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-[10px] font-semibold text-white backdrop-blur">{pct(s.similarity)}</span>
                  </div>
                  <span className="flex gap-0.5">
                    {s.classes.map((c) => (
                      <span key={c} className="h-1.5 flex-1 rounded-full" title={names.get(c)?.name} style={{ backgroundColor: names.get(c)?.color }} />
                    ))}
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  );
}
