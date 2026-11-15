"use client";

import { Volume2, VolumeX } from "lucide-react";

import { useSoundEnabled } from "@/lib/sound";
import { cn } from "@/lib/utils";

/** Turns Pixel's sounds on/off (remembered on this browser). */
export function SoundToggle({ className }: { className?: string }) {
  const [on, setOn] = useSoundEnabled();
  return (
    <button type="button" onClick={() => setOn(!on)} aria-pressed={on} aria-label="Sounds"
      title={on ? "Sounds on (click to mute)" : "Sounds off (click to unmute)"}
      className={cn("flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground",
        className)}>
      {on ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
    </button>
  );
}
