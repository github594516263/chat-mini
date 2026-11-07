"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  ChevronUp,
  LogOut,
  MessageSquare,
  Palette,
  RefreshCw,
  Settings,
  UserRound,
} from "lucide-react";

import type { SettingsSection } from "@/components/settings-dialog";
import { initialsOf, type AccountUser } from "@/lib/account";
import { logoutRequest } from "@/lib/client-auth";
import { cn } from "@/lib/utils";

/**
 * 侧栏底部的账号区。
 * 点开是一张「账号信息 + 设置入口」的卡片：上面是身份和额度，
 * 下面是一列设置项——点哪项就开设置面板并直接落到对应分类。
 *
 * 折叠态只显示头像，卡片照样从他头上弹出来。
 */
export function AccountPanel({
  user,
  collapsed = false,
  onOpenSettings,
}: {
  user: AccountUser | null;
  collapsed?: boolean;
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    await logoutRequest();
    router.refresh();
    setBusy(false);
  }

  function go(section: SettingsSection) {
    setOpen(false);
    onOpenSettings(section);
  }

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={user ? `${user.displayName}（${user.username}）` : "未登录"}
        className={cn(
          "flex w-full items-center rounded-xl text-left transition-colors hover:bg-muted/70",
          collapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-2",
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-medium text-primary-foreground">
          {user ? initialsOf(user) : <UserRound size={14} />}
        </span>
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground">
                {user ? user.displayName : "未登录"}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {user ? "体验版" : "游客模式 · 对话存在本地"}
              </span>
            </span>
            <ChevronUp
              size={14}
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                open ? "rotate-180" : "",
              )}
            />
          </>
        )}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="账号信息"
          className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-[280px] overflow-hidden rounded-2xl border border-border bg-popover p-1.5 shadow-xl"
        >
          {user ? (
            <>
              {/* 账号信息 */}
              <div className="flex items-center gap-2.5 px-1.5 py-1.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-[13px] font-medium text-primary-foreground">
                  {initialsOf(user)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {user.displayName}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">@{user.username}</p>
                </div>
              </div>

              <div className="mt-1 grid grid-cols-2 gap-1.5 px-1.5 pb-1.5">
                <div className="rounded-xl border border-border px-2.5 py-2">
                  <p className="text-[10px] text-muted-foreground">套餐</p>
                  <p className="mt-0.5 text-[12px] text-foreground">体验版</p>
                </div>
                <div className="rounded-xl border border-border px-2.5 py-2">
                  <p className="text-[10px] text-muted-foreground">用量</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">待接入</p>
                </div>
              </div>
            </>
          ) : (
            <div className="px-1.5 py-1.5">
              <p className="text-[13px] font-medium text-foreground">游客模式</p>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                对话只存在这台电脑的浏览器里，登录后才会同步到服务端。
              </p>
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="mt-2 flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <UserRound size={13} />
                登录 / 注册
              </Link>
            </div>
          )}

          <div className="my-1 h-px bg-border" />

          <div className="p-0.5">
            <MenuItem icon={Settings} label="设置" shortcut="Ctrl+," onClick={() => go("general")} />
            <MenuItem icon={Palette} label="外观" onClick={() => go("appearance")} />
            <MenuItem icon={Brain} label="记忆与进化" onClick={() => go("memory")} />
            <MenuItem icon={MessageSquare} label="意见反馈" disabled hint="待接入" />
            <MenuItem icon={RefreshCw} label="检查更新" disabled hint="已是最新" />
          </div>

          {user ? (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="p-0.5">
                <MenuItem
                  icon={LogOut}
                  label="退出登录"
                  onClick={() => void logout()}
                  danger
                  disabled={busy}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  shortcut,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Settings;
  label: string;
  hint?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? hint : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
        danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-muted",
        disabled ? "cursor-default text-muted-foreground/70 hover:bg-transparent" : "",
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint || shortcut ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{shortcut ?? hint}</span>
      ) : null}
    </button>
  );
}
