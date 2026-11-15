"use client";

import { AlertTriangle, Check } from "lucide-react";

import { ThumbBox } from "@/components/thumb-box";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BatchGroup as Group, LabelClass } from "@/lib/api";
import { cn, LEVEL_LABEL } from "@/lib/utils";

/** flags: proposal_id -> null (wrong, it's nothing) | class_id (wrong, it's this other class) */
export type Flags = Record<number, number | null>;

export function BatchGroup({ group, classes, flags, onFlag, onApprove, busy }: {
  group: Group;
  classes: LabelClass[];
  flags: Flags;
  onFlag: (proposalId: number, value: number | null | undefined) => void;
  onApprove: () => void;
  busy: boolean;
}) {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const flagged = group.items.filter((it) => it.proposal_id in flags).length;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b bg-muted/40">
        <div className="space-y-1">
          <CardTitle className="text-base">{group.title}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {group.total} {group.total === 1 ? "guess" : "guesses"}{group.total > group.items.length ? ` (showing ${group.items.length})` : ""} · click a thumbnail to flag it as wrong
          </p>
        </div>
        <div className="flex items-center gap-2">
          {flagged > 0 && (
            <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
              {flagged} flagged
            </span>
          )}
          <Button variant="pixel" disabled={busy} onClick={onApprove} className="rounded-full shadow-md shadow-pixel/25">
            <Check /> Approve the rest
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-5">
        <div className="stagger grid grid-cols-3 items-start gap-3 sm:grid-cols-5 lg:grid-cols-8">
          {group.items.map((it) => {
            const c = byId.get(it.class_id);
            const isFlagged = it.proposal_id in flags;
            const low = it.level !== "sure";
            return (
              <div key={it.proposal_id} className="space-y-1" data-proposal-id={it.proposal_id}>
                <button type="button" onClick={() => onFlag(it.proposal_id, isFlagged ? undefined : null)}
                  className={cn("relative block w-full rounded-xl ring-offset-2 ring-offset-card transition duration-200 hover:scale-[1.04]",
                    isFlagged ? "ring-2 ring-destructive" : low ? "ring-2 ring-amber-400/80" : "hover:ring-2 hover:ring-pixel/60")}>
                  <ThumbBox thumbUrl={it.thumb_url} box={it} color={c?.color} dim={isFlagged} className="rounded-xl" />
                  {isFlagged && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <AlertTriangle className="h-7 w-7 text-destructive drop-shadow" />
                    </span>
                  )}
                </button>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="truncate font-semibold" style={{ color: c?.color }}>{c?.name ?? "?"}</span>
                  <span className={cn("text-muted-foreground", low && "text-amber-600 dark:text-amber-400")}>{LEVEL_LABEL[it.level]}</span>
                </div>
                {isFlagged && (
                  <div className="flex animate-in fade-in flex-wrap gap-1">
                    <span className="w-full text-[10px] text-muted-foreground">Actually it&apos;s:</span>
                    {classes.filter((k) => k.id !== it.class_id).map((k) => (
                      <button key={k.id} type="button" onClick={() => onFlag(it.proposal_id, k.id)}
                        className={cn("rounded-full border px-1.5 text-[10px]", flags[it.proposal_id] === k.id && "text-white")}
                        style={flags[it.proposal_id] === k.id ? { backgroundColor: k.color, borderColor: k.color } : undefined}>
                        {k.name}
                      </button>
                    ))}
                    <button type="button" onClick={() => onFlag(it.proposal_id, null)}
                      className={cn("rounded-full border px-1.5 text-[10px]", flags[it.proposal_id] === null && "bg-zinc-600 text-white")}>
                      nothing
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
