/**
 * Readable accents (WCAG AA, 4.5:1 for text). Every project tints the UI with its Pixel's colour; some colours
 * (amber, lime, teal...) are too light for white text on them, or too pale as text on a white card. From one
 * accent we derive, per theme:
 * - fill: the accent for backgrounds; nudged darker (at most MAX_NUDGE points) when that is enough for white text,
 *         else lightened just enough for near-black text;
 * - on:   the text colour on the fill: white, or near-black when white would need a different colour;
 * - fg:   the accent as TEXT colour, darkened (light theme) or lightened (dark theme) until it reads on the
 *         background and on cards.
 * Values are "H S% L%" strings, like the CSS variables they feed (--pixel, --pixel-on, --pixel-fg).
 */

type Hsl = [number, number, number];

const MAX_NUDGE = 5;
const DARK: Hsl = [248, 30, 8];
const DARK_TEXT = "248 30% 8%";
// the surfaces text sits on (globals.css: --background and --card)
const SURFACES: Record<"light" | "dark", Hsl[]> = {
  light: [[250, 33, 98.5], [0, 0, 100]],
  dark: [[248, 32, 6.5], [248, 28, 10]],
};

function parse(hsl: string): Hsl {
  const [h, s, l] = hsl.replace(/%/g, "").split(/\s+/).map(Number);
  return [h || 0, s || 0, l || 0];
}

const str = ([h, s, l]: Hsl) => `${h} ${s}% ${Math.round(l * 10) / 10}%`;

function rgb([h, s, l]: Hsl): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(c: Hsl): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(c).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Hsl, b: Hsl): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const WHITE: Hsl = [0, 0, 100];

export function readableAccent(accent: string, theme: "light" | "dark"): { fill: string; on: string; fg: string } {
  const [h, s, l] = parse(accent);
  // fill + text on it
  let fillL = l;
  while (fillL > l - MAX_NUDGE && contrast(WHITE, [h, s, fillL]) < 4.5) fillL -= 0.5;
  const whiteOk = contrast(WHITE, [h, s, fillL]) >= 4.5;
  if (!whiteOk) { // near-black text instead: lighten the fill just enough for it
    fillL = l;
    while (fillL < 92 && contrast(DARK, [h, s, fillL]) < 4.5) fillL += 0.5;
  }
  const fill: Hsl = [h, s, fillL];
  // the accent as text
  let fgL = l;
  const step = theme === "light" ? -0.5 : 0.5;
  const reads = (L: number) => SURFACES[theme].every((bg) => contrast([h, s, L], bg) >= 4.5);
  while (fgL > 3 && fgL < 97 && !reads(fgL)) fgL += step;
  return { fill: str(fill), on: whiteOk ? "0 0% 100%" : DARK_TEXT, fg: str([h, s, fgL]) };
}
