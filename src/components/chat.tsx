"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Copy, PanelLeft, Pencil, RotateCcw, Square } from "lucide-react";
import { Streamdown, type StreamdownTranslations } from "streamdown";
import { code } from "@streamdown/code";

import { Sidebar } from "@/components/sidebar";
import { ThemeMenu } from "@/components/theme-menu";
import { useChat, type ChatUIMessage } from "@/lib/use-chat";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

const PLUGINS = { code };

const TRANSLATIONS: Partial<StreamdownTranslations> = {
  copyCode: "复制",
  copied: "已复制",
  copyTable: "复制表格",
  copyTableAsMarkdown: "复制为 Markdown",
  copyTableAsCsv: "复制为 CSV",
  copyTableAsTsv: "复制为 TSV",
  downloadFile: "下载",
  downloadTable: "下载表格",
  downloadTableAsMarkdown: "下载为 Markdown",
  downloadTableAsCsv: "下载为 CSV",
  copyLink: "复制链接",
  openLink: "打开链接",
};

const SUGGESTIONS = [
  "解释一下这套事件协议为什么用 seq",
  "给我写一个 React 的防抖 hook",
  "用表格对比 streamdown 和 react-markdown",
  "这段话帮我翻译成英文：把协议握在自己手里",
];

const ACTION_BTN =
  "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export default function Chat({ live }: { live: boolean }) {
  const {
    sessions,
    activeId,
    activeSession,
    messages,
    streaming,
    send,
    stop,
    regenerate,
    editAndResend,
    continueGeneration,
    newSession,
    selectSession,
    deleteSession,
    renameSession,
  } = useChat();

  const { mode: themeMode, setTheme } = useTheme();

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // 切会话时清空输入框与编辑态
  useEffect(() => {
    setInput("");
    setEditingId(null);
    setDraft("");
  }, [activeId]);

  // 生成中刷新/关页面会中断，浏览器拦一下（内容不会丢，但生成会停）
  useEffect(() => {
    if (!streaming) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [streaming]);

  function submit() {
    if (streaming || !input.trim()) return;
    const value = input;
    setInput("");
    void send(value);
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <div className="hidden md:block">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={selectSession}
          onNew={newSession}
          onDelete={deleteSession}
          onRename={renameSession}
          live={live}
        />
      </div>

      {sidebarOpen ? (
        <div className="fixed inset-0 z-30 flex md:hidden">
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            onSelect={(id) => {
              selectSession(id);
              setSidebarOpen(false);
            }}
            onNew={() => {
              newSession();
              setSidebarOpen(false);
            }}
            onDelete={deleteSession}
            onRename={renameSession}
            live={live}
          />
          <button
            type="button"
            aria-label="关闭侧栏"
            onClick={() => setSidebarOpen(false)}
            className="flex-1 bg-foreground/20 backdrop-blur-sm"
          />
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开侧栏"
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          >
            <PanelLeft size={16} />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {activeSession?.title ?? "新对话"}
          </h1>
          <ThemeMenu mode={themeMode} onSelect={setTheme} />
          <span className="hidden shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground sm:inline">
            deepseek-chat
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium md:hidden",
              live ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
            )}
          >
            {live ? "live" : "mock"}
          </span>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <Hero
              onPick={(text) => {
                setInput(text);
                textareaRef.current?.focus();
              }}
            />
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
              {messages.map((message) => (
                <Bubble
                  key={message.id}
                  message={message}
                  streaming={streaming}
                  editing={editingId === message.id}
                  draft={draft}
                  onDraftChange={setDraft}
                  onEditStart={(target) => {
                    setEditingId(target.id);
                    setDraft(target.content);
                  }}
                  onEditCancel={() => {
                    setEditingId(null);
                    setDraft("");
                  }}
                  onEditSubmit={(id, text) => {
                    setEditingId(null);
                    setDraft("");
                    void editAndResend(id, text);
                  }}
                  onRegenerate={(id) => void regenerate(id)}
                  onContinue={(id) => void continueGeneration(id)}
                />
              ))}
              <div ref={bottomRef} className="h-px" />
            </div>
          )}
        </main>

        <div className="shrink-0 border-t border-border bg-background">
          <div className="mx-auto w-full max-w-3xl px-4 py-3">
            <div className="flex items-end gap-2 rounded-[26px] border border-border bg-background p-2 pl-4 shadow-sm transition-colors focus-within:border-primary/60">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                placeholder="给 chat-mini 发送消息…"
                className="max-h-[200px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={streaming ? stop : submit}
                disabled={!streaming && !input.trim()}
                aria-label={streaming ? "停止生成" : "发送"}
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
                  streaming
                    ? "bg-foreground text-background hover:opacity-90"
                    : "bg-primary text-primary-foreground hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground",
                )}
              >
                {streaming ? (
                  <Square size={13} fill="currentColor" />
                ) : (
                  <ArrowUp size={16} strokeWidth={2.4} />
                )}
              </button>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              内容由 AI 生成，请自行核对
              <span className="hidden sm:inline"> · Enter 发送，Shift+Enter 换行</span>
              <span className="hidden md:inline"> · 自研 NDJSON 事件协议</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center px-4 pb-10">
      <h2 className="text-center text-[28px] font-semibold tracking-tight">有什么可以帮你的？</h2>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        多会话、自研事件协议、代码全都能看懂
      </p>
      <div className="mt-7 grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-xl border border-border px-3.5 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

type BubbleProps = {
  message: ChatUIMessage;
  streaming: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEditStart: (message: ChatUIMessage) => void;
  onEditCancel: () => void;
  onEditSubmit: (id: string, text: string) => void;
  onRegenerate: (id: string) => void;
  onContinue: (id: string) => void;
};

function Bubble({
  message,
  streaming,
  editing,
  draft,
  onDraftChange,
  onEditStart,
  onEditCancel,
  onEditSubmit,
  onRegenerate,
  onContinue,
}: BubbleProps) {
  if (message.role === "user") {
    if (editing) {
      return (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%] rounded-2xl border border-primary/50 bg-muted p-2">
            <textarea
              // biome-ignore lint/a11y/noAutofocus: 进入编辑态就该直接能打字
              autoFocus
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onEditCancel();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (draft.trim()) onEditSubmit(message.id, draft);
                }
              }}
              rows={3}
              className="w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-7 outline-none"
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <span className="mr-auto pl-2 text-[11px] text-muted-foreground">
                Ctrl/⌘+Enter 重发 · Esc 取消
              </span>
              <button
                type="button"
                onClick={onEditCancel}
                className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => onEditSubmit(message.id, draft)}
                disabled={!draft.trim()}
                className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                保存并重发
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-7">
          {message.content}
        </div>
        <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <CopyButton text={message.content} />
          <button
            type="button"
            onClick={() => onEditStart(message)}
            disabled={streaming}
            aria-label="编辑这条消息"
            title="编辑重发"
            className={ACTION_BTN}
          >
            <Pencil size={12} />
            编辑
          </button>
        </div>
      </div>
    );
  }

  const isStreamingThis = streaming && message.pending;
  const empty = !message.content && !message.thinking && !message.error;

  return (
    <div className="group space-y-2">
      {message.thinking ? (
        <details className="rounded-xl border border-border bg-muted/40 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground select-none">
            思考过程
          </summary>
          <div className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">
            {message.thinking}
          </div>
        </details>
      ) : null}

      {message.content ? (
        <Streamdown
          mode={isStreamingThis ? "streaming" : "static"}
          caret={isStreamingThis ? "block" : undefined}
          plugins={PLUGINS}
          translations={TRANSLATIONS}
          className="text-[15px] leading-7"
        >
          {message.content}
        </Streamdown>
      ) : null}

      {isStreamingThis && empty ? (
        <div className="flex items-center gap-1.5 py-1">
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
        </div>
      ) : null}

      {message.error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          出错了：{message.error}
        </p>
      ) : null}

      {message.stopped && !message.error ? (
        <p className="text-xs text-muted-foreground">已停止生成</p>
      ) : null}

      {message.interrupted && !message.error ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>生成中断（刷新或断网时只输出到这里）</span>
          {message.content.trim() ? (
            <button
              type="button"
              onClick={() => onContinue(message.id)}
              disabled={streaming}
              className="rounded-md bg-amber-500/15 px-2 py-0.5 font-medium transition-colors hover:bg-amber-500/25 disabled:opacity-40"
            >
              继续生成
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        {message.content ? <CopyButton text={message.content} /> : null}
        <button
          type="button"
          onClick={() => onRegenerate(message.id)}
          disabled={streaming || empty}
          aria-label="重新生成"
          title="重新生成"
          className={ACTION_BTN}
        >
          <RotateCcw size={12} />
          重新生成
        </button>
        {message.usage ? (
          <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">
            ↑ {message.usage.prompt_tokens} · ↓ {message.usage.completion_tokens}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 非安全上下文 / 无权限：静默失败
    }
  }

  return (
    <button type="button" onClick={copy} aria-label={label} title={label} className={ACTION_BTN}>
      {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      {copied ? "已复制" : label}
    </button>
  );
}
