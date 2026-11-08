"use client";

import { useEffect, type ReactNode } from "react";
import {
  Brain,
  Check,
  Info,
  LogOut,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";

import type { AccountUser } from "@/lib/account";
import { initialsOf } from "@/lib/account";
import { logoutRequest } from "@/lib/client-auth";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useModelContext } from "@/components/model-context";

/**
 * 设置面板（框架版）。
 * 结构先立住：左分类 / 右内容，分类之间互不影响；每块里已经把"真能用的"
 * 和"待接入的"分开标好了，接后端时只替换对应那一块，不用动布局。
 */

export type SettingsSection = "general" | "appearance" | "account" | "memory" | "about";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Info; hint: string }[] = [
  { id: "general", label: "通用", icon: SlidersHorizontal, hint: "启动页、发送方式、语言" },
  { id: "appearance", label: "外观", icon: Palette, hint: "浅色 / 深色 / 跟随系统" },
  { id: "account", label: "账号与安全", icon: ShieldCheck, hint: "资料、密码、登录状态" },
  { id: "memory", label: "记忆与进化", icon: Brain, hint: "长期记忆与偏好自学习" },
  { id: "about", label: "关于", icon: Info, hint: "版本与运行时" },
];

const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: "light", label: "浅色", hint: "白天" },
  { value: "dark", label: "深色", hint: "夜间" },
  { value: "system", label: "跟随系统", hint: "由操作系统决定" },
];

export type SettingsDialogProps = {
  open: boolean;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  user: AccountUser | null;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  live: boolean;
  storage: "local" | "server";
};

export function SettingsDialog({
  open,
  section,
  onSectionChange,
  onClose,
  user,
  themeMode,
  onThemeChange,
  live,
  storage,
}: SettingsDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label="关闭设置"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-foreground/25 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="relative flex h-[min(620px,88vh)] w-[min(880px,96vw)] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        {/* 左：分类 */}
        <nav className="hidden w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar p-2 sm:flex">
          <p className="px-2.5 pt-2 pb-3 text-[11px] font-medium text-muted-foreground">设置</p>
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSectionChange(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon size={14} className="shrink-0" />
                {item.label}
              </button>
            );
          })}
          <p className="mt-auto px-2.5 pb-1 text-[11px] leading-5 text-muted-foreground">
            框架版：灰色「待接入」的项还没连后端
          </p>
        </nav>

        {/* 右：内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium">{current.label}</h2>
              <p className="truncate text-[11px] text-muted-foreground">{current.hint}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X size={15} />
            </button>
          </header>

          {/* 窄屏没有左侧分类，用横向 chip 顶上 */}
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2 sm:hidden">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSectionChange(item.id)}
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-[12px] transition-colors",
                  item.id === section
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {section === "general" ? <GeneralPane /> : null}
            {section === "appearance" ? (
              <AppearancePane mode={themeMode} onChange={onThemeChange} />
            ) : null}
            {section === "account" ? <AccountPane user={user} storage={storage} /> : null}
            {section === "memory" ? <MemoryPane /> : null}
            {section === "about" ? <AboutPane live={live} storage={storage} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{label}</p>
        {hint ? <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children ?? <Soon />}</div>
    </div>
  );
}

function Soon() {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
      待接入
    </span>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-0.5 text-[11px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function GeneralPane() {
  return (
    <div className="space-y-5">
      <Panel title="交互">
        <Field label="默认落地页" hint="每次打开站点先进入的页面">
          <span className="text-[12px] text-muted-foreground">新对话</span>
        </Field>
        <Field label="发送方式" hint="Enter 发送，Shift+Enter 换行（当前固定）">
          <span className="text-[12px] text-muted-foreground">Enter</span>
        </Field>
        <Field label="打开设置" hint="全局快捷键，和浏览器「首选项」同一套肌肉记忆">
          <kbd className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            Ctrl+,
          </kbd>
        </Field>
      </Panel>

      <Panel title="界面">
        <Field label="侧栏折叠" hint="侧栏左上角的按钮，或记住上次的状态">
          <span className="text-[12px] text-muted-foreground">已记住</span>
        </Field>
        <Field label="界面语言" hint="目前只有简体中文">
          <span className="text-[12px] text-muted-foreground">简体中文</span>
        </Field>
      </Panel>
    </div>
  );
}

function AppearancePane({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="space-y-5">
      <Panel title="主题">
        <div className="grid gap-2 sm:grid-cols-3">
          {THEME_OPTIONS.map((option) => {
            const active = option.value === mode;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onChange(option.value)}
                aria-pressed={active}
                className={cn(
                  "rounded-xl border px-3 py-3 text-left transition-colors",
                  active
                    ? "border-primary/60 bg-muted"
                    : "border-border hover:bg-muted/60",
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] text-foreground">
                  {option.label}
                  {active ? <Check size={12} className="text-primary" /> : null}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {option.hint}
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="排版">
        <Field label="消息字号" hint="当前跟随浏览器缩放" />
        <Field label="代码主题" hint="随主题自动切换（shiki 深浅两套）">
          <span className="text-[12px] text-muted-foreground">自动</span>
        </Field>
      </Panel>
    </div>
  );
}

function AccountPane({ user, storage }: { user: AccountUser | null; storage: "local" | "server" }) {
  if (!user) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-foreground">当前是游客模式</p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            游客也能正常聊天，对话只存在这台电脑的浏览器里。
            <br />
            登录后对话会存到服务端，换设备还能看到。
          </p>
          <a
            href="/login"
            className="mt-3 inline-flex rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            去登录
          </a>
        </div>
        <Field label="账号数据" hint="当前存在浏览器本地（localStorage）">
          <Soon />
        </Field>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
          {initialsOf(user)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-foreground">{user.displayName}</p>
          <p className="truncate text-[11px] text-muted-foreground">@{user.username}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          体验版
        </span>
      </div>

      <Panel title="资料">
        <Field label="用户名" hint="登录用的账号名，暂不支持修改">
          <span className="font-mono text-[12px] text-muted-foreground">{user.username}</span>
        </Field>
        <Field label="显示名" hint="侧栏和对话里展示的名字" />
        <Field label="修改密码" hint="改完会踢掉其它设备上的登录" />
      </Panel>

      <Panel title="数据与登录">
        <Field
          label="对话存储"
          hint={storage === "server" ? "已同步到服务端 MySQL" : "存在浏览器本地"}
        >
          <span className="text-[12px] text-muted-foreground">
            {storage === "server" ? "服务端" : "本地"}
          </span>
        </Field>
        <Field label="登录设备" hint="查看并下线其它设备的会话" />
        <button
          type="button"
          onClick={() => void logoutRequest().then(() => window.location.assign("/login"))}
          className="flex w-full items-center gap-2 rounded-xl border border-border px-3.5 py-3 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/5"
        >
          <LogOut size={14} />
          退出登录
        </button>
      </Panel>
    </div>
  );
}

function MemoryPane() {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-dashed border-border px-4 py-5">
        <p className="text-[13px] text-foreground">这一块还没接</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          计划：把「用户长期偏好 / 常用上下文」抽成可查看、可删除的条目，
          生成时按需注入，而不是每次都靠提示词猜。
        </p>
      </div>
      <Panel title="开关">
        <Field label="启用长期记忆" hint="跨会话保留偏好与事实" />
        <Field label="从对话里自动提炼" hint="每 N 轮总结一次，需人工确认" />
      </Panel>
      <Panel title="内容">
        <Field label="已记住的条目" hint="目前 0 条" />
        <Field label="导出 / 清空" hint="一次删干净，不留副本" />
      </Panel>
    </div>
  );
}

function AboutPane({ live, storage }: { live: boolean; storage: "local" | "server" }) {
  const model = useModelContext();

  return (
    <div className="space-y-5">
      <Panel title="版本">
        <Field label="chat-mini" hint="自研事件协议 · 无 AI SDK">
          <span className="font-mono text-[12px] text-muted-foreground">0.1.0</span>
        </Field>
        <Field label="运行时" hint="Next 16 · React 19 · Tailwind v4">
          <span className="text-[12px] text-muted-foreground">Turbopack</span>
        </Field>
        <Field label="模型" hint="在输入框下方随时切换">
          <span className="text-[12px] text-muted-foreground">
            {model.selected?.label ?? "—"}
          </span>
        </Field>
        <Field label="数据源" hint={live ? "已配置 API Key，走真实模型" : "未配置 Key，走假数据流"}>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              live ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
            )}
          >
            {live ? "live" : "mock"}
          </span>
        </Field>
        <Field label="账号数据" hint={storage === "server" ? "服务端 MySQL" : "浏览器本地"}>
          <span className="text-[12px] text-muted-foreground">
            {storage === "server" ? "服务端" : "本地"}
          </span>
        </Field>
      </Panel>

      <Panel title="自查">
        <a
          href="/preview"
          className="flex items-center justify-between rounded-xl border border-border px-3.5 py-3 text-[13px] transition-colors hover:bg-muted/60"
        >
          渲染自检页
          <span className="text-[11px] text-muted-foreground">/preview</span>
        </a>
        <a
          href="/api/health"
          className="flex items-center justify-between rounded-xl border border-border px-3.5 py-3 text-[13px] transition-colors hover:bg-muted/60"
        >
          数据库自检
          <span className="text-[11px] text-muted-foreground">/api/health</span>
        </a>
      </Panel>
    </div>
  );
}
