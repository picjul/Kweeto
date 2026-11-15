"use client";

import { GraduationCap } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { BatchGroup, type Flags } from "@/components/batch-group";
import { Aurora, CountUp } from "@/components/fx";
import { PixelAvatar, PixelBurst, Typewriter, type PixelMood } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { api, type BatchGroup as Group, type BatchResponse, type LabelClass, type ReviewItem } from "@/lib/api";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

export default function BatchPage() {
  const [data, setData] = useState<BatchResponse | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [flags, setFlags] = useState<Flags>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [score, setScore] = useState({ found: 0, missed: 0, confirmed: 0 });
  const [mood, setMood] = useState<PixelMood>("curious");
  const [bounce, setBounce] = useState(0);
  const [burst, setBurst] = useState(0);

  const load = useCallback(() => {
    api.batch().then(setData).catch((e) => setMessage((e as Error).message));
    api.classes().then(setClasses);
  }, []);

  useEffect(load, [load]);

  const onFlag = (id: number, value: number | null | undefined) => {
    setFlags((f) => {
      const n = { ...f };
      if (value === undefined) delete n[id];
      else n[id] = value;
      return n;
    });
  };

  const approve = useCallback(async (g: Group) => {
    setBusy(true);
    const accept: ReviewItem[] = [];
    const reject: ReviewItem[] = [];
    const correct: ReviewItem[] = [];
    for (const it of g.items) {
      const base = { proposal_id: it.proposal_id, region_id: it.region_id, class_id: it.class_id };
      if (!(it.proposal_id in flags)) accept.push(base);
      else if (flags[it.proposal_id] === null) reject.push(base);
      else correct.push({ ...base, class_id: flags[it.proposal_id] as number, from_class_id: it.class_id });
    }
    try {
      const r = await api.review({ accept, reject, correct });
      setMessage(r.message);
      setMood(r.controls_missed > 0 ? "surprised" : r.controls_found > 0 || r.delta_count > 0 ? "proud" : "happy");
      play(r.controls_missed > 0 ? "oops" : r.controls_found > 0 ? "proud" : "done");
      if (r.controls_missed === 0) setBounce((b) => b + 1);
      if (r.controls_found > 0) setBurst((b) => b + 1);
      setScore((s) => ({
        found: s.found + r.controls_found,
        missed: s.missed + r.controls_missed,
        confirmed: s.confirmed + r.accepted + r.corrected,
      }));
      setFlags((f) => {
        const n = { ...f };
        g.items.forEach((it) => delete n[it.proposal_id]);
        return n;
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
      load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [flags, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && data?.groups[0] && !busy) {
        e.preventDefault();
        approve(data.groups[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, busy, approve]);

  const empty = data && data.groups.length === 0;
  const text = message ?? data?.message ?? "";

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[2rem] border bg-card p-6 shadow-xl shadow-emerald-500/5 sm:p-8">
        <Aurora variant="emerald" />
        <div className="relative grid items-center gap-6 md:grid-cols-[auto_1fr_auto]">
          <div className="glass relative mx-auto rounded-full p-4 shadow-2xl shadow-emerald-500/20">
            <PixelBurst trigger={burst} />
            <PixelAvatar mood={empty && !message ? "sleepy" : mood} size={112} bounce={bounce} />
          </div>
          <div className="space-y-3">
            <h1 className="text-gradient text-4xl font-extrabold tracking-tight">Harvest</h1>
            {text && (
              <div className="bubble glass max-w-2xl">
                <Typewriter text={text} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Score label="Confirmed" value={score.confirmed} className="bg-pixel/10 text-pixel" />
            <Score label="Checks caught" value={score.found} className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200" />
            <Score label="Missed" value={score.missed} className="bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-200" />
          </div>
        </div>
      </section>

      {data?.groups.map((g) => (
        <BatchGroup key={g.id} group={g} classes={classes} flags={flags} onFlag={onFlag} busy={busy} onApprove={() => approve(g)} />
      ))}

      {empty && (
        <div className="flex justify-center">
          <Button asChild variant="pixel" size="lg" className="rounded-full"><Link href="/annotate"><GraduationCap /> Back to the lesson</Link></Button>
        </div>
      )}
      {!empty && (
        <p className="text-xs text-muted-foreground">
          <kbd className="rounded border bg-muted px-1">⏎</kbd> approves the first group. Yellow rings mark the guesses Pixel is least sure about.
        </p>
      )}
    </div>
  );
}

function Score({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className={cn("min-w-24 rounded-2xl px-4 py-3 shadow-sm", className)}>
      <div className="text-3xl font-extrabold"><CountUp value={value} /></div>
      <div className="text-[11px] font-semibold opacity-80">{label}</div>
    </div>
  );
}
