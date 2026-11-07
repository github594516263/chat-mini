"use client";

/**
 * 界面偏好（纯前端，只存 localStorage）。
 * 侧栏折叠属于"这台设备上我怎么看"，不是数据，不落库也不同步。
 */
const SIDEBAR_KEY = "chat-mini:sidebar-collapsed";

export function readSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // 无痕模式写不进去就算了，本次会话内 state 还在
  }
}
