"use client";

import { useMemo, useRef, useState } from "react";
import { Pencil, Plus, Search, Sparkles, Trash2, X } from "lucide-react";

import type { ChatSession } from "@/lib/sessions";
import { cn } from "@/lib/utils";

type SidebarProps = {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  live: boolean;
};

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  live,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-3.5">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles size={15} strokeWidth={2.2} />
        </span>
        <span className="text-sm font-medium tracking-tight">chat-mini</span>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium",
            live ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
          )}
        >
          {live ? "live" : "mock"}
        </span>
      </div>

      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={onNew}
          aria-label="新对话"
          className="flex w-full items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
        >
          <Plus size={15} />
          新对话
        </button>
      </div>

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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <p className="px-2.5 py-2 text-[11px] font-medium text-muted-foreground">
          {query ? `匹配 ${filtered.length} 条` : "最近"}
        </p>

        {filtered.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[12px] text-muted-foreground">
            没有匹配「{query}」的会话
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
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  onDoubleClick={() => startRename(session)}
                  data-session-id={session.id}
                  title={session.title}
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-[13px]",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {session.title}
                </button>
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

      <div className="border-t border-border px-3.5 py-2.5 text-[11px] text-muted-foreground">
        {query ? `${filtered.length} / ${sessions.length}` : sessions.length} 个会话 · 存在浏览器本地
      </div>
    </aside>
  );
}
