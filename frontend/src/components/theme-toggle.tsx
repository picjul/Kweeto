"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { getThemeMode, isDarkMode, setThemeMode, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>("system");
  useEffect(() => {
    setMode(getThemeMode());
    const onChange = (e: Event) => setMode((e as CustomEvent<ThemeMode>).detail);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => { if (getThemeMode() === "system") setThemeMode("system"); };
    window.addEventListener("kweeto-theme", onChange);
    mq.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener("kweeto-theme", onChange);
      mq.removeEventListener("change", onSystem);
    };
  }, []);
  return mode;
}

/** One-click light/dark switch (icon button). */
export function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeMode();
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(isDarkMode(mode)), [mode]);
  return (
    <button type="button" onClick={() => setThemeMode(dark ? "light" : "dark")}
      title={dark ? "Switch to light theme" : "Switch to dark theme"} aria-label="Dark theme" aria-pressed={dark}
      className={cn("flex h-9 w-9 items-center justify-center rounded-full border bg-card text-muted-foreground transition hover:text-foreground", className)}>
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

/** Segmented control: Light / Dark / System. */
export function ThemePicker() {
  const mode = useThemeMode();
  const opts: { m: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { m: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
    { m: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
    { m: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
  ];
  return (
    <div className="inline-flex rounded-full border bg-muted p-1">
      {opts.map((o) => (
        <button key={o.m} type="button" onClick={() => setThemeMode(o.m)}
          className={cn("flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition",
            mode === o.m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
