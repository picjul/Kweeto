"use client";

import { Html, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { FolderKanban } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as THREE from "three";

import { DemoButton } from "@/components/demo";
import { navStart } from "@/components/nav-progress";
import { STAGES, levelFromBoxes, stageOf, type PixelMood } from "@/components/pixel";
import { PixelLights, PixelModel, type PixelDrive } from "@/components/pixel3d";
import { useProject } from "@/components/project-context";
import { SoundToggle } from "@/components/sound-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { api, type PixelOptions, type Project } from "@/lib/api";
import { play, voiceOf, type Cue } from "@/lib/sound";
import { cn } from "@/lib/utils";

// ---------- the world: x = left/right, z = distance from the camera (metres), the ground is y = 0 ----------
// (three.js looks down -z, so a walker at distance z sits at position.z = -z)
const Z_NEAR = 3.2;      // closest distance anything stands at
const EYE = 1.6;         // camera height
const FOV = 50;
const LOOK_Y = 0.25;     // the camera aims at (0, LOOK_Y, -12): the horizon lands at ~38% of the screen, like the sky
const MEET = 1.6;        // two Pixels closer than this meet and chat
const CHAT_MS = 3400;
const PIXEL_SCALE = 1.4; // Pixels are a bit larger than life here, so they read well among the trees

type Walker = {
  id: string; x: number; z: number; tx: number; tz: number; speed: number; yaw: number;
  state: "walk" | "idle" | "chat" | "held"; until: number; lastChat: number; partner?: string;
  drive: PixelDrive;
};
type Bubble = { text: string; mood: PixelMood };
type Prop = { kind: "tree" | "pine" | "rock" | "bush"; x: number; z: number; size: number; rot: number };

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Static scenery, the same on every visit (seeded). */
function makeProps(): Prop[] {
  const r = seeded(7);
  const out: Prop[] = [];
  for (let i = 0; i < 16; i++) {
    const z = 7 + r() * 24;
    const side = r() < 0.5 ? -1 : 1;
    out.push({ kind: r() < 0.45 ? "pine" : "tree", x: side * (2 + r() * 14) * (z / 10), z, size: 2.2 + r() * 1.6, rot: r() * 6.28 });
  }
  for (let i = 0; i < 10; i++) out.push({ kind: r() < 0.5 ? "rock" : "bush", x: (r() - 0.5) * 16, z: 4 + r() * 22, size: 0.45 + r() * 0.5, rot: r() * 6.28 });
  return out;
}

/** Short, TRUE things a Pixel can say about itself (rule: Pixel never makes things up). */
function facts(p: Project, level: number): string[] {
  const s = p.stats;
  const out = [`Level ${level}!`];
  out.push(s.images ? `${s.images} ${s.images === 1 ? "image" : "images"} seen` : "No images yet…");
  if (s.classes) out.push(`I know ${s.classes} ${s.classes === 1 ? "class" : "classes"}`);
  if (s.boxes) out.push(`${s.boxes} examples learned`);
  const st = stageOf(level);
  if (st === "baby") out.push("Just hatched!");
  if (st === "adult" || st === "master") out.push("All grown up");
  return out;
}
const REPLIES: [string, PixelMood][] = [["hi!", "happy"], ["♥", "happy"], ["!", "surprised"], ["✦", "proud"], ["♪", "happy"], ["ooh", "curious"]];
const CUE_OF: Record<PixelMood, Cue> = {
  happy: "happy", surprised: "surprised", curious: "curious", proud: "proud", sleepy: "sleepy", thinking: "curious", idle: "hello",
};
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function useDarkTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setDark(el.classList.contains("dark"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** Full-screen 3D playground: every project's Pixel lives here. Click one to open its project. */
export function Playground() {
  const { projects, activeBoxes, switchTo, loaded, options } = useProject();
  const router = useRouter();
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const [hover, setHover] = useState<string | null>(null);
  const [jump, setJump] = useState<Record<string, number>>({});
  const [leaving, setLeaving] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const dark = useDarkTheme();
  const pointer = useRef({ x: 0, y: 0 });
  const [training, setTraining] = useState<string | null>(null);  // project whose detector is training right now

  const anyOpen = projects.some((p) => p.active);
  useEffect(() => {
    if (!anyOpen) { setTraining(null); return; } // the training endpoint needs an open project
    const check = () => api.training().then((t) => setTraining(t.busy?.project ?? null)).catch(() => setTraining(null));
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, [anyOpen]);

  useEffect(() => {
    setReduced(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX / window.innerWidth - 0.5, y: e.clientY / window.innerHeight - 0.5 };
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);

  const levelOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects) m.set(p.id, levelFromBoxes(p.active ? activeBoxes : p.stats.boxes));
    return m;
  }, [projects, activeBoxes]);

  const open = (p: Project) => {
    if (leaving) return;
    setLeaving(p.id);
    setJump((j) => ({ ...j, [p.id]: (j[p.id] ?? 0) + 1 }));
    setBubbles((x) => ({ ...x, [p.id]: { text: p.active ? "Let's go!" : "Come in!", mood: "happy" } }));
    play("poke", { pitch: voiceOf(p.pixel.name, levelOf.get(p.id) ?? 1) });
    navStart(); // feedback right away: the opening animation and the page load follow
    setTimeout(() => { if (p.active) router.push("/overview"); else switchTo(p.id); }, 650);
  };
  const hatch = () => { play("hatch"); navStart(); router.push("/projects?new=1"); };

  return (
    <div className="playground relative h-[100dvh] w-full select-none overflow-hidden">
      <div aria-hidden className="pg-sky absolute inset-0" />
      <div aria-hidden className="pg-stars absolute inset-x-0 top-0 h-[40%]" />
      <div aria-hidden className="pg-sun absolute right-[14%] top-[13%] h-20 w-20 rounded-full" />

      <Canvas shadows dpr={[1, 2]} gl={{ alpha: true, antialias: true }} className="!absolute inset-0"
        camera={{ fov: FOV, near: 0.1, far: 220, position: [0, EYE, 0] }}
        onPointerMissed={() => setHover(null)}>
        <World projects={projects} options={options} levelOf={levelOf} loaded={loaded} dark={dark} reduced={reduced}
          pointer={pointer} bubbles={bubbles} setBubbles={setBubbles} hover={hover} setHover={setHover}
          jump={jump} leaving={leaving} training={training} onOpen={open} onHatch={hatch} />
      </Canvas>

      {/* keyboard / screen readers: the same actions as clicking the 3D Pixels */}
      <div className="sr-only">
        {projects.map((p) => (
          <button key={p.id} type="button" onFocus={() => setHover(p.id)} onBlur={() => setHover((h) => (h === p.id ? null : h))}
            onClick={() => open(p)}>
            Open {p.name} ({p.pixel.name}, level {levelOf.get(p.id) ?? 1})
          </button>
        ))}
        <Link href="/projects?new=1">Hatch a new project</Link>
      </div>

      {/* overlay UI */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-[20000] flex items-center gap-3 p-4 sm:p-6">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-card/80 px-4 py-2 shadow-lg backdrop-blur">
          <span className="text-lg font-bold tracking-tight">Kwee<span className="text-pixel">to</span></span>
        </div>
        <div className="pointer-events-auto ml-auto flex items-center gap-1 rounded-full bg-card/80 p-1 shadow-lg backdrop-blur">
          <Link href="/projects" className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium hover:bg-accent">
            <FolderKanban className="h-4 w-4" /> Projects
          </Link>
          <SoundToggle />
          <ThemeToggle />
        </div>
      </header>
      {loaded && projects.length > 0 && (
        <p className="pointer-events-none absolute inset-x-0 bottom-5 z-[20000] text-center text-sm font-medium text-foreground/70 drop-shadow">
          Click a Pixel to open its project · hatch the egg for a new one
        </p>
      )}
      {loaded && projects.length === 0 && (
        <div className="absolute inset-x-0 bottom-6 z-[20000] flex justify-center px-4">
          <div className="flex max-w-xl flex-col items-center gap-3 rounded-3xl border bg-card/90 px-6 py-5 text-center shadow-2xl backdrop-blur sm:flex-row sm:text-left">
            <div className="flex-1">
              <p className="font-semibold">New here? Watch a Pixel learn in two minutes.</p>
              <p className="text-sm text-muted-foreground">
                The demo comes with 36 images ready to teach and a short tour. Or hatch the egg to start with your own images.
              </p>
            </div>
            <DemoButton />
          </div>
        </div>
      )}
    </div>
  );
}

type WorldProps = {
  projects: Project[];
  options: PixelOptions | null;
  levelOf: Map<string, number>;
  loaded: boolean;
  dark: boolean;
  reduced: boolean;
  pointer: MutableRefObject<{ x: number; y: number }>;
  bubbles: Record<string, Bubble>;
  setBubbles: Dispatch<SetStateAction<Record<string, Bubble>>>;
  hover: string | null;
  setHover: Dispatch<SetStateAction<string | null>>;
  jump: Record<string, number>;
  leaving: string | null;
  training: string | null;
  onOpen: (p: Project) => void;
  onHatch: () => void;
};

function World({ projects, options, levelOf, loaded, dark, reduced, pointer, bubbles, setBubbles, hover, setHover, jump, leaving, training, onOpen, onHatch }: WorldProps) {
  const { camera, size, scene } = useThree();
  const walkers = useRef(new Map<string, Walker>());
  const props = useMemo(makeProps, []);
  const cam = useRef({ x: 0, tilt: 0 });
  const [, force] = useState(0);

  const halfWidthAt = (z: number) => z * Math.tan(((FOV / 2) * Math.PI) / 180) * (size.width / Math.max(1, size.height));

  // fog fades the far ground into the sky's horizon colour
  useEffect(() => {
    scene.fog = new THREE.Fog(dark ? "#262262" : "#f4f6cf", 26, 120);
    return () => { scene.fog = null; };
  }, [scene, dark]);

  // one walker per project, kept across refreshes
  useEffect(() => {
    const W = walkers.current;
    let added = false;
    projects.forEach((p, i) => {
      if (W.has(p.id)) return;
      const z = rand(Z_NEAR + 1.2, 11);
      const hw = halfWidthAt(z) * 0.75;
      const x = projects.length > 1 ? -hw + (2 * hw * i) / (projects.length - 1) : 0;
      const st = stageOf(levelOf.get(p.id) ?? 1);
      W.set(p.id, {
        id: p.id, x, z, tx: x, tz: z, yaw: 0, speed: st === "baby" ? 0.55 : st === "child" ? 0.75 : 0.95, state: "idle",
        until: performance.now() + rand(200, 1500), lastChat: 0, drive: { walk: 0, yaw: 0, lookX: 0, lookY: 0 },
      });
      added = true;
    });
    for (const id of [...W.keys()]) if (!projects.some((p) => p.id === id)) { W.delete(id); added = true; }
    if (added) force((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, levelOf]);

  // hovering a Pixel holds it still, so it can be clicked; a Pixel whose detector is training stays put to work out
  useEffect(() => {
    walkers.current.forEach((w) => {
      if (w.id === hover || w.id === leaving || w.id === training) w.state = "held";
      else if (w.state === "held") { w.state = "idle"; w.until = 0; }
    });
  }, [hover, leaving, training]);

  const pending = useRef<Record<string, Bubble | null>>({});
  const answer = (id: string, name: string, level: number, bubble: Bubble, firstMood?: PixelMood) => {
    if (walkers.current.get(id)?.state !== "chat") return;
    setBubbles((x) => ({ ...x, [id]: bubble }));
    play(CUE_OF[firstMood ?? bubble.mood], { pitch: voiceOf(name, level), minGapMs: 300 });
  };
  const newTarget = (w: Walker, away?: Walker) => {
    const tz = rand(Z_NEAR + 0.8, 16);
    const hw = halfWidthAt(tz) * 0.8;
    // the egg stands near and to the right: keep the front-right corner clear for it
    const maxX = tz < Z_NEAR + 5 ? halfWidthAt(tz) * 0.45 : hw;
    w.tz = tz;
    w.tx = away ? Math.max(-hw, Math.min(maxX, w.x + (w.x < away.x ? -1 : 1) * rand(1.5, 3.5))) : rand(-hw, maxX);
    w.state = "walk";
    w.partner = undefined;
  };

  useFrame((state, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    const now = performance.now();
    // camera: gentle parallax with the pointer
    const c = cam.current;
    const p = reduced ? { x: 0, y: 0 } : pointer.current;
    c.x += (p.x * 1.4 - c.x) * Math.min(1, dt * 3);
    c.tilt += (-p.y * 0.35 - c.tilt) * Math.min(1, dt * 3);
    camera.position.set(c.x, EYE, 0);
    camera.lookAt(c.x * 0.4, LOOK_Y + c.tilt, -12);

    const list = [...walkers.current.values()];
    for (const w of list) {
      let heading = w.yaw;
      if (!reduced && w.state !== "held") {
        if (w.state === "idle" || w.state === "chat") {
          if (now >= w.until) {
            if (w.state === "chat") pending.current[w.id] = null;
            newTarget(w);
          }
        } else {
          const dx = w.tx - w.x;
          const dz = w.tz - w.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.05) { w.state = "idle"; w.until = now + rand(600, 2800); } else {
            const step = Math.min(d, w.speed * dt);
            w.x += (dx / d) * step;
            w.z += (dz / d) * step;
            heading = Math.atan2(dx, -dz); // the model faces +z; walking away from the camera is -z
          }
        }
      }
      if (w.state !== "walk") {
        const other = w.partner ? walkers.current.get(w.partner) : undefined;
        // chatting: face each other; otherwise turn (mostly) towards the camera
        heading = other ? Math.atan2(other.x - w.x, -(other.z - w.z)) : Math.atan2(c.x - w.x, w.z) * 0.6;
      }
      w.yaw = heading;
      w.drive.walk = w.state === "walk" ? 1 : 0;
      w.drive.yaw = heading;
      w.drive.hover = w.state === "held";
    }

    // meetings
    if (!reduced) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if ([a, b].some((w) => w.state === "chat" || w.state === "held")) continue;
          if (now - a.lastChat < 9000 || now - b.lastChat < 9000) continue;
          if (Math.hypot(a.x - b.x, a.z - b.z) > MEET) continue;
          const pa = projects.find((x) => x.id === a.id);
          const pb = projects.find((x) => x.id === b.id);
          if (!pa || !pb) continue;
          for (const w of [a, b]) { w.state = "chat"; w.until = now + CHAT_MS; w.lastChat = now; }
          a.partner = b.id;
          b.partner = a.id;
          const la = levelOf.get(a.id) ?? 1;
          const lb = levelOf.get(b.id) ?? 1;
          if (Math.abs(la - lb) >= 3) {
            const [young, old, lo] = la < lb ? [a, b, lb] : [b, a, la];
            const po = old === a ? pa : pb;
            pending.current[young.id] = { text: `Wow, level ${lo}!`, mood: "curious" };
            pending.current[old.id] = { text: "✦", mood: "surprised" };
            play("curious", { pitch: voiceOf((young === a ? pa : pb).pixel.name, Math.min(la, lb)), minGapMs: 300 });
            setTimeout(() => answer(old.id, po.pixel.name, lo, { text: pick(facts(po, lo)), mood: "proud" }), 1500);
          } else {
            pending.current[a.id] = { text: pick(facts(pa, la)), mood: "happy" };
            const [reply, mood] = pick(REPLIES);
            pending.current[b.id] = { text: reply, mood };
            play("hello", { pitch: voiceOf(pa.pixel.name, la), minGapMs: 300 });
            setTimeout(() => answer(b.id, pb.pixel.name, lb, { text: pick(facts(pb, lb)), mood: "proud" }, mood), 1700);
          }
        }
      }
      for (const w of list) {
        if (w.state === "walk" && pending.current[w.id] === null) {
          const other = list.find((o) => o.id !== w.id && Math.hypot(o.x - w.x, o.z - w.z) < MEET * 1.6);
          if (other) newTarget(w, other);
        }
      }
    }
    const keys = Object.keys(pending.current);
    if (keys.length) {
      const pend = { ...pending.current };
      pending.current = {};
      setBubbles((x) => {
        const n = { ...x };
        for (const k of keys) { if (pend[k]) n[k] = pend[k]!; else delete n[k]; }
        return n;
      });
    }
    void state;
  });

  const eggZ = Z_NEAR + 2.2;
  const eggX = projects.length ? halfWidthAt(eggZ) * 0.72 : 0;

  return (
    <>
      <PixelLights dim={dark} />
      <Sun dark={dark} />
      <Ground dark={dark} />
      {props.map((pr, i) => <Scenery key={i} prop={pr} dark={dark} />)}

      {projects.map((p) => {
        const w = walkers.current.get(p.id);
        if (!w) return null;
        const level = levelOf.get(p.id) ?? 1;
        const b = bubbles[p.id];
        const hovered = hover === p.id;
        const mood: PixelMood = leaving === p.id ? "happy" : b?.mood ?? (hovered ? "happy" : p.stats.images === 0 ? "sleepy" : "idle");
        return (
          <WalkingPixel key={p.id} walker={w} project={p} options={options} level={level} mood={mood} bubble={b}
            training={training === p.id}
            hovered={hovered} bounce={jump[p.id] ?? 0} animated={!reduced}
            onOver={() => setHover(p.id)} onOut={() => setHover((h) => (h === p.id ? null : h))} onClick={() => onOpen(p)} />
        );
      })}

      {loaded && <Egg x={eggX} z={eggZ} first={!projects.length} animated={!reduced} onClick={onHatch} />}
    </>
  );
}

function setCursor(on: boolean) {
  document.body.style.cursor = on ? "pointer" : "";
}

function WalkingPixel({
  walker, project: p, options, level, mood, bubble, hovered, bounce, animated, onOver, onOut, onClick, training,
}: {
  walker: Walker; project: Project; options: PixelOptions | null; level: number; mood: PixelMood; bubble?: Bubble;
  training: boolean;
  hovered: boolean; bounce: number; animated: boolean; onOver: () => void; onOut: () => void; onClick: () => void;
}) {
  const g = useRef<THREE.Group>(null);
  const drive = useRef<PixelDrive>(walker.drive);
  drive.current = walker.drive;
  const scale = STAGES[stageOf(level)].scale * PIXEL_SCALE;
  const [workout, setWorkout] = useState<"lift" | "run">("lift");
  useEffect(() => {  // dumbbells and running in turns
    if (!training) return;
    const t = setInterval(() => setWorkout((x) => (x === "lift" ? "run" : "lift")), 12000);
    return () => clearInterval(t);
  }, [training]);
  useFrame(() => { g.current?.position.set(walker.x, 0, -walker.z); });
  useEffect(() => () => setCursor(false), []);

  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onOver(); setCursor(true); };
  const out = () => { onOut(); setCursor(false); };

  return (
    <group ref={g} position={[walker.x, 0, -walker.z]}>
      <group scale={PIXEL_SCALE} onPointerOver={over} onPointerOut={out} onClick={(e) => { e.stopPropagation(); onClick(); }}>
        <PixelModel traits={p.pixel} options={options} level={level} mood={mood} bounce={bounce} drive={drive}
          animated={animated} shadows blob={false} activity={training ? workout : null} />
        {/* generous invisible hit area */}
        <mesh position-y={0.6 * scale / PIXEL_SCALE} userData={{ noShadow: true }}>
          <cylinderGeometry args={[0.5 * scale / PIXEL_SCALE, 0.5 * scale / PIXEL_SCALE, 1.3 * scale / PIXEL_SCALE, 12]} />
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      </group>
      <Html position={[0, 1.42 * scale, 0]} zIndexRange={[19000, 10]} style={{ pointerEvents: "none" }}>
        <div className="flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1 pb-1">
          {hovered && (
            <div className="w-max max-w-[16rem] animate-in fade-in zoom-in-95 rounded-2xl border bg-card/95 px-3 py-2 text-left shadow-xl backdrop-blur duration-150">
              <p className="text-sm font-semibold">{p.pixel.name} <span className="font-normal text-muted-foreground">· {p.name}</span></p>
              <p className="text-xs text-muted-foreground">
                Level {level} · {STAGES[stageOf(level)].label} · {p.stats.images} images · {p.stats.boxes} boxes
              </p>
              {training && <p className="text-xs font-medium text-amber-600 dark:text-amber-400">Training a detector right now 💪</p>}
              <p className="mt-0.5 text-[11px] font-medium text-pixel">{p.active ? "Open project · click to continue" : "Click to open this project"}</p>
            </div>
          )}
          {bubble && !hovered && (
            <div className="w-max animate-in zoom-in-75 fade-in rounded-full border bg-card px-3 py-1 text-sm font-semibold shadow-md duration-200">
              {bubble.text}
            </div>
          )}
        </div>
      </Html>
      <Html position={[0, -0.04, 0]} zIndexRange={[19000, 10]} style={{ pointerEvents: "none" }}>
        <span className={cn("mt-1 block w-max max-w-[12rem] -translate-x-1/2 truncate rounded-full px-2.5 py-0.5 text-xs font-semibold shadow-sm",
          p.active ? "bg-pixel text-white" : "bg-card/85 text-foreground/80")}>
          {p.name}
        </span>
      </Html>
    </group>
  );
}

// ---------- scenery ----------

function Sun({ dark }: { dark: boolean }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  useLayoutEffect(() => {
    const l = light.current;
    if (!l) return;
    l.target.position.set(0, 0, -11);
    scene.add(l.target);
    return () => { scene.remove(l.target); };
  }, [scene]);
  return (
    <directionalLight ref={light} position={[7, 13, -2]} intensity={dark ? 0.7 : 1.6} color={dark ? "#c7d2fe" : "#fff7e0"}
      castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0005} shadow-normalBias={0.02}
      shadow-camera-left={-18} shadow-camera-right={18} shadow-camera-top={18} shadow-camera-bottom={-18}
      shadow-camera-near={1} shadow-camera-far={50} />
  );
}

function Ground({ dark }: { dark: boolean }) {
  const flowers = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => { const r = seeded(11); return Array.from({ length: 160 }, () => ({ x: (r() - 0.5) * 60, z: Z_NEAR + r() * 40, c: r(), s: 0.06 + r() * 0.05 })); }, []);
  const hills = useMemo(() => {
    const r = seeded(5);
    return Array.from({ length: 9 }, (_, i) => ({ x: (i - 4) * 28 + (r() - 0.5) * 14, z: 75 + r() * 35, rad: 22 + r() * 18, far: r() < 0.5 }));
  }, []);
  useLayoutEffect(() => {
    const m = flowers.current;
    if (!m) return;
    const o = new THREE.Object3D();
    const col = new THREE.Color();
    data.forEach((f, i) => {
      o.position.set(f.x, f.s * 0.7, -f.z);
      o.rotation.set(0, Math.PI / 4, Math.PI / 4);
      o.scale.setScalar(f.s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, col.set(f.c < 0.33 ? "#f472b6" : f.c < 0.66 ? "#fbbf24" : "#a78bfa"));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [data]);
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-z={-60} receiveShadow>
        <planeGeometry args={[400, 260]} />
        <meshStandardMaterial color={dark ? "#173a33" : "#86e3a5"} roughness={1} />
      </mesh>
      <gridHelper args={[120, 60, dark ? "#64748b" : "#15803d", dark ? "#64748b" : "#15803d"]} position={[0, 0.003, -40]}
        onUpdate={(g: THREE.GridHelper) => { const m = g.material as THREE.Material; m.transparent = true; m.opacity = 0.09; m.depthWrite = false; }} />
      <instancedMesh ref={flowers} args={[undefined, undefined, data.length]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.6} emissiveIntensity={0} />
      </instancedMesh>
      {hills.map((h, i) => (
        <mesh key={i} position={[h.x, -h.rad * 0.12, -h.z]} scale={[1, 0.32, 0.6]}>
          <sphereGeometry args={[h.rad, 24, 12]} />
          <meshStandardMaterial color={dark ? (h.far ? "#1e2a44" : "#22324f") : (h.far ? "#a7d8c8" : "#9fe0b8")} roughness={1} />
        </mesh>
      ))}
    </>
  );
}

function Scenery({ prop: p, dark }: { prop: Prop; dark: boolean }) {
  const s = p.size;
  const k = dark ? 0.6 : 1;
  const c = (hex: string) => new THREE.Color(hex).multiplyScalar(k);
  const pos: [number, number, number] = [p.x, 0, -p.z];
  if (p.kind === "pine") {
    return (
      <group position={pos} rotation-y={p.rot}>
        <mesh position-y={0.1 * s} castShadow><cylinderGeometry args={[0.05 * s, 0.06 * s, 0.2 * s, 6]} /><meshStandardMaterial color={c("#92400e")} /></mesh>
        {[[0.36, 0.34, 0.42], [0.28, 0.58, 0.36], [0.19, 0.8, 0.3]].map(([r, y, h], i) => (
          <mesh key={i} position-y={y * s} castShadow>
            <coneGeometry args={[r * s, h * s, 7]} />
            <meshStandardMaterial color={c(i === 2 ? "#22c55e" : "#15803d")} flatShading roughness={0.8} />
          </mesh>
        ))}
      </group>
    );
  }
  if (p.kind === "tree") {
    return (
      <group position={pos} rotation-y={p.rot}>
        <mesh position-y={0.22 * s} castShadow><cylinderGeometry args={[0.05 * s, 0.065 * s, 0.44 * s, 8]} /><meshStandardMaterial color={c("#a16207")} /></mesh>
        <RoundedBox args={[0.64 * s, 0.42 * s, 0.56 * s]} radius={0.16 * s} smoothness={3} position-y={0.56 * s} castShadow>
          <meshStandardMaterial color={c("#16a34a")} roughness={0.8} />
        </RoundedBox>
        <RoundedBox args={[0.44 * s, 0.34 * s, 0.4 * s]} radius={0.13 * s} smoothness={3} position-y={0.82 * s} castShadow>
          <meshStandardMaterial color={c("#22c55e")} roughness={0.8} />
        </RoundedBox>
      </group>
    );
  }
  if (p.kind === "rock") {
    return (
      <mesh position={[p.x, 0.22 * s, -p.z]} rotation-y={p.rot} scale={[0.55 * s, 0.4 * s, 0.45 * s]} castShadow receiveShadow>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={c("#94a3b8")} flatShading roughness={0.9} />
      </mesh>
    );
  }
  return (
    <group position={pos} rotation-y={p.rot}>
      <mesh position={[-0.18 * s, 0.24 * s, 0]} castShadow><sphereGeometry args={[0.27 * s, 14, 10]} /><meshStandardMaterial color={c("#16a34a")} roughness={0.85} /></mesh>
      <mesh position={[0.14 * s, 0.3 * s, 0.02 * s]} castShadow><sphereGeometry args={[0.32 * s, 14, 10]} /><meshStandardMaterial color={c("#22c55e")} roughness={0.85} /></mesh>
      <mesh position={[0.2 * s, 0.5 * s, 0.24 * s]}><sphereGeometry args={[0.04 * s, 8, 6]} /><meshStandardMaterial color="#f472b6" /></mesh>
      <mesh position={[-0.2 * s, 0.42 * s, 0.22 * s]}><sphereGeometry args={[0.035 * s, 8, 6]} /><meshStandardMaterial color="#fbbf24" /></mesh>
    </group>
  );
}

/** The egg: hatch a new project. */
function Egg({ x, z, first, animated, onClick }: { x: number; z: number; first: boolean; animated: boolean; onClick: () => void }) {
  const g = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const geo = useMemo(() => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI;
      pts.push(new THREE.Vector2(Math.max(0.0001, 0.3 * Math.sin(a) * (1 - 0.16 * (a / Math.PI))), 0.36 * (1 - Math.cos(a))));
    }
    return new THREE.LatheGeometry(pts, 32);
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  useFrame((state, dt) => {
    const el = g.current;
    if (!el) return;
    const t = state.clock.elapsedTime;
    const ph = (t % 2.6) / 2.6;
    // a little wobble now and then, as if something inside wants out
    el.rotation.z = animated && ph > 0.7 ? Math.sin((ph - 0.7) * 40) * 0.16 * (1 - (ph - 0.7) / 0.3) : 0;
    const k = hover ? 1.12 : 1;
    el.scale.setScalar(el.scale.x + (k - el.scale.x) * Math.min(1, dt * 10));
  });
  return (
    <group position={[x, 0, -z]}>
      <group ref={g}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); setCursor(true); }}
        onPointerOut={() => { setHover(false); setCursor(false); }}
        onClick={(e) => { e.stopPropagation(); onClick(); }}>
        <mesh geometry={geo} castShadow>
          <meshPhysicalMaterial color="#fffbeb" roughness={0.45} clearcoat={0.6} />
        </mesh>
        <mesh position={[-0.13, 0.42, 0.21]} scale={[0.06, 0.06, 0.02]}><sphereGeometry args={[1, 12, 8]} /><meshStandardMaterial color="#a78bfa" /></mesh>
        <mesh position={[0.15, 0.22, 0.24]} scale={[0.08, 0.08, 0.02]}><sphereGeometry args={[1, 12, 8]} /><meshStandardMaterial color="#f472b6" /></mesh>
        <group position={[0, 0.34, 0.29]} rotation-x={-0.12}>
          <RoundedBox args={[0.2, 0.05, 0.04]} radius={0.02}><meshStandardMaterial color="#7c3aed" /></RoundedBox>
          <RoundedBox args={[0.05, 0.2, 0.04]} radius={0.02}><meshStandardMaterial color="#7c3aed" /></RoundedBox>
        </group>
      </group>
      {first && (
        <Html position={[0, 0.9, 0]} zIndexRange={[19000, 10]} style={{ pointerEvents: "none" }}>
          <span className="block w-max -translate-x-1/2 -translate-y-full rounded-full border bg-card px-3 py-1 text-sm font-semibold shadow-md">
            Hatch your first project!
          </span>
        </Html>
      )}
      <Html position={[0, -0.04, 0]} zIndexRange={[19000, 10]}>
        <button type="button" onClick={onClick} tabIndex={-1}
          className="block w-max -translate-x-1/2 rounded-full bg-card/85 px-2.5 py-0.5 text-xs font-semibold shadow-sm hover:bg-card">
          New project
        </button>
      </Html>
    </group>
  );
}
