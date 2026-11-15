"use client";

import {
  BrainCircuit, CornerDownLeft, FileInput, FolderKanban, GraduationCap, HeartPulse, Images, LayoutDashboard,
  Compass, MessageCircleQuestion, Moon, PackageOpen, Plus, Search, Share2, SlidersHorizontal, Sparkles, Sprout, Sun, Trees,
  UploadCloud,
  Volume2, VolumeX,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useStartDemo } from "@/components/demo";
import { navStart } from "@/components/nav-progress";
import { useProject } from "@/components/project-context";
import { openShareCard } from "@/components/share-card";
import { startTour } from "@/components/tour";
import { api, fileUrl, type ImageSummary } from "@/lib/api";
import { soundEnabled, setSoundEnabled } from "@/lib/sound";
import { getThemeMode, isDarkMode, setThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Command palette (Ctrl+K / ⌘K, or `openPalette()`): jump to any page, open a project, find an image by name,
 * and run the everyday actions (theme, sounds, share Pixel's card) without the mouse.
 */

const OPEN = "kweeto:palette";

export function openPalette() {
  window.dispatchEvent(new Event(OPEN));
}

type Item = {
  id: string;
  group: "Pages" | "Actions" | "Projects" | "Images";
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  /** needs an open project */
  project?: boolean;
  run: () => void;
};

const PAGES: { href: string; label: string; icon: ReactNode; keywords: string; project?: boolean }[] = [
  { href: "/", label: "Playground", icon: <Trees />, keywords: "home 3d pixels" },
  { href: "/overview", label: "Overview", icon: <LayoutDashboard />, keywords: "dashboard stats classes", project: true },
  { href: "/annotate", label: "Lesson", icon: <GraduationCap />, keywords: "annotate teach label boxes", project: true },
  { href: "/batch", label: "Harvest", icon: <Sprout />, keywords: "batch approve review", project: true },
  { href: "/questions", label: "Questions", icon: <MessageCircleQuestion />, keywords: "doubts ask", project: true },
  { href: "/training", label: "Training", icon: <BrainCircuit />, keywords: "detector yolo train model", project: true },
  { href: "/gallery", label: "Gallery", icon: <Images />, keywords: "images browse", project: true },
  { href: "/upload", label: "Upload", icon: <UploadCloud />, keywords: "add images", project: true },
  { href: "/import", label: "Import a dataset", icon: <FileInput />, keywords: "import coco yolo voc label studio cvat annotations labels", project: true },
  { href: "/health", label: "Dataset health", icon: <HeartPulse />, keywords: "errors mistakes mislabelled duplicates balance check quality", project: true },
  { href: "/export", label: "Export", icon: <PackageOpen />, keywords: "coco yolo voc download", project: true },
  { href: "/projects", label: "Projects", icon: <FolderKanban />, keywords: "datasets switch" },
  { href: "/settings", label: "Engine & appearance", icon: <SlidersHorizontal />, keywords: "settings profile theme models plugins" },
];

/** Every query word must appear in the label, hint or keywords (case-insensitive); earlier matches rank first. */
function score(item: Item, words: string[]): number {
  if (!words.length) return 1;
  const hay = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 3 : item.label.toLowerCase().includes(w) ? 2 : 1;
  }
  return s;
}

export function CommandPalette() {
  const router = useRouter();
  const path = usePathname();
  const { project, projects, switchTo } = useProject();
  const { start: startDemo } = useStartDemo();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [dark, setDark] = useState(false);
  const [sound, setSound] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  const show = useCallback(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    setImages([]);
    setDark(isDarkMode(getThemeMode()));
    setSound(soundEnabled());
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => returnFocus.current?.focus?.());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close(); else show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN, show);
    };
  }, [open, show, close]);


  // images by file name (debounced), only with an open project
  useEffect(() => {
    if (!open || !project || query.trim().length < 2) { setImages([]); return; }
    const t = setTimeout(() => {
      api.images({ q: query.trim(), limit: 6 }).then((r) => setImages(r.items)).catch(() => setImages([]));
    }, 180);
    return () => clearTimeout(t);
  }, [open, query, project]);

  const go = useCallback((href: string) => {
    close();
    if (href === path) return;
    navStart();
    router.push(href);
  }, [close, path, router]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const p of PAGES) {
      out.push({ id: `page:${p.href}`, group: "Pages", label: p.label, keywords: p.keywords, icon: p.icon,
        project: p.project, hint: p.href === path ? "you are here" : undefined, run: () => go(p.href) });
    }
    out.push(
      { id: "act:lesson", group: "Actions", label: "Start a lesson", keywords: "teach annotate", icon: <GraduationCap />,
        project: true, run: () => go("/annotate") },
      { id: "act:upload", group: "Actions", label: "Upload images", keywords: "add import", icon: <UploadCloud />,
        project: true, run: () => go("/upload") },
      { id: "act:share", group: "Actions", label: "Share Pixel's card", keywords: "image png download picture", icon: <Share2 />,
        project: true, run: () => { close(); openShareCard(); } },
      { id: "act:theme", group: "Actions", label: dark ? "Switch to light theme" : "Switch to dark theme",
        keywords: "theme dark light appearance", icon: dark ? <Sun /> : <Moon />,
        run: () => { setThemeMode(dark ? "light" : "dark"); close(); } },
      { id: "act:sound", group: "Actions", label: sound ? "Mute sounds" : "Turn sounds on", keywords: "sound audio mute",
        icon: sound ? <VolumeX /> : <Volume2 />, run: () => { setSoundEnabled(!sound); close(); } },
      { id: "act:new", group: "Actions", label: "New project", keywords: "create hatch egg dataset", icon: <Plus />,
        run: () => go("/projects?new=1") },
      { id: "act:demo", group: "Actions", label: "Try the demo project", keywords: "sample example images tutorial",
        icon: <Sparkles />, run: () => { close(); startDemo(); } },
      { id: "act:tour", group: "Actions", label: "Take the tour", keywords: "help tutorial guide onboarding", icon: <Compass />,
        project: true, run: () => { close(); startTour(); go("/overview"); } },
    );
    for (const p of projects) {
      out.push({ id: `proj:${p.id}`, group: "Projects", label: p.name, keywords: `project open switch ${p.pixel.name}`,
        hint: p.active ? "open now" : `${p.stats.images} images · ${p.pixel.name}`, icon: <FolderKanban />,
        run: () => { if (p.active) go("/overview"); else { close(); navStart(); switchTo(p.id); } } });
    }
    return out;
  }, [path, projects, dark, sound, go, close, switchTo, startDemo]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    const base = items
      .filter((it) => !it.project || project)
      .map((it) => ({ it, s: score(it, words) }))
      .filter((x) => x.s > 0);
    if (words.length) base.sort((a, b) => b.s - a.s);
    const imgs: Item[] = images.map((im) => ({
      id: `img:${im.id}`, group: "Images", label: im.filename, hint: `${im.box_count} boxes · ${im.status}`,
      // eslint-disable-next-line @next/next/no-img-element
      icon: <img src={fileUrl(im.thumb_url)} alt="" className="h-6 w-6 rounded object-cover" />,
      run: () => go(`/images/${im.id}`),
    }));
    return [...base.map((x) => x.it), ...imgs];
  }, [items, words, images, project]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { // keep the highlighted row visible
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); shown[active]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); } // focus stays in the palette
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-2xl border bg-card shadow-2xl animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          {/* autoFocus: focused as it appears, so keys typed right after Ctrl+K are not lost */}
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input ref={input} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            placeholder={project ? "Go to a page, run an action, find an image…" : "Go to a page or open a project…"}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul ref={list} id={listId} role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-y-auto p-2">
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches &ldquo;{query}&rdquo;.</li>}
          {shown.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.id} role="presentation">
                {header && <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" aria-hidden>{header}</p>}
                <div id={`${listId}-${i}`} role="option" aria-selected={i === active} data-index={i}
                  onMouseMove={() => setActive(i)} onClick={() => it.run()}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm [&_svg]:h-4 [&_svg]:w-4",
                    i === active ? "bg-pixel text-white" : "text-foreground")}>
                  <span className={cn("shrink-0", i === active ? "text-white" : "text-muted-foreground")} aria-hidden>{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className={cn("truncate text-xs", i === active ? "font-medium" : "text-muted-foreground")}>{it.hint}</span>}
                  {i === active && <CornerDownLeft className="shrink-0 opacity-80" aria-hidden />}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="flex gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
          <span><kbd className="font-mono">↑↓</kbd> move</span><span><kbd className="font-mono">⏎</kbd> run</span>
          <span><kbd className="font-mono">Ctrl K</kbd> open / close</span>
        </p>
      </div>
    </div>
  );
}

/** A visible way in (and a reminder of the shortcut) for the sidebar. */
export function PaletteButton({ className }: { className?: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform)); }, []);
  return (
    <button type="button" onClick={openPalette} aria-label="Open the command palette"
      className={cn("flex w-full items-center gap-2 rounded-xl border bg-background/60 px-3 py-2 text-left text-sm text-muted-foreground transition hover:bg-accent", className)}>
      <Search className="h-4 w-4" aria-hidden />
      <span className="flex-1">Search…</span>
      <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">{mac ? "⌘" : "Ctrl"} K</kbd>
    </button>
  );
}
