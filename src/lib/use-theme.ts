"use client";

import { useCallback, useEffect, useState } from "react";

import {
  applyIsDark,
  readTheme,
  resolveIsDark,
  type ThemeMode,
  writeTheme,
} from "@/lib/theme";

/**
 * 主题状态。三件事：
 * 1. 挂载后读 localStorage（并用 DOM 上已由内联脚本设好的状态兜底，不等一帧）
 * 2. mode=system 时监听系统配色变化
 * 3. 任何变化都只写回 <html> 的 class，不触发整棵树重渲染之外的副作用
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [systemDark, setSystemDark] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setMode(readTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(media.matches);
    setReady(true);

    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const isDark = resolveIsDark(mode, systemDark);

  useEffect(() => {
    if (!ready) return;
    applyIsDark(isDark);
  }, [isDark, ready]);

  const setTheme = useCallback((next: ThemeMode) => {
    writeTheme(next);
    setMode(next);
  }, []);

  return { mode, isDark, setTheme };
}
