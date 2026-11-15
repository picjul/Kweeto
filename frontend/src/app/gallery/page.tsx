"use client";

import { CheckSquare, Images, Square, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CountUp } from "@/components/fx";
import { PageHeader } from "@/components/page-header";
import { PixelSays } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { api, fileUrl, type ImageSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const FILTERS = [
  { key: "", label: "All" },
  { key: "embedded", label: "To teach" },
  { key: "annotated", label: "Annotated" },
  { key: "pending", label: "Analysing" },
  { key: "ignored", label: "Ignored" },
];

const STATUS: Record<string, { label: string; dot: string }> = {
  pending: { label: "analysing", dot: "bg-sky-400" },
  embedded: { label: "to teach", dot: "bg-violet-500" },
  annotated: { label: "annotated", dot: "bg-emerald-500" },
  ignored: { label: "ignored", dot: "bg-zinc-400" },
  error: { label: "error", dot: "bg-rose-500" },
};

const PAGE = 60;

export default function GalleryPage() {
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<ImageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.images({ status, offset: 0, limit: PAGE }).then((r) => { setItems(r.items); setTotal(r.total); setLoaded(true); });
  }, [status]);
  useEffect(() => { load(); }, [load]);

  // while some images are still being analysed, keep their status badges fresh
  const analysing = items.some((i) => i.status === "pending");
  useEffect(() => {
    if (!analysing) return;
    const t = setInterval(() => {
      api.images({ status, offset: 0, limit: Math.max(PAGE, items.length) })
        .then((r) => { setItems(r.items); setTotal(r.total); })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [analysing, status, items.length]);

  const toggle = (id: number) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); setConfirming(false); };
  const removeSelected = async () => {
    setBusy(true);
    try {
      await api.deleteImages([...selected]);
      stopSelecting();
      load();
    } finally {
      setBusy(false);
    }
  };

  const more = async () => {
    const r = await api.images({ status, offset: items.length, limit: PAGE });
    setItems((x) => [...x, ...r.items]);
  };

  return (
    <div>
      <PageHeader icon={<Images />} title="Gallery"
        description={<><CountUp value={total} /> images · click one to see what Pixel thinks and find similar ones</>}
        actions={<>
          {total > 0 && !selecting && (
            <Button variant="outline" className="rounded-full" onClick={() => setSelecting(true)}><CheckSquare /> Select</Button>
          )}
          <Button asChild variant="outline" className="rounded-full"><Link href="/upload"><Upload /> Upload</Link></Button>
        </>} />

      {selecting && (
        <div className="sticky top-14 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-2xl border bg-card/95 px-4 py-2.5 shadow-sm backdrop-blur lg:top-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>Select all shown</Button>
          {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>}
          <div className="ml-auto flex items-center gap-2">
            {!confirming ? (
              <Button size="sm" variant="destructive" disabled={!selected.size} onClick={() => setConfirming(true)}>
                <Trash2 /> Delete
              </Button>
            ) : (
              <>
                <span className="text-sm text-destructive">
                  Delete {selected.size} {selected.size === 1 ? "image" : "images"} with their boxes? This can&apos;t be undone.
                </span>
                <Button size="sm" variant="destructive" disabled={busy} onClick={removeSelected}>Yes, delete</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>No</Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={stopSelecting} aria-label="Done selecting"><X /></Button>
          </div>
        </div>
      )}

      <div className="mb-5 inline-flex flex-wrap rounded-full border bg-card p-1 shadow-sm">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setStatus(f.key)}
            className={cn("rounded-full px-4 py-1.5 text-sm font-medium transition",
              status === f.key ? "bg-pixel text-white shadow" : "text-muted-foreground hover:text-foreground")}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {items.map((it) => {
          const st = STATUS[it.status] ?? STATUS.error;
          return (
            <Link key={it.id} href={`/images/${it.id}`} className="group"
              onClick={(e) => { if (selecting) { e.preventDefault(); toggle(it.id); } }}>
              <div className={cn("lift relative aspect-square overflow-hidden rounded-2xl bg-muted ring-1 ring-border",
                selecting && selected.has(it.id) && "ring-4 ring-destructive")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(it.thumb_url)} alt={it.filename} loading="lazy"
                  className="h-full w-full object-cover transition duration-500 group-hover:scale-110" />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-[11px] text-white">
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className={cn("h-2 w-2 rounded-full ring-2 ring-white/40", st.dot)} />{st.label}
                  </span>
                  {it.box_count > 0 && <span className="rounded-full bg-white/20 px-1.5 backdrop-blur">{it.box_count} box</span>}
                </div>
                {selecting && (
                  <span className="absolute left-2 top-2 rounded-md bg-black/50 p-0.5 text-white backdrop-blur">
                    {selected.has(it.id) ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
                  </span>
                )}
              </div>
              <p className="mt-1.5 truncate px-1 text-xs text-muted-foreground">{it.filename}</p>
            </Link>
          );
        })}
      </div>

      {items.length < total && (
        <div className="mt-6 text-center"><Button variant="outline" className="rounded-full" onClick={more}>Show more</Button></div>
      )}
      {loaded && total === 0 && (
        <div className="flex justify-center py-12">
          <PixelSays vertical mood="curious" size={110} className="max-w-sm">
            Nothing here yet. Upload a folder of images and I&apos;ll have a look.
          </PixelSays>
        </div>
      )}
    </div>
  );
}
