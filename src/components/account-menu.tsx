"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { LogOut, UserRound } from "lucide-react";

export type AccountUser = { id: string; username: string; displayName: string };

/**
 * 顶栏的账号区：未登录给一个"登录"入口，已登录显示名字 + 登出。
 * 游客仍然可以正常聊天（决策 D3），所以这里不做强制拦截。
 */
export function AccountMenu({ user }: { user: AccountUser | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <Link
        href="/login"
        className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <UserRound size={13} />
        登录
      </Link>
    );
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 网络失败也让界面回到未登录态，cookie 可能已经失效了
    }
    router.refresh();
    setBusy(false);
  }

  return (
    <div className="flex shrink-0 items-center gap-1 rounded-full border border-border pl-2.5 pr-1 py-0.5">
      <span className="max-w-[8rem] truncate text-xs text-foreground" title={user.username}>
        {user.displayName}
      </span>
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        aria-label="退出登录"
        title="退出登录"
        className="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <LogOut size={13} />
      </button>
    </div>
  );
}
