"use client";

import { Plus, Sparkles, Trash2 } from "lucide-react";

import type { ChatSession } from "@/lib/sessions";
import { cn } from "@/lib/utils";

type SidebarProps = {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  live: boolean;
};

export function Sidebar({ sessions, activeId, onSelect, onNew, onDelete, live }: SidebarProps) {
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <p className="px-2.5 py-2 text-[11px] font-medium text-muted-foreground">最近</p>
        <div className="space-y-0.5">
          {sessions.map((session) => {
            const isActive = session.id === activeId;
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
                  onClick={() => onDelete(session.id)}
                  aria-label="删除会话"
                  title="删除会话"
                  className="mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border px-3.5 py-2.5 text-[11px] text-muted-foreground">
        {sessions.length} 个会话 · 存在浏览器本地
      </div>
    </aside>
  );
}
