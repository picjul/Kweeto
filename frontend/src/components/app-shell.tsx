"use client";

import { BrainCircuit, Check, ChevronsUpDown, FileInput, FolderKanban, GraduationCap, HeartPulse, Images, LayoutDashboard, MessageCircleQuestion, PackageOpen, Plus, Search, Share2, SlidersHorizontal, Sprout, Trees, UploadCloud } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AnalysisDone, AnalysisStatus, isAnalysing } from "@/components/analysis-status";
import { openPalette, PaletteButton } from "@/components/command-palette";
import { LinkPending } from "@/components/nav-progress";
import { openShareCard } from "@/components/share-card";
import { PixelAvatar, PixelBurst, STAGES, levelFromBoxes, levelProgress, levelTitle, stageOf } from "@/components/pixel";
import { usePixelTraits, useProject } from "@/components/project-context";
import { SoundToggle } from "@/components/sound-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { play, voiceOf } from "@/lib/sound";
import { api, type Stats } from "@/lib/api";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: ReactNode; badge?: (s: Stats) => number };

const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: "", items: [
    { href: "/", label: "Playground", icon: <Trees /> },
    { href: "/overview", label: "Overview", icon: <LayoutDashboard /> },
  ] },
  {
    title: "Teach",
    items: [
      { href: "/annotate", label: "Lesson", icon: <GraduationCap /> },
      { href: "/batch", label: "Harvest", icon: <Sprout />, badge: (s) => s.batch_ready },
      { href: "/questions", label: "Questions", icon: <MessageCircleQuestion /> },
      { href: "/training", label: "Training", icon: <BrainCircuit /> },
    ],
  },
  {
    title: "Data",
    items: [
      { href: "/gallery", label: "Gallery", icon: <Images /> },
      { href: "/upload", label: "Upload", icon: <UploadCloud /> },
      { href: "/import", label: "Import", icon: <FileInput /> },
      { href: "/health", label: "Health", icon: <HeartPulse /> },
      { href: "/export", label: "Export", icon: <PackageOpen /> },
      { href: "/projects", label: "Projects", icon: <FolderKanban /> },
    ],
  },
  { title: "Settings", items: [{ href: "/settings", label: "Engine", icon: <SlidersHorizontal /> }] },
];

const LEVEL_KEY = "kweeto-level";
const NO_PROJECT_PAGES = ["/", "/projects"];  // the only pages that make sense with no project open

/** Sidebar layout (desktop) / top bar (mobile), live badges and level-up celebration. */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [stats, setStats] = useState<Stats | null>(null);
  const [levelUp, setLevelUp] = useState<{ level: number; grew: boolean } | null>(null);
  const [burst, setBurst] = useState(0);
  const lastLevel = useRef<number | null>(null);
  const { project, loaded, setActiveBoxes } = useProject();
  const pixel = usePixelTraits();
  const levelKey = `${LEVEL_KEY}:${project?.id ?? "-"}`;

  const [doneNote, setDoneNote] = useState<{ count: number; seconds: number } | null>(null);
  const busy = isAnalysing(stats);
  const wasBusy = useRef(false);

  // poll faster while Pixel is analysing, so the progress feels alive
  useEffect(() => {
    if (!project) { setStats(null); return; } // the stats need an open project (no 409s on a first launch)
    const load = () => api.stats().then((s) => { setStats(s); setActiveBoxes(s.boxes); }).catch(() => setStats(null));
    load();
    const t = setInterval(load, busy ? 1500 : 5000);
    return () => clearInterval(t);
  }, [busy, setActiveBoxes, project?.id]);

  // a short confirmation when the analysis ends
  useEffect(() => {
    if (wasBusy.current && !busy && stats?.worker.last?.count) {
      setDoneNote({ count: stats.worker.last.count, seconds: stats.worker.last.seconds });
      play("done");
      const t = setTimeout(() => setDoneNote(null), 10000);
      wasBusy.current = busy;
      return () => clearTimeout(t);
    }
    wasBusy.current = busy;
  }, [busy, stats]);

  const lp = levelProgress(stats?.boxes ?? 0);

  // level-up celebration (remembered across reloads, so it fires only once per level)
  useEffect(() => {
    lastLevel.current = null; // each project's Pixel has its own level
  }, [levelKey]);

  useEffect(() => {
    if (!stats || !project) return;
    let stored = lastLevel.current;
    if (stored == null) {
      try { stored = Number(localStorage.getItem(levelKey) || 0); } catch { stored = 0; }
    }
    if (stored && lp.level > stored) {
      const grew = stageOf(lp.level) !== stageOf(stored);  // a new growth stage: the bigger celebration
      setLevelUp({ level: lp.level, grew });
      setBurst((b) => b + 1);
      play(grew ? "grow" : "levelup", { pitch: voiceOf(pixel.name, lp.level) });
      setTimeout(() => setLevelUp(null), grew ? 6500 : 4500);
    }
    lastLevel.current = lp.level;
    try { localStorage.setItem(levelKey, String(lp.level)); } catch { /* ignore */ }
  }, [stats, lp.level, levelKey, project, pixel.name]);

  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const noProject = loaded && !project;
  const blocked = noProject && !NO_PROJECT_PAGES.includes(path);
  // until we know whether a project is open, project pages must not start calling the API
  const waiting = !loaded && !NO_PROJECT_PAGES.includes(path);

  if (path === "/") return <>{children}</>; // the playground is full screen, without the project chrome

  return (
    <div className="min-h-screen lg:pl-64">
      <a href="#content" className="skip-link rounded-xl bg-pixel px-4 py-2 text-sm font-semibold text-white shadow-lg">Skip to content</a>
      {/* sidebar */}
      <aside aria-label="Sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-card/80 backdrop-blur-md lg:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <PixelAvatar size={34} mood="happy" track={false} animated={false} />
          <span className="text-lg font-bold tracking-tight">Kwee<span className="text-pixel">to</span></span>
        </Link>
        <ProjectSwitcher />
        <div className="px-3 pb-2" data-tour="palette"><PaletteButton /></div>
        <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
          {GROUPS.map((g) => (
            <div key={g.title || "main"} className="space-y-1">
              {g.title && <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</p>}
              {g.items.map((it) => {
                const active = isActive(it.href);
                const badge = stats && it.badge ? it.badge(stats) : 0;
                if (noProject && !NO_PROJECT_PAGES.includes(it.href)) {
                  return (
                    <span key={it.href} title="Open a project first"
                      className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground/40 [&_svg]:h-[18px] [&_svg]:w-[18px]">
                      {it.icon}<span className="flex-1">{it.label}</span>
                    </span>
                  );
                }
                return (
                  <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined}
                    className={cn("group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition [&_svg]:h-[18px] [&_svg]:w-[18px]",
                      active ? "bg-pixel text-white shadow-md shadow-pixel/25" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}>
                    {it.icon}
                    <span className="flex-1">{it.label}</span>
                    <LinkPending />
                    {badge > 0 && (
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold",
                        active ? "bg-white/25 text-white" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300")}>
                        {badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Pixel card */}
        {noProject ? (
          <div className="m-3 flex items-center gap-2 rounded-2xl border bg-card p-3 text-xs text-muted-foreground">
            <span className="flex-1">No project open.</span>
            <SoundToggle />
            <ThemeToggle />
          </div>
        ) : (
        <div className="relative m-3 rounded-2xl border bg-gradient-to-br from-pixel/15 to-card p-3 dark:from-pixel/20">
          <PixelBurst trigger={burst} />
          <div className="flex items-center gap-3">
            <PixelAvatar size={44} level={lp.level} mood={levelUp ? "proud" : stats?.worker.running ? "thinking" : "idle"} bounce={burst} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{pixel.name} · Lv {lp.level}</p>
              <p className="text-xs text-muted-foreground">
                {busy && stats ? (stats.worker.phase === "scanning" ? `analysing ${stats.worker.done}/${stats.worker.total}…` : "analysing…")
                  : `${STAGES[stageOf(lp.level)].label} · ${levelTitle(lp.level)}`}
              </p>
            </div>
            <button type="button" onClick={openShareCard} aria-label={`Share ${pixel.name}'s card`} title={`Share ${pixel.name}'s card`}
              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground">
              <Share2 className="h-4 w-4" />
            </button>
            <SoundToggle />
            <ThemeToggle />
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/70">
            <div className="h-full rounded-full bg-gradient-to-r from-pixel to-pixel/50 transition-all duration-700"
              style={{ width: `${Math.round(lp.progress * 100)}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{lp.toNext} examples to level {lp.level + 1}</p>
        </div>
        )}
      </aside>

      {/* mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-card/85 px-4 py-2 backdrop-blur-md lg:hidden">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <PixelAvatar size={28} mood="happy" track={false} animated={false} />
          <span>Kwee<span className="text-pixel">to</span></span>
        </Link>
        <nav aria-label="Main" className="flex flex-1 gap-1 overflow-x-auto text-sm">
          {GROUPS.flatMap((g) => g.items).map((it) => (
            <Link key={it.href} href={it.href} aria-current={isActive(it.href) ? "page" : undefined}
              className={cn("whitespace-nowrap rounded-full px-3 py-1 font-medium",
                isActive(it.href) ? "bg-pixel text-white" : "text-muted-foreground")}>
              <span className="flex items-center gap-1.5">{it.label}<LinkPending className="h-3 w-3" /></span>
            </Link>
          ))}
        </nav>
        <button type="button" onClick={openPalette} aria-label="Open the command palette"
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><Search className="h-4 w-4" /></button>
        <SoundToggle />
        <ThemeToggle />
      </header>

      {/* level-up toast */}
      {levelUp && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in items-center gap-3 rounded-2xl border bg-card px-5 py-3 shadow-2xl duration-500 lg:left-[calc(50%+8rem)]">
          <PixelAvatar size={levelUp.grew ? 64 : 48} level={levelUp.level} mood="proud" bounce={levelUp.level} />
          <div>
            <p className="font-semibold">
              {levelUp.grew ? `${pixel.name} grew up: now a ${STAGES[stageOf(levelUp.level)].label.toLowerCase()}!` : `Level up! ${pixel.name} is now level ${levelUp.level}`}
            </p>
            <p className="text-sm text-muted-foreground">New title: {levelTitle(levelUp.level)}. Thanks, teacher.</p>
          </div>
        </div>
      )}

      {/* the Lesson is a workspace: it uses the whole width so the image can be as big as possible */}
      <main id="content" tabIndex={-1} className={cn("mx-auto px-4 outline-none sm:px-6",
        path === "/annotate" ? "max-w-[1920px] py-4 lg:px-6 lg:py-5" : "max-w-7xl py-6 lg:px-8 lg:py-8")}>
        {!blocked && busy && stats && path !== "/upload" && <AnalysisStatus stats={stats} />}
        {!busy && doneNote && path !== "/upload" && (
          <AnalysisDone count={doneNote.count} seconds={doneNote.seconds} onClose={() => setDoneNote(null)} />
        )}
        {waiting ? (
          <div className="flex justify-center pt-24"><PixelAvatar mood="thinking" size={100} /></div>
        ) : blocked ? <NoProjectOpen /> : children}
      </main>
    </div>
  );
}

/** Current project + quick switch (each project is a dataset with its own Pixel). */
function ProjectSwitcher() {
  const { project, projects, switchTo } = useProject();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative mx-3 mb-2">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl border bg-background/60 px-3 py-2 text-left text-sm transition hover:bg-accent">
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Project</span>
          <span className={cn("block truncate font-semibold", !project && "text-muted-foreground")}>{project?.name ?? "None open"}</span>
        </span>
        <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-1 animate-in fade-in zoom-in-95 overflow-hidden rounded-xl border bg-card shadow-xl duration-150">
          <ul className="max-h-72 overflow-y-auto py-1">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" disabled={p.active}
                  onClick={() => { setOpen(false); switchTo(p.id); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default">
                  <PixelAvatar size={22} traits={p.pixel} level={levelFromBoxes(p.stats.boxes)} track={false} animated={false} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.active && <Check className="h-4 w-4 text-pixel" />}
                </button>
              </li>
            ))}
          </ul>
          <Link href="/projects" onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-t px-3 py-2 text-sm font-medium text-pixel hover:bg-accent">
            <Plus className="h-4 w-4" /> New or manage projects
          </Link>
        </div>
      )}
    </div>
  );
}

/** Shown instead of a project page when no project is open. */
function NoProjectOpen() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 pt-16 text-center">
      <PixelAvatar mood="sleepy" size={120} level={1} />
      <p className="text-xl font-semibold">No project is open</p>
      <p className="text-sm text-muted-foreground">
        Pick a Pixel in the playground to open its project, or hatch a new one.
      </p>
      <div className="flex gap-2">
        <Button asChild variant="pixel" className="rounded-full"><Link href="/">Go to the playground</Link></Button>
        <Button asChild variant="outline" className="rounded-full"><Link href="/projects?new=1">New project</Link></Button>
      </div>
    </div>
  );
}
