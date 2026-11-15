"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api, type Accent, type PixelOptions, type PixelTraits, type Project } from "@/lib/api";
import { readableAccent } from "@/lib/contrast";

export const DEFAULT_TRAITS: PixelTraits = { name: "Pixel", color: "violet", shape: "round", eyes: "cyan", accessory: "none" };

type Ctx = {
  project: Project | null;
  projects: Project[];
  options: PixelOptions | null;
  /** the project list has been fetched at least once (so "no project" is real, not "still loading") */
  loaded: boolean;
  /** live number of boxes of the open project (drives its Pixel's level and growth stage) */
  activeBoxes: number;
  setActiveBoxes: (n: number) => void;
  refresh: () => Promise<void>;
  /** opens another project and reloads the app on it */
  switchTo: (id: string) => Promise<void>;
};

const ProjectCtx = createContext<Ctx>({
  project: null, projects: [], options: null, loaded: false, activeBoxes: 0, setActiveBoxes: () => undefined,
  refresh: async () => undefined, switchTo: async () => undefined,
});

export const useProject = () => useContext(ProjectCtx);

/** The active project's Pixel (falls back to the classic violet Pixel). */
export const usePixelTraits = (): PixelTraits => useContext(ProjectCtx).project?.pixel ?? DEFAULT_TRAITS;

const hue = (accent: string) => Number(accent.split(" ")[0]) || 262;

/** Every project tints the whole UI with its Pixel's colour (the --pixel accent, light and dark). */
function applyAccent(accent: Accent | undefined) {
  if (typeof document === "undefined") return;
  let el = document.getElementById("project-accent") as HTMLStyleElement | null;
  if (!accent) { el?.remove(); return; } // no project open: back to the default violet
  if (!el) {
    el = document.createElement("style");
    el.id = "project-accent";
    document.head.appendChild(el);
  }
  const h = hue(accent.light);
  const light = readableAccent(accent.light, "light"); // readable fill, text on it, and accent text (WCAG AA)
  const dark = readableAccent(accent.dark, "dark");
  el.textContent = `:root{--pixel:${light.fill};--pixel-on:${light.on};--pixel-fg:${light.fg};--pixel-soft:${h} 90% 96%}`
    + `.dark{--pixel:${dark.fill};--pixel-on:${dark.on};--pixel-fg:${dark.fg};--pixel-soft:${h} 40% 16%}`;
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [options, setOptions] = useState<PixelOptions | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [liveBoxes, setLiveBoxes] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.projects();
      setProjects(r.projects);
      setOptions(r.pixel_options);
      setActiveId(r.active);
      setLoaded(true);
    } catch {
      /* backend not reachable yet: keep the defaults */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000); // other projects' Pixels grow too (their stats)
    return () => clearInterval(t);
  }, [refresh]);

  const project = projects.find((p) => p.id === activeId) ?? null;
  useEffect(() => { applyAccent(project?.accent); }, [project?.accent]);

  const switchTo = useCallback(async (id: string) => {
    await api.openProject(id);
    window.location.assign("/overview"); // every page reloads its data from the new project
  }, []);

  const activeBoxes = liveBoxes ?? project?.stats.boxes ?? 0;
  return (
    <ProjectCtx.Provider value={{ project, projects, options, loaded, activeBoxes, setActiveBoxes: setLiveBoxes, refresh, switchTo }}>
      {children}
    </ProjectCtx.Provider>
  );
}

/** CSS colours of a Pixel palette entry, derived from its hue. */
export function pixelColors(traits: PixelTraits, options?: PixelOptions | null) {
  const accent = options?.colors[traits.color]?.light ?? FALLBACK_ACCENTS[traits.color] ?? "262 83% 58%";
  const [h, s] = accent.split(" ");
  const hs = `${h} ${s}`;
  return {
    light: `hsl(${hs} 72%)`,
    mid: `hsl(${hs} 52%)`,
    deep: `hsl(${Number(h) - 18} ${s} 46%)`,
    limb: `hsl(${hs} 40%)`,
    limb2: `hsl(${Number(h) - 18} ${s} 38%)`,
    ink: `hsl(${hs} 45%)`,
    contrast: `hsl(${(Number(h) + 180) % 360} 70% 55%)`,
  };
}

// same values as the backend palettes (used before /api/projects answers, and by previews)
export const FALLBACK_ACCENTS: Record<string, string> = {
  violet: "262 83% 58%", indigo: "239 84% 58%", sky: "199 89% 45%", teal: "173 80% 36%", emerald: "152 69% 38%",
  lime: "85 70% 38%", amber: "35 92% 48%", coral: "8 82% 58%", rose: "340 82% 55%", slate: "215 25% 42%",
};

export const EYE_COLORS: Record<string, string> = {
  cyan: "#67e8f9", lime: "#bef264", amber: "#fcd34d", pink: "#f9a8d4", white: "#f8fafc",
};
