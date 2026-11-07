"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, PanelLeft, Square } from "lucide-react";
import { Streamdown, type StreamdownTranslations } from "streamdown";
import { code } from "@streamdown/code";

import { Sidebar } from "@/components/sidebar";
import { useChat, type ChatUIMessage } from "@/lib/use-chat";
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

export default function Chat({ live }: { live: boolean }) {
  const {
    sessions,
    activeId,
    activeSession,
    messages,
    streaming,
    send,
    stop,
    newSession,
    selectSession,
    deleteSession,
  } = useChat();

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  // 切会话回到顶部时重置输入框高度
  useEffect(() => {
    setInput("");
  }, [activeId]);

  function submit() {
    if (streaming || !input.trim()) return;
    const value = input;
    setInput("");
    void send(value);
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* 桌面端常驻侧栏 */}
      <div className="hidden md:block">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={selectSession}
          onNew={newSession}
          onDelete={deleteSession}
          live={live}
        />
      </div>

      {/* 移动端：抽屉 + 遮罩 */}
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
                <Bubble key={message.id} message={message} streaming={streaming} />
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
                placeholder="给 chat-mini 发送消息（Enter 发送，Shift+Enter 换行）"
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
              内容由 AI 生成，请自行核对 · 自研 NDJSON 事件协议
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

function Bubble({ message, streaming }: { message: ChatUIMessage; streaming: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-7">
          {message.content}
        </div>
      </div>
    );
  }

  const isStreamingThis = streaming && message.pending;
  const empty = !message.content && !message.thinking && !message.error;

  return (
    <div className="space-y-2">
      {message.thinking ? (
        <details className="group rounded-xl border border-border bg-muted/40 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground select-none">
            思考过程
            <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
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

      {message.usage ? (
        <p className="text-[11px] text-muted-foreground tabular-nums">
          ↑ {message.usage.prompt_tokens} · ↓ {message.usage.completion_tokens} tokens
        </p>
      ) : null}
    </div>
  );
}
