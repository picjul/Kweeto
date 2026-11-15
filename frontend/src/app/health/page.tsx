"use client";

import { Check, Copy, ExternalLink, GraduationCap, HeartPulse, RefreshCw, Ruler, ScanSearch, Trash2, Undo2, Users } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CountUp } from "@/components/fx";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/page-loading";
import { PixelSays } from "@/components/pixel";
import { BoxCrop, ThumbBox } from "@/components/thumb-box";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type HealthBox, type HealthReport, type Suspect } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

type Kind = Suspect["kind"];
const KIND_TITLES: Record<Kind, string> = {
  looks_like: "Look like another class", size: "Odd size", double: "Boxed twice", conflict: "Two classes", tiny: "Slips",
};

export default function HealthPage() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [gone, setGone] = useState<Set<string>>(new Set()); // findings handled on this page (hidden at once)
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await api.health());
      setGone(new Set());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const classes = useMemo(() => new Map((report?.classes ?? []).map((c) => [c.id, c])), [report]);
  const name = (id: number) => classes.get(id)?.name ?? "?";
  const color = (id: number) => classes.get(id)?.color ?? "#7c3aed";

  // an action on a finding: hide it right away, say what happened, refresh in the background
  const act = async (key: string, run: () => Promise<{ message?: string } | unknown>, sound: "proud" | "click" = "click") => {
    setGone((g) => new Set(g).add(key));
    try {
      const r = (await run()) as { message?: string } | undefined;
      if (r && typeof r === "object" && "message" in r && r.message) setNote(r.message);
      play(sound);
    } catch (e) {
      setNote((e as Error).message);
      setGone((g) => { const n = new Set(g); n.delete(key); return n; });
    }
  };

  if (error && !report) return <p className="pt-10 text-center text-sm text-destructive">{error}</p>;
  if (!report) return <PageLoading />;

  const suspects = report.suspects.filter((s) => !gone.has(s.key) && (filter === "all" || s.kind === filter));
  const open = report.suspects.filter((s) => !gone.has(s.key)).length;
  const dups = report.duplicates.filter((g) => !gone.has(dupKey(g.map((i) => i.id))));
  const maxBoxes = Math.max(1, ...report.classes.map((c) => c.boxes));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader icon={<HeartPulse />} title="Health"
        description="Unbalanced classes, near-duplicate images and boxes that look mislabelled. Fixing a wrong label teaches Pixel more than adding a new one."
        actions={<>
          {report.dismissed > 0 && (
            <Button variant="ghost" size="sm" onClick={async () => { await api.restoreFindings(); load(); }}>
              <Undo2 /> Show {report.dismissed} kept {report.dismissed === 1 ? "finding" : "findings"} again
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={busy}><RefreshCw className={cn(busy && "animate-spin")} /> Check again</Button>
        </>} />

      <Card className="overflow-hidden">
        <CardContent className="flex flex-col gap-5 pt-6 lg:flex-row lg:items-center">
          <PixelSays mood={open || dups.length ? "curious" : report.boxes ? "proud" : "idle"} size={72} className="flex-1">
            {note ?? report.pixel_message}
          </PixelSays>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:w-[460px]">
            <Tile n={report.boxes} label="boxes checked" />
            <Tile n={open} label="boxes to check" tone={open ? "amber" : undefined} />
            <Tile n={dups.length} label="duplicate groups" tone={dups.length ? "amber" : undefined} />
            <Tile n={report.images.unfinished} label="unfinished images" />
          </div>
        </CardContent>
      </Card>

      {/* classes */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4 text-pixel" /> Classes</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {report.classes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No classes yet.</p>
          ) : (
            <div className="space-y-2">
              {report.classes.map((c) => (
                <div key={c.id} className="grid grid-cols-[minmax(80px,160px)_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate font-medium" title={c.name}>{c.name}</span>
                  <div className="h-3 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(c.boxes / maxBoxes) * 100}%`, background: c.color, minWidth: c.boxes ? 6 : 0 }} />
                  </div>
                  <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{c.boxes} boxes · {c.images} images</span>
                </div>
              ))}
            </div>
          )}
          {report.balance && (
            <p className={cn("rounded-xl p-3 text-sm", report.balance.skewed ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : "bg-muted/60 text-muted-foreground")}>
              {report.balance.text}
            </p>
          )}
          {report.never_taught.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Never taught: {report.never_taught.map((n) => <b key={n} className="mr-1 text-foreground">“{n}”</b>)}: I can&apos;t look for them yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* suspicious boxes */}
      <Card>
        <CardHeader className="gap-3">
          <CardTitle className="flex items-center gap-2 text-base"><ScanSearch className="h-4 w-4 text-pixel" /> Boxes to check</CardTitle>
          {report.suspects.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Chip on={filter === "all"} onClick={() => setFilter("all")}>All · {open}</Chip>
              {(Object.keys(KIND_TITLES) as Kind[]).filter((k) => report.suspect_counts[k]).map((k) => (
                <Chip key={k} on={filter === k} onClick={() => setFilter(k)}>
                  {KIND_TITLES[k]} · {report.suspects.filter((s) => s.kind === k && !gone.has(s.key)).length}
                </Chip>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {suspects.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {report.boxes < 6 ? "Teach me a few more boxes and I can start comparing them." : "Nothing stands out among your boxes."}
            </p>
          )}
          {suspects.map((s) => (
            <SuspectCard key={s.key} s={s} name={name} color={color} onAct={act} />
          ))}
          {report.suspects_total > report.suspects.length && (
            <p className="text-xs text-muted-foreground">Showing the first {report.suspects.length} of {report.suspects_total}: fix these and check again.</p>
          )}
        </CardContent>
      </Card>

      {/* near-duplicates */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Copy className="h-4 w-4 text-pixel" /> Almost identical images</CardTitle>
          <p className="text-sm text-muted-foreground">
            The same shot resized, recompressed or lightly edited. Teaching both doubles your work, and a copy split between train and validation makes a detector look better than it is.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.duplicates_skipped && <p className="text-sm text-muted-foreground">Too many images to compare them all in one go.</p>}
          {dups.length === 0 && !report.duplicates_skipped && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> No near-duplicates.</p>
          )}
          {dups.map((g) => {
            const key = dupKey(g.map((i) => i.id));
            return (
              <div key={key} className="rounded-2xl border p-3">
                <div className="flex flex-wrap gap-3">
                  {g.map((im) => (
                    <div key={im.id} className={cn("w-36 space-y-1.5", gone.has(`img:${im.id}`) && "opacity-30")}>
                      <Link href={`/images/${im.id}`}><ThumbBox thumbUrl={im.thumb_url} className="aspect-[4/3] [&_img]:h-full [&_img]:object-cover" alt={im.filename} /></Link>
                      <p className="truncate text-xs font-medium" title={im.filename}>{im.filename}</p>
                      <p className="text-[11px] text-muted-foreground">{im.box_count} boxes{im.verified ? " · finished" : ""}</p>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        disabled={gone.has(`img:${im.id}`)}
                        onClick={() => act(`img:${im.id}`, () => api.deleteImage(im.id))}>
                        <Trash2 /> Delete
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => act(key, async () => {
                    const ids = g.map((i) => i.id).sort((a, b) => a - b);
                    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) await api.dismissFinding(`dup:${ids[i]}:${ids[j]}`);
                  })}>
                    <Check /> They&apos;re different, keep all
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* unfinished */}
      {report.images.unfinished > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 pt-6 text-sm">
            <GraduationCap className="h-5 w-5 text-pixel" />
            <p className="min-w-0 flex-1">
              <b>{report.images.unfinished} images have boxes but are not finished.</b>{" "}
              <span className="text-muted-foreground">Until you finish them (every object boxed, then “Save &amp; next”), I can&apos;t learn from what is <i>not</i> an object in them.</span>
            </p>
            <Button asChild variant="pixel" size="sm">
              <Link href={`/annotate?queue=${report.images.unfinished_ids.slice(0, 100).join(",")}`}>Finish them in a Lesson</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const dupKey = (ids: number[]) => `dupgroup:${[...ids].sort((a, b) => a - b).join(",")}`;

function SuspectCard({ s, name, color, onAct }: {
  s: Suspect;
  name: (id: number) => string;
  color: (id: number) => string;
  onAct: (key: string, run: () => Promise<unknown>, sound?: "proud" | "click") => void;
}) {
  const keep = () => onAct(s.key, () => api.dismissFinding(s.key));
  const icon = s.kind === "size" || s.kind === "tiny" ? <Ruler className="h-3.5 w-3.5" /> : s.kind === "looks_like" ? <ScanSearch className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />;
  return (
    <div className="lift grid gap-4 rounded-2xl border bg-card p-3 sm:grid-cols-[180px_1fr]">
      <Link href={`/images/${s.image.id}`} title={`Open ${s.image.filename}`}>
        <BoxCrop url={s.image.url} box={s} color={color(s.class_id)} width={s.image.width} height={s.image.height} alt={`${name(s.class_id)} box`} />
      </Link>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {icon} {KIND_TITLES[s.kind]} · <span className="truncate">{s.image.filename}</span>
          </p>
          <p className="text-sm font-medium">{s.text}</p>
        </div>

        {s.kind === "looks_like" && (
          <div className="flex flex-wrap items-end gap-3">
            <Evidence title={`look like it: “${name(s.suggest_class_id)}”`} boxes={s.like} color={color(s.suggest_class_id)} />
            {s.own && <Evidence title={`closest “${name(s.class_id)}”`} boxes={[s.own]} color={color(s.class_id)} />}
          </div>
        )}
        {(s.kind === "double" || s.kind === "conflict") && (
          <Evidence title="the other box" boxes={[s.other]} color={color(s.other.class_id)} />
        )}

        <div className="mt-auto flex flex-wrap gap-2">
          {s.kind === "looks_like" && (
            <Button size="sm" variant="pixel" onClick={() => onAct(s.key, () => api.relabelBox(s.box_id, s.suggest_class_id), "proud")}>
              It&apos;s “{name(s.suggest_class_id)}”
            </Button>
          )}
          {s.kind === "conflict" && (
            <>
              <Button size="sm" variant="pixel" onClick={() => onAct(s.key, () => api.deleteBox(s.box_id))}>It&apos;s “{name(s.other.class_id)}”</Button>
              <Button size="sm" variant="pixel" onClick={() => onAct(s.key, () => api.deleteBox(s.other.box_id))}>It&apos;s “{name(s.class_id)}”</Button>
            </>
          )}
          {(s.kind === "double" || s.kind === "size" || s.kind === "tiny") && (
            <Button size="sm" variant="outline" className="text-destructive hover:text-destructive"
              onClick={() => onAct(s.key, () => api.deleteBox(s.box_id))}>
              <Trash2 /> {s.kind === "double" ? "Delete one" : "Delete the box"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={keep}><Check /> {s.kind === "double" ? "Keep both" : "It's right"}</Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/annotate?image=${s.image.id}`}><ExternalLink /> Fix in a Lesson</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Evidence({ title, boxes, color }: { title: string; boxes: HealthBox[]; color: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{title}</p>
      <div className="flex gap-1.5">
        {boxes.map((b) => (
          <Link key={b.box_id} href={`/images/${b.image.id}`} className="block w-16" title={b.image.filename}>
            <BoxCrop url={b.image.url} box={b} color={color} width={b.image.width} height={b.image.height} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "amber" }) {
  return (
    <div className="rounded-2xl border bg-card p-3">
      <p className={cn("text-2xl font-bold tabular-nums", tone === "amber" && "text-amber-600 dark:text-amber-400")}><CountUp value={n} /></p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("rounded-full border px-3 py-1 text-xs", on ? "border-pixel bg-pixel text-white" : "bg-card hover:bg-accent")}>
      {children}
    </button>
  );
}
