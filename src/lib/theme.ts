/**
 * 主题三态：跟随系统 / 浅色 / 深色。
 *
 * 落地方式刻意保持"朴素"：只操作 <html class="dark">，样式侧靠 CSS 变量 + `@custom-variant dark`
 * 切换。不引 next-themes，理由和本项目其它地方一致——这块逻辑一共几十行，自己能看完。
 */
export type ThemeMode = "light" | "dark" | "system";

export const THEME_KEY = "chat-mini/theme/v1";

const DARK_MEDIA = "(prefers-color-scheme: dark)";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function readTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return isThemeMode(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function writeTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // 隐私模式下 localStorage 可能抛错，忽略即可
  }
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(DARK_MEDIA).matches;
}

export function resolveIsDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/** 把主题落到 DOM 上：class 供 Tailwind / streamdown 用，color-scheme 供浏览器原生控件用 */
export function applyIsDark(isDark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * 首屏防闪白：在 React 之前跑的内联脚本。
 * 直接内联在 <head> 里，避免"先白一帧再变黑"。
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var m=localStorage.getItem(${JSON.stringify(THEME_KEY)})||"system";
var d=m==="dark"||(m!=="light"&&window.matchMedia(${JSON.stringify(DARK_MEDIA)}).matches);
var r=document.documentElement;
r.classList.toggle("dark",d);
r.style.colorScheme=d?"dark":"light";
}catch(e){}})();`;
