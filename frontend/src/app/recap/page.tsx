"use client";

import { ArrowRight, Clock, GraduationCap, LayoutDashboard, PenLine, Repeat2, Sprout, Trophy, Zap } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { Aurora, CountUp } from "@/components/fx";
import { PageLoading } from "@/components/page-loading";
import { PixelAvatar, PixelBurst, PixelSays, Typewriter } from "@/components/pixel";
import { ThumbBox } from "@/components/thumb-box";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type LabelClass, type Recap, type RecapGuess, type Track } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

export default function RecapPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <RecapView />
    </Suspense>
  );
}

const KIND: Record<Recap["changed"][number]["kind"], string> = {
  new: "Now I see something", gone: "I dropped a guess", class: "Changed class", refined: "Changed which object",
};

/** End of a lesson: Pixel's judged guesses at the start vs the end, and where it changed its mind. */
function RecapView() {
  const params = useSearchParams();
  const sid = Number(params.get("s"));
  const [recap, setRecap] = useState<Recap | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [burst, setBurst] = useState(0);

  useEffect(() => {
    if (!sid) { setError("No lesson to sum up."); return; }
    api.classes().then(setClasses).catch(() => undefined);
    api.endSession(sid).then((r) => {
      setRecap(r);
      const a = r.accuracy;
      if (a && a.after.right / Math.max(1, a.after.total) > a.before.right / Math.max(1, a.before.total)) {
        setBurst(1);
        play("levelup");
      } else {
        play("hello");
      }
    }).catch((e) => setError((e as Error).message));
  }, [sid]);

  const byId = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);

  if (error) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 pt-16 text-center">
        <PixelAvatar mood="sleepy" size={120} />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button asChild variant="pixel"><Link href="/annotate"><GraduationCap /> Start a lesson</Link></Button>
      </div>
    );
  }
  if (!recap) return <PageLoading />;

  const a = recap.accuracy;
  const better = a ? a.after.right / Math.max(1, a.after.total) > a.before.right / Math.max(1, a.before.total) : false;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="relative overflow-hidden rounded-[2rem] border bg-card p-6 shadow-xl shadow-pixel/5 sm:p-8">
        <Aurora />
        <PixelBurst trigger={burst} count={34} />
        <div className="relative space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-pixel">Lesson recap</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> {recap.minutes < 1 ? "under a minute" : `${recap.minutes} min`}
            </p>
          </div>
          <PixelSays mood={better ? "proud" : a ? "thinking" : "curious"} size={84} bounce={burst}>
            <Typewriter text={recap.pixel_message} />
          </PixelSays>

          {a ? (
            <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
              <Score title={a.basis === "session" ? "At the start" : "Before this lesson"} track={a.before} />
              <ArrowRight className={cn("mx-auto h-8 w-8 rotate-90 sm:rotate-0", better ? "text-emerald-500" : "text-muted-foreground")} />
              <Score title={a.basis === "session" ? "By the end" : "During it"} track={a.after} highlight={better} />
            </div>
          ) : (
            <p className="rounded-2xl bg-muted/60 p-4 text-sm text-muted-foreground">
              {recap.judged
                ? `You judged ${recap.judged} of my guesses. After about 10 I can tell you honestly whether I got better.`
                : "You didn't judge any of my guesses this time: accept or reject them in a Lesson and I'll keep score."}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Every guess counted here was judged by you <i>before</i> I learned from it: it&apos;s my real score, not a test on what you just taught me.
          </p>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={<Trophy />} n={recap.finished} label="images finished" />
        <Stat icon={<PenLine />} n={recap.boxes} label="boxes taught" />
        <Stat icon={<Repeat2 />} n={recap.corrections} label={recap.corrections === 1 ? "correction" : "corrections"} />
        <Stat icon={<Zap />} n={recap.propagated} label="⚡ images updated" tone="amber" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where I changed my mind</CardTitle>
          <p className="text-sm text-muted-foreground">
            Images you haven&apos;t taught me yet: what I guessed when the lesson started, and what I guess now.
          </p>
        </CardHeader>
        <CardContent>
          {recap.changed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {recap.snapshot_images === 0 ? "There were no images left to guess on when the lesson started." : "My guesses on the other images didn't change."}
            </p>
          ) : (
            <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {recap.changed.map((c) => (
                <div key={c.image_id} className="lift space-y-2 rounded-2xl border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-full bg-pixel/10 px-2 py-0.5 text-[11px] font-semibold text-pixel">{KIND[c.kind]}</span>
                    <span className="truncate text-[11px] text-muted-foreground" title={c.filename}>{c.filename}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Frame label="then" guesses={c.before} thumb={c.thumb_url} byId={byId} dashed />
                    <Frame label="now" guesses={c.after} thumb={c.thumb_url} byId={byId} />
                  </div>
                  <Button asChild size="sm" variant="ghost" className="h-7 w-full text-xs">
                    <Link href={`/annotate?image=${c.image_id}`}><GraduationCap /> Teach me this one</Link>
                  </Button>
                </div>
              ))}
            </div>
          )}
          {recap.changed_total > recap.changed.length && (
            <p className="mt-3 text-xs text-muted-foreground">…and {recap.changed_total - recap.changed.length} more images.</p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-center gap-2 pb-6">
        <Button asChild variant="pixel" className="rounded-full"><Link href="/annotate"><GraduationCap /> Another lesson</Link></Button>
        <Button asChild variant="outline" className="rounded-full"><Link href="/batch"><Sprout /> Harvest</Link></Button>
        <Button asChild variant="ghost" className="rounded-full"><Link href="/overview"><LayoutDashboard /> Overview</Link></Button>
      </div>
    </div>
  );
}

function Score({ title, track, highlight }: { title: string; track: Track; highlight?: boolean }) {
  return (
    <div className={cn("rounded-2xl border bg-card/80 p-5 text-center", highlight && "border-emerald-500/50 ring-1 ring-emerald-500/40")}>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <p className="mt-1 text-4xl font-bold tabular-nums">
        <span className={cn(highlight && "text-emerald-600 dark:text-emerald-400")}><CountUp value={track.right} /></span>
        <span className="text-xl text-muted-foreground"> / {track.total}</span>
      </p>
      <p className="text-xs text-muted-foreground">guesses right</p>
      <div className="mt-3 flex justify-center gap-1" aria-hidden>
        {Array.from({ length: track.total }, (_, i) => (
          <span key={i} className={cn("h-2.5 w-2.5 rounded-full", i < track.right ? "bg-emerald-500" : "bg-muted-foreground/25")} />
        ))}
      </div>
    </div>
  );
}

function Frame({ label, guesses, thumb, byId, dashed }: {
  label: string; guesses: RecapGuess[]; thumb: string; byId: Map<number, LabelClass>; dashed?: boolean;
}) {
  const counts = new Map<number, number>();
  guesses.forEach((g) => counts.set(g.class_id, (counts.get(g.class_id) ?? 0) + 1));
  return (
    <div className="space-y-1">
      <ThumbBox thumbUrl={thumb} dim={dashed}
        boxes={guesses.map((g) => ({ ...g, color: byId.get(g.class_id)?.color ?? "#7c3aed", dashed }))} />
      <p className="text-[11px] text-muted-foreground">
        <b className="text-foreground">{label}:</b>{" "}
        {guesses.length === 0 ? "nothing" : [...counts].map(([cid, n], i) => (
          <span key={cid}>{i > 0 && ", "}{n} <span style={{ color: byId.get(cid)?.color }}>{byId.get(cid)?.name ?? "?"}</span></span>
        ))}
      </p>
    </div>
  );
}

function Stat({ icon, n, label, tone }: { icon: React.ReactNode; n: number; label: string; tone?: "amber" }) {
  return (
    <div className="lift rounded-2xl border bg-card p-4">
      <div className={cn("mb-1 [&_svg]:h-4 [&_svg]:w-4", tone === "amber" ? "text-amber-500" : "text-pixel")}>{icon}</div>
      <p className="text-2xl font-bold tabular-nums"><CountUp value={n} /></p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
