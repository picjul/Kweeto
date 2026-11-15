"use client";

import { ArrowRight, BrainCircuit, Check, Flag, GraduationCap, HelpCircle, Images, Play, Shapes, Share2, Sprout, Upload, Zap } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ClassManager } from "@/components/class-manager";
import { ClassPath } from "@/components/class-path";
import { Aurora, CountUp } from "@/components/fx";
import { PageLoading } from "@/components/page-loading";
import { PixelAvatar, PixelBurst, STAGES, Typewriter, levelProgress, levelTitle, pokeLines, stageOf, type PixelMood } from "@/components/pixel";
import { usePixelTraits, useProject } from "@/components/project-context";
import { openShareCard } from "@/components/share-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type RecapSummary, type Stats } from "@/lib/api";
import { play, voiceOf } from "@/lib/sound";
import { cn } from "@/lib/utils";

/** The open project's overview (reached by clicking its Pixel in the playground). */
export default function OverviewPage() {
  const pixel = usePixelTraits();
  const { project } = useProject();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poke, setPoke] = useState<string | null>(null);
  const [pokes, setPokes] = useState(0);
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api.stats().then((s) => { setStats(s); setError(null); }).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const onPoke = () => {
    if (!stats) return;
    const lines = pokeLines(stats);
    setPoke(lines[pokes % lines.length]);
    play("poke", { pitch: voiceOf(pixel.name, levelProgress(stats.boxes).level) });
    setPokes((n) => n + 1);
    if (pokeTimer.current) clearTimeout(pokeTimer.current);
    pokeTimer.current = setTimeout(() => setPoke(null), 6000);
  };

  if (error && !stats) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-16 text-center">
        <PixelAvatar mood="sleepy" size={150} />
        <p className="text-xl font-semibold">{pixel.name} is asleep…</p>
        <p className="text-sm text-muted-foreground">
          I can&apos;t reach the backend. Start it with <code className="rounded bg-muted px-1">uvicorn app.main:app --reload</code> in
          the <code className="rounded bg-muted px-1">backend</code> folder.
        </p>
        <p className="text-xs text-muted-foreground">({error})</p>
      </div>
    );
  }
  if (!stats) return <PageLoading />;

  const { level, progress, toNext } = levelProgress(stats.boxes);
  const leverage = stats.gestures ? (stats.boxes / stats.gestures).toFixed(1) : "—";
  const w = stats.worker;
  const canStart = stats.classes.length > 0 && stats.images.embedded + stats.images.annotated > 0;
  const mood: PixelMood = poke ? "happy"
    : w.running ? "thinking"
    : stats.images.total === 0 ? "curious"
    : stats.batch_ready > 0 ? "proud"
    : stats.boxes > 0 ? "happy" : "idle";

  return (
    <div className="space-y-6">
      {/* hero */}
      <section data-tour="pixel" className="relative overflow-hidden rounded-[2rem] border bg-card p-6 shadow-xl shadow-pixel/5 sm:p-8">
        <Aurora />
        <Confetti />
        <div className="relative grid items-center gap-6 md:grid-cols-[auto_1fr_auto]">
          <div className="glass relative mx-auto rounded-full p-6 shadow-2xl shadow-pixel/20">
            <PixelBurst trigger={pokes} count={12} />
            <PixelAvatar mood={mood} level={level} size={120} onPoke={onPoke} bounce={stats.batch_ready > 0 ? 1 : 0} />
          </div>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-gradient text-4xl font-extrabold tracking-tight sm:text-5xl">{pixel.name}</h1>
              {project && <span className="rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{project.name}</span>}
              <span className="rounded-full bg-pixel px-2.5 py-0.5 text-xs font-semibold text-white">Level {level}</span>
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                {STAGES[stageOf(level)].label} · {levelTitle(level)}
              </span>
            </div>
            <div className="bubble glass max-w-xl text-base">
              <span className="absolute -left-[7px] top-6 hidden h-3 w-3 rotate-45 border-b border-l border-pixel/25 bg-card md:block" />
              <Typewriter text={poke ?? stats.pixel_message} />
            </div>
            <div className="max-w-xl space-y-1">
              <div className="h-2.5 overflow-hidden rounded-full bg-card/80 ring-1 ring-border">
                <div className="h-full rounded-full bg-gradient-to-r from-pixel to-pixel/50 transition-all duration-700"
                  style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                {stats.boxes} examples learned · {toNext} more to level {level + 1} · <span className="italic">tip: poke {pixel.name}</span>
              </p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 md:w-60">
            <Button asChild size="lg" variant="pixel" className="h-14 rounded-2xl text-base shadow-lg shadow-pixel/30">
              <Link href={canStart ? "/annotate" : "#"} aria-disabled={!canStart} data-tour="start"
                className={cn(!canStart && "pointer-events-none opacity-50")}><Play className="fill-white" /> Start the lesson</Link>
            </Button>
            {stats.batch_ready > 0 && (
              <Button asChild variant="outline" className="rounded-2xl bg-card">
                <Link href="/batch"><Sprout className="text-emerald-600" /> Harvest ready ({stats.batch_ready})</Link>
              </Button>
            )}
            <Button variant="ghost" className="rounded-2xl" onClick={openShareCard}><Share2 /> Share its card</Button>
          </div>
        </div>
      </section>

      <GettingStarted stats={stats} />

      {stats.suggestion && <TrainSuggestion s={stats.suggestion} onDismiss={() => api.dismissTrainingSuggestion().then(load)} />}

      <LastLesson />


      {w.error && <p className="text-sm text-destructive">Engine error: {w.error}</p>}

      {/* stats */}
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard tint="bg-emerald-100 text-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-300" icon={<Sprout />}
          title="Harvest ready" value={stats.batch_ready} hint="confident guesses to check" href="/batch" />
        <StatCard tint="bg-pixel/10 text-pixel" icon={<HelpCircle />}
          title="Questions" value="?" hint="Pixel's doubts about concepts" href="/questions" />
        <StatCard tint="bg-sky-100 text-sky-600 dark:bg-sky-900/50 dark:text-sky-300" icon={<Images />}
          title="Images" value={stats.images.total} hint={`${stats.images.annotated} annotated · ${stats.images.embedded} to teach`} href="/gallery" />
        <StatCard tint="bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-300" icon={<Zap className="fill-amber-400" />}
          title="Leverage" value={`×${leverage}`} hint={`${stats.gestures} gestures → ${stats.boxes} labels`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card id="classes" data-tour="classes" className="scroll-mt-24 lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Pixel&apos;s path</CardTitle>
            <span className="text-xs text-muted-foreground">30 examples to master a class</span>
          </CardHeader>
          <CardContent className="space-y-5">
            <ClassPath classes={stats.classes} />
            <div className="rounded-2xl bg-muted/60 p-4"><ClassManager classes={stats.classes} onChange={load} /></div>
          </CardContent>
        </Card>
        <DatasetCard stats={stats} />
      </div>
    </div>
  );
}

/** The latest finished lesson, in one line: its BEFORE / AFTER (real judged guesses), with a link to the recap. */
function LastLesson() {
  const [last, setLast] = useState<RecapSummary | null>(null);
  useEffect(() => { api.sessions(1).then((s) => setLast(s[0] ?? null)).catch(() => setLast(null)); }, []);
  if (!last) return null;
  const a = last.accuracy;
  return (
    <Link href={`/recap?s=${last.id}`}
      className="lift flex flex-wrap items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-sm shadow-sm">
      <Flag className="h-4 w-4 text-pixel" />
      <span className="font-semibold">Last lesson</span>
      {a ? (
        <span className="tabular-nums">
          {a.before.right}/{a.before.total} <ArrowRight className="inline h-3.5 w-3.5 text-muted-foreground" />{" "}
          <b className={cn(a.after.right / a.after.total > a.before.right / a.before.total && "text-emerald-600 dark:text-emerald-400")}>
            {a.after.right}/{a.after.total}
          </b>{" "}guesses right
        </span>
      ) : (
        <span className="text-muted-foreground">{last.judged} guesses judged</span>
      )}
      <span className="text-muted-foreground">
        · {last.finished} images finished{last.propagated ? ` · ⚡ ${last.propagated}` : ""}
        {last.changed_total ? ` · changed my mind on ${last.changed_total}` : ""}
      </span>
      <span className="ml-auto text-xs font-medium text-pixel">See the recap →</span>
    </Link>
  );
}

function GettingStarted({ stats }: { stats: Stats }) {
  const minPerClass = stats.classes.length ? Math.min(...stats.classes.map((c) => c.box_count)) : 0;
  const steps = [
    { done: stats.images.total > 0, title: "Upload images", text: "A folder of photos, or a labelled dataset to import.", href: "/upload", icon: <Upload /> },
    { done: stats.classes.length > 0, title: "Name the classes", text: "Tell Pixel what to look for.", href: "#classes", icon: <Shapes /> },
    { done: minPerClass >= 3, title: "Teach a few examples", text: "About 3 boxes per class.", href: "/annotate", icon: <GraduationCap /> },
    { done: stats.batch_ready > 0 || stats.gestures > 20, title: "Harvest", text: "Review Pixel's confident guesses.", href: "/batch", icon: <Sprout /> },
  ];
  if (steps.every((s) => s.done)) return null;
  const current = steps.findIndex((s) => !s.done);
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Getting started</CardTitle></CardHeader>
      <CardContent>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.title}>
              <Link href={s.href}
                className={cn("lift flex h-full items-start gap-3 rounded-2xl border p-4",
                  i === current ? "border-pixel/50 bg-pixel/5 ring-2 ring-pixel/20" : s.done ? "opacity-70" : "")}>
                <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl [&_svg]:h-4 [&_svg]:w-4",
                  s.done ? "bg-emerald-500 text-white" : i === current ? "bg-pixel text-white" : "bg-muted text-muted-foreground")}>
                  {s.done ? <Check /> : s.icon}
                </span>
                <span>
                  <span className="block text-sm font-semibold">{i + 1}. {s.title}</span>
                  <span className="block text-xs text-muted-foreground">{s.text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function DatasetCard({ stats }: { stats: Stats }) {
  const i = stats.images;
  const parts = [
    { label: "Annotated", value: i.annotated, cls: "bg-emerald-500" },
    { label: "To teach", value: i.embedded, cls: "bg-violet-500" },
    { label: "Analysing", value: i.pending, cls: "bg-sky-400" },
    { label: "Ignored", value: i.ignored, cls: "bg-zinc-400" },
    { label: "Errors", value: i.error, cls: "bg-rose-500" },
  ].filter((p) => p.value > 0);
  const total = Math.max(1, i.total);
  return (
    <Card id="dataset">
      <CardHeader><CardTitle>Dataset</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <p className="text-3xl font-extrabold tracking-tight"><CountUp value={i.total} /></p>
          <p className="text-xs text-muted-foreground">images</p>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-muted">
          {parts.map((p) => <div key={p.label} className={p.cls} style={{ width: `${(p.value / total) * 100}%` }} />)}
        </div>
        <ul className="space-y-1.5">
          {parts.map((p) => (
            <li key={p.label} className="flex items-center gap-2">
              <span className={cn("h-2.5 w-2.5 rounded-full", p.cls)} />
              <span className="flex-1 text-muted-foreground">{p.label}</span>
              <span className="font-semibold">{p.value}</span>
            </li>
          ))}
        </ul>
        <Button asChild variant="outline" className="w-full"><Link href="/upload"><Upload /> Upload images</Link></Button>
        <p className="text-xs text-muted-foreground">
          Engine profile <b className="capitalize">{stats.engine.profile}</b>: {stats.engine.embedder === "pixels" ? "test embedder" : stats.engine.model} on {stats.engine.device}
          {stats.engine.faiss ? " · FAISS" : " · numpy"} · {stats.engine.probe ? "kNN + linear probe" : "kNN"}
          {" · "}regions: {stats.engine.proposer} · segmenter: {stats.engine.segmenter}
        </p>
      </CardContent>
    </Card>
  );
}

function Confetti() {
  const bits = [
    ["6%", "14%", "#a78bfa", 10], ["22%", "82%", "#fbbf24", 8], ["46%", "8%", "#f472b6", 7],
    ["68%", "86%", "#34d399", 9], ["86%", "16%", "#818cf8", 11], ["95%", "62%", "#fbbf24", 6],
  ] as const;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {bits.map(([l, t, c, s], i) => (
        <span key={i} className="absolute rotate-12 rounded-[3px] opacity-60"
          style={{ left: l, top: t, width: s, height: s, backgroundColor: c }} />
      ))}
    </div>
  );
}

function StatCard({ icon, tint, title, value, hint, href }: {
  icon: React.ReactNode; tint: string; title: string; value: number | string; hint: string; href?: string;
}) {
  const body = (
    <Card className={cn("h-full", href && "lift")}>
      <CardContent className="flex items-start gap-4 pt-5">
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl [&_svg]:h-5 [&_svg]:w-5", tint)}>{icon}</div>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-3xl font-extrabold tracking-tight">{typeof value === "number" ? <CountUp value={value} /> : value}</p>
          <p className="truncate text-xs text-muted-foreground">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** Pixel's guesses stopped improving: it says so with the real numbers and proposes a dedicated detector. */
function TrainSuggestion({ s, onDismiss }: { s: NonNullable<Stats["suggestion"]>; onDismiss: () => void }) {
  const max = Math.max(...s.errors, 1);
  return (
    <Card className="border-amber-400/50 bg-amber-50/60 dark:bg-amber-950/20">
      <CardContent className="flex flex-wrap items-center gap-5 pt-6">
        <div className="flex items-end gap-1.5" aria-label={`errors per ${s.block} judged guesses: ${s.errors.join(", ")}`}>
          {s.errors.map((e, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <span className="text-xs tabular-nums text-muted-foreground">{e}</span>
              <div className="w-7 rounded-t-md bg-amber-400/80" style={{ height: `${8 + (e / max) * 40}px` }} />
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-2 font-semibold"><BrainCircuit className="h-4 w-4 text-amber-600" /> I&apos;ve stopped improving</p>
          <p className="text-sm text-muted-foreground">
            Wrong {s.errors.join(", ")} times in each of my last {s.errors.length} blocks of {s.block} judged guesses.
            {s.ready
              ? ` ${s.trained_before ? "Another training with your new finished images" : "A detector trained just for this project"} could do better: it runs in the background, overnight if you like.`
              : ` A dedicated detector could do better: finish ${s.min_images - s.finished_images} more images in a Lesson to train one.`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="pixel" className="rounded-full">
            <Link href={s.ready ? "/training" : "/annotate"}>{s.ready ? <><BrainCircuit /> Open Training</> : <><GraduationCap /> Lesson</>}</Link>
          </Button>
          <Button variant="ghost" className="rounded-full" onClick={onDismiss}>Not now</Button>
        </div>
      </CardContent>
    </Card>
  );
}
