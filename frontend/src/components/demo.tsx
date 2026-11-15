"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";

import { navStart } from "@/components/nav-progress";
import { startTour } from "@/components/tour";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * One click: the backend creates and opens a demo project (synthetic images of tomatoes, limes and pipes, three
 * classes, a fast engine), then the app reloads on its Overview with the guided tour.
 */
export function useStartDemo() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    navStart();
    try {
      await api.createDemo();
      startTour();
      window.location.assign("/overview"); // every context reloads on the new project
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { start, busy, error };
}

export function DemoButton({ className, size = "default", label = "Try the demo" }: {
  className?: string; size?: "default" | "sm" | "lg"; label?: string;
}) {
  const { start, busy, error } = useStartDemo();
  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button variant="pixel" size={size} className="rounded-full" onClick={start} disabled={busy} aria-busy={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {busy ? "Preparing the demo images…" : label}
      </Button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
