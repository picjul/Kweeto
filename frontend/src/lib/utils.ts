import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Words for Pixel's confidence levels (the raw score is not a calibrated probability, so no "%"). */
export const LEVEL_LABEL: Record<"sure" | "fair" | "unsure", string> = { sure: "sure", fair: "maybe", unsure: "guess" };
