"use client";

import Link from "next/link";
import { memo, useMemo, useState } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { AccountPanel } from "@/components/account-panel";
import type { SettingsSection } from "@/components/settings-dialog";
import type { AccountUser } from "@/lib/account";
import { sessionPath } from "@/lib/session-route";
import type { ChatSession } from "@/lib/sessions";
import { cn } from "@/lib/utils";

export type SidebarProps = {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  live: boolean;
  /** 数据存哪：游客=浏览器本地，登录=服务端 MySQL */
  storage?: "local" | "server";
  user: AccountUser | null;
  onOpenSettings: (section?: SettingsSection) => void;
  /** 折叠成图标轨（只影响桌面端；移动端抽屉永远是展开的） */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  variant?: "desktop" | "mobile";
};

const RAIL_WIDTH = 68;

// Next 的开发浮标（左下角那个 N）会正好压在图标轨最底部，
// 开发时给账号头像多留一点下边距，生产环境不需要。
const RAIL_FOOTER_PAD = process.env.NODE_ENV === "production" ? "pb-2" : "pb-12";

/**
 * 侧栏。**memo 的**：会话列表、当前选中、各种回调引用都不随聊天状态（草稿、token、
 * 光标）变化，所以打字和流式不该把 37 行会话重渲染一遍。
 */
export const Sidebar = memo(function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  live,
  storage = "local",
  user,
  onOpenSettings,
  collapsed = false,
  onToggleCollapse,
  variant = "desktop",
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const rail = variant === "desktop" && collapsed;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(keyword));
  }, [sessions, query]);

  function startRename(session: ChatSession) {
    setEditingId(session.id);
    setDraft(session.title);
  }

  function commitRename(sessionId: string) {
    const next = draft.trim();
    if (next) onRename(sessionId, next);
    setEditingId(null);
    setDraft("");
  }

  return (
    <aside
      data-collapsed={rail ? "true" : "false"}
      style={{ width: rail ? RAIL_WIDTH : 264 }}
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar",
        // 折叠/展开时宽度做一次动画；只动 width，不折腾布局
        "transition-[width] duration-200 ease-out",
      )}
    >
      {/* 顶部：品牌 + 折叠开关 */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-2",
          rail ? "justify-center px-2" : "px-3.5",
        )}
      >
        {rail ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="展开侧栏"
            title="展开侧栏"
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelLeftOpen size={16} />
          </button>
        ) : (
          <>
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles size={15} strokeWidth={2.2} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight">
              chat-mini
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                live ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
              )}
            >
              {live ? "live" : "未配置"}
            </span>
            {variant === "desktop" ? (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="收起侧栏"
                title="收起侧栏"
                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <PanelLeftClose size={15} />
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* 新对话 */}
      <div className={cn("pb-2", rail ? "px-2" : "px-2.5")}>
        <button
          type="button"
          onClick={onNew}
          aria-label="新对话"
          title="新对话"
          className={cn(
            "flex items-center rounded-xl border border-border bg-background text-sm text-foreground transition-colors hover:bg-muted",
            rail ? "size-9 justify-center" : "w-full gap-2 px-3 py-2",
          )}
        >
          <Plus size={15} />
          {rail ? null : "新对话"}
        </button>
      </div>

      {/* 搜索（图标轨里没地方放输入框，展开后再搜） */}
      {rail ? null : (
        <div className="px-2.5 pb-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-transparent bg-muted/60 px-2 py-1.5 transition-colors focus-within:border-border focus-within:bg-background">
            <Search size={13} className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="搜索会话"
              aria-label="搜索会话"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="清空搜索"
                className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* 会话列表 */}
      {rail ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <p className="px-2.5 py-2 text-[11px] font-medium text-muted-foreground">
            {query ? `匹配 ${filtered.length} 条` : "最近"}
          </p>

          {filtered.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-[12px] leading-5 text-muted-foreground">
              {query ? `没有匹配「${query}」的会话` : "还没有会话，点上面「新对话」开始"}
            </p>
          ) : null}

          <div className="space-y-0.5">
            {filtered.map((session) => {
              const isActive = session.id === activeId;
              const isEditing = editingId === session.id;

              if (isEditing) {
                return (
                  <div
                    key={session.id}
                    data-session-row={session.id}
                    className="flex items-center rounded-lg bg-muted px-1.5 py-1"
                  >
                    <input
                      // biome-ignore lint/a11y/noAutofocus: 进入改名态就该直接能打字
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commitRename(session.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename(session.id);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingId(null);
                          setDraft("");
                        }
                      }}
                      aria-label="会话名称"
                      className="min-w-0 flex-1 rounded-md bg-background px-2 py-1 text-[13px] outline-none ring-1 ring-primary/50"
                    />
                  </div>
                );
              }

              return (
                <div
                  key={session.id}
                  data-session-row={session.id}
                  className={cn(
                    "group flex items-center rounded-lg transition-colors",
                    isActive ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  {/* 真链接，不是 button：中键新开标签页、右键复制链接、hover 预取都靠它。
                      onClick 只同步状态（内容立刻切），URL 由 href 提交。
                      已经在当前会话上时 preventDefault，免得双击重命名时多压一条历史。 */}
                  <Link
                    href={sessionPath(session.id)}
                    onClick={(event) => {
                      if (window.location.pathname === sessionPath(session.id)) event.preventDefault();
                      onSelect(session.id);
                    }}
                    onDoubleClick={() => startRename(session)}
                    data-session-id={session.id}
                    title={session.title}
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-[13px]",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {session.title}
                  </Link>
                  <button
                    type="button"
                    onClick={() => startRename(session)}
                    aria-label="重命名会话"
                    title="重命名"
                    className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(session.id)}
                    aria-label="删除会话"
                    title="删除会话"
                    className="mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 底部：会话统计（折叠时让位给账号头像） */}
      {rail ? null : (
        <div className="px-3.5 py-2 text-[11px] text-muted-foreground">
          {query ? `${filtered.length} / ${sessions.length}` : sessions.length} 个会话 ·{" "}
          {storage === "server" ? "已同步到服务端" : "存在浏览器本地"}
        </div>
      )}

      <div
        className={cn(
          "border-t border-sidebar-border p-2",
          rail || variant === "mobile" ? RAIL_FOOTER_PAD : "",
        )}
      >
        <AccountPanel user={user} collapsed={rail} onOpenSettings={onOpenSettings} />
      </div>
    </aside>
  );
});
