export type ThemeMode = "light" | "dark" | "system";

export const THEME_KEY = "kweeto-theme";

/** Inline script run before paint, so there is no light flash in dark mode. */
export const themeInitScript = `(function(){try{var m=localStorage.getItem("${THEME_KEY}")||"system";var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export function getThemeMode(): ThemeMode {
  try {
    const m = localStorage.getItem(THEME_KEY);
    return m === "light" || m === "dark" ? m : "system";
  } catch {
    return "system";
  }
}

export function isDarkMode(mode: ThemeMode) {
  return mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage unavailable: still apply for this page */
  }
  document.documentElement.classList.toggle("dark", isDarkMode(mode));
  window.dispatchEvent(new CustomEvent("kweeto-theme", { detail: mode }));
}
