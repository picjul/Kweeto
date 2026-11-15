"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { navStart } from "@/components/nav-progress";
import { PixelSays } from "@/components/pixel";
import { ThumbBox } from "@/components/thumb-box";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, type LabelClass, type Question } from "@/lib/api";
import { cn } from "@/lib/utils";

export function QuestionCard({ q, classes, onDone }: { q: Question; classes: LabelClass[]; onDone: (msg: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const color = (id: number) => classes.find((c) => c.id === id)?.color ?? "#7c3aed";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onDone((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const annotate = () => run(async () => {
    const r = await api.answer(q.id, { action: "annotate" });
    navStart();
    router.push(`/annotate?queue=${r.queue.join(",")}`);
  });

  const dismiss = () => run(async () => {
    await api.dismiss(q.id);
    onDone("Sure, I'll ask you again later.");
  });

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <PixelSays mood={q.type === "confusion" ? "thinking" : q.type === "novelty" ? "surprised" : "curious"} size={64}>
          {q.text}
        </PixelSays>

        {(q.type === "few_examples" || q.type === "novelty") && (
          <>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {q.payload.samples.map((s) => <ThumbBox key={s.image_id} thumbUrl={s.thumb_url} />)}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="pixel" disabled={busy} onClick={annotate}>
                {q.type === "few_examples" ? `Teach “${q.payload.class_name}” now` : "They contain objects: I'll annotate them"}
              </Button>
              {q.type === "novelty" && (
                <Button variant="outline" disabled={busy}
                  onClick={() => run(async () => onDone((await api.answer(q.id, { action: "ignore" })).message))}>
                  Ignore them ({q.payload.count})
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={dismiss}>Later</Button>
            </div>
          </>
        )}

        {q.type === "confusion" && <ConfusionBody q={q} color={color} busy={busy} run={run} onDone={onDone} dismiss={dismiss} />}
      </CardContent>
    </Card>
  );
}

function ConfusionBody({ q, color, busy, run, onDone, dismiss }: {
  q: Extract<Question, { type: "confusion" }>;
  color: (id: number) => string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onDone: (msg: string) => void;
  dismiss: () => void;
}) {
  const { class_a, class_b, name_a, name_b, items } = q.payload;
  const [choice, setChoice] = useState<Record<number, number | null>>(
    Object.fromEntries(items.map((it) => [it.region_id, it.proposed_class_id])),
  );
  const options: { id: number | null; label: string }[] = [
    { id: class_a, label: name_a },
    { id: class_b, label: name_b },
    { id: null, label: "Neither" },
  ];

  const submit = () => run(async () => {
    const r = await api.answer(q.id, {
      action: "submit",
      assignments: items.map((it) => ({
        region_id: it.region_id, proposed_class_id: it.proposed_class_id, class_id: choice[it.region_id] ?? null,
      })),
    });
    onDone(r.message);
  });

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map((it) => {
          const cur = choice[it.region_id];
          return (
            <div key={it.region_id} className="space-y-1.5">
              <ThumbBox thumbUrl={it.thumb_url} box={it} color={cur != null ? color(cur) : "#999"} />
              <div className="flex gap-1">
                {options.map((o) => (
                  <button key={String(o.id)} type="button"
                    onClick={() => setChoice((c) => ({ ...c, [it.region_id]: o.id }))}
                    className={cn("flex-1 truncate rounded border px-1 py-0.5 text-[11px]",
                      cur === o.id ? "border-transparent text-white" : "text-muted-foreground hover:bg-accent")}
                    style={cur === o.id ? { backgroundColor: o.id != null ? color(o.id) : "#71717a" } : undefined}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button variant="pixel" disabled={busy} onClick={submit}>Here's the difference</Button>
        <Button variant="ghost" disabled={busy} onClick={dismiss}>Later</Button>
      </div>
    </>
  );
}
