"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Sidebar, type SidebarProps } from "@/components/sidebar";
import { SettingsDialog, type SettingsSection } from "@/components/settings-dialog";
import type { AccountUser } from "@/lib/account";
import type { ThemeMode } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { readSidebarCollapsed, writeSidebarCollapsed } from "@/lib/ui-prefs";

/**
 * 页面骨架：左侧栏（可折叠 / 移动端抽屉）+ 右侧内容 + 设置面板。
 * 它只管"壳"和壳上的状态，具体内容是 children。
 *
 * 折叠、主题、设置开没开都属于壳的状态，所以收在这里，通过 context 给内容用，
 * 避免主题在多个组件里各持一份 state 互相打架。
 */

type AppShellApi = {
  /** 桌面端侧栏是否折叠 */
  collapsed: boolean;
  toggleSidebar: () => void;
  /** 移动端打开抽屉 */
  openMobileSidebar: () => void;
  openSettings: (section?: SettingsSection) => void;
  themeMode: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  /** 当前是否接了真实模型（顶栏要显示 live / 未配置） */
  live: boolean;
};

const AppShellContext = createContext<AppShellApi | null>(null);

export function useAppShell() {
  const api = useContext(AppShellContext);
  if (!api) throw new Error("useAppShell 必须在 <AppShell> 内使用");
  return api;
}

type AppShellProps = Omit<
  SidebarProps,
  "user" | "collapsed" | "onToggleCollapse" | "variant" | "onOpenSettings"
> & {
  user: AccountUser | null;
  live: boolean;
  storage: "local" | "server";
  children: ReactNode;
};

export function AppShell({ user, live, storage, children, ...sidebarProps }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("general");

  const { mode: themeMode, setTheme } = useTheme();

  // 折叠是纯视图偏好：挂载后再读 localStorage，别让 SSR 和首帧打架
  useEffect(() => {
    setCollapsed(readSidebarCollapsed());
  }, []);

  const toggleSidebar = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  const openMobileSidebar = useCallback(() => setMobileOpen(true), []);

  const openSettings = useCallback((next?: SettingsSection) => {
    if (next) setSection(next);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Ctrl/⌘ + , ——和浏览器「首选项」同一套肌肉记忆
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const api = useMemo<AppShellApi>(
    () => ({ collapsed, toggleSidebar, openMobileSidebar, openSettings, themeMode, setTheme, live }),
    [collapsed, toggleSidebar, openMobileSidebar, openSettings, themeMode, setTheme, live],
  );

  return (
    <AppShellContext.Provider value={api}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <div className="hidden md:block">
          <Sidebar
            {...sidebarProps}
            user={user}
            live={live}
            storage={storage}
            collapsed={collapsed}
            onToggleCollapse={toggleSidebar}
            onOpenSettings={openSettings}
          />
        </div>

        {/* 移动端：抽屉 + 遮罩，动作完成后自动收起来 */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-30 flex md:hidden">
            <Sidebar
              {...sidebarProps}
              user={user}
              live={live}
              storage={storage}
              variant="mobile"
              onOpenSettings={(next) => {
                setMobileOpen(false);
                openSettings(next);
              }}
              onSelect={(id) => {
                sidebarProps.onSelect(id);
                setMobileOpen(false);
              }}
              onNew={() => {
                sidebarProps.onNew();
                setMobileOpen(false);
              }}
              onDelete={sidebarProps.onDelete}
              onRename={sidebarProps.onRename}
            />
            <button
              type="button"
              aria-label="关闭侧栏"
              onClick={() => setMobileOpen(false)}
              // 同上：抽屉遮罩也用纯色，避免全屏 backdrop-filter 拖累滚动
              className="flex-1 bg-foreground/25"
            />
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        section={section}
        onSectionChange={setSection}
        onClose={closeSettings}
        user={user}
        themeMode={themeMode}
        onThemeChange={setTheme}
        live={live}
        storage={storage}
      />
    </AppShellContext.Provider>
  );
}
