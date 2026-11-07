"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

type Mode = "login" | "register";

const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary placeholder:text-muted-foreground disabled:opacity-60";

export function LoginForm({ allowRegister }: { allowRegister: boolean }) {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setError(null);
    setHint(null);

    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };

      if (!response.ok) {
        setError(data.error ?? "操作失败");
        setHint(data.hint ?? null);
        return;
      }

      // 用 replace 而不是 push：登录成功后不该能按后退回到登录页
      router.replace("/");
      router.refresh();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <div className="mb-6 text-center">
        <h1 className="text-lg font-semibold">chat-mini</h1>
        <p className="mt-1 text-xs text-muted-foreground">登录后对话会存到自己的账号里，换设备也能看到</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        {allowRegister ? (
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
            {(
              [
                ["login", "登录"],
                ["register", "注册"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                  setHint(null);
                }}
                className={cn(
                  "rounded-md py-1.5 font-medium transition-colors",
                  mode === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              required
              disabled={busy}
              className={FIELD}
              placeholder="字母、数字、下划线"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              disabled={busy}
              className={FIELD}
              placeholder={mode === "register" ? "至少 8 位" : ""}
            />
          </label>

          {mode === "register" ? (
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">再输一次密码</span>
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
                disabled={busy}
                className={FIELD}
              />
            </label>
          ) : null}

          {error ? (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <p>{error}</p>
              {hint ? <p className="mt-1 opacity-80">{hint}</p> : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>

        {!allowRegister ? (
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            本实例未开放注册，账号由管理员创建
          </p>
        ) : null}
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        不想登录？
        <a href="/" className="mx-1 text-primary hover:underline">
          以游客身份继续
        </a>
        （对话只存在这台电脑的浏览器里）
      </p>
    </div>
  );
}
