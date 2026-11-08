"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Copy, PanelLeft, Pencil, RotateCcw, Square } from "lucide-react";
import { Streamdown, type StreamdownTranslations } from "streamdown";
import { code } from "@streamdown/code";

import { useAppShell } from "@/components/app-shell";
import { ThemeMenu } from "@/components/theme-menu";
import { useChatContext } from "@/components/chat-context";
import { useModelContext } from "@/components/model-context";
import { ModelPicker, ReasoningPicker } from "@/components/model-picker";
import type { ChatUIMessage } from "@/lib/use-chat";
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

/**
 * 离底部多近算"还贴着底"。
 *
 * 这个值只用来识别**用户的意图**（还要不要跟着新内容走），不参与"内容变长了要不要跟"的
 * 判断 —— 那个判断交给滚动事件：一次代码块/markdown 重排就能把高度顶上去几百像素，
 * 用像素距离判断会在那一帧误判成"用户往上翻了"，从此再也不跟随。
 */
const BOTTOM_SLACK = 24;

function isNearBottom(el: HTMLElement, slack = BOTTOM_SLACK) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * 落位必须在浏览器绘制前完成，否则会先闪一帧"贴底"再跳到记忆位置。
 * 服务端没有 layout effect，退回 useEffect（避免 SSR 期的 useLayoutEffect 警告）。
 */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 消息列表上要用的动作，统一收在一个**稳定**对象里。
 *
 * 为什么不能直接把 chat.xxx 传进 memo 过的 Bubble：useChatContext() 每次渲染都给
 * 一个新的 chat 对象，回调引用跟着全变，memo 会全部失效（等于没 memo）。
 * 所以这里用 ref 取"最新的 chat"，回调本身靠 useMemo 保持引用不变。
 */
type MessageActions = {
  beginEdit: (messageId: string, content: string) => void;
  updateEditDraft: (draft: string) => void;
  endEdit: () => void;
  editAndResend: (messageId: string, text: string) => void;
  regenerate: (messageId: string) => void;
  continueGeneration: (messageId: string) => void;
};

type ComposerApi = { setText: (text: string) => void; focus: () => void };

/**
 * 页面主体。会话状态全部来自 ChatContext（挂在 layout 上的 Provider），
 * 所以这个组件可以随页面重建 —— 重建之后草稿和生成中的正文都还在。
 */
export function ChatView() {
  const { openMobileSidebar, themeMode, setTheme, live } = useAppShell();
  const chat = useChatContext();
  const model = useModelContext();

  const {
    activeId,
    activeSession,
    messages,
    streaming,
    hydrated,
    messagesLoading,
    send,
    stop,
    editState,
    getDraft,
    setDraft,
    rememberScroll,
    forgetScroll,
    recallScroll,
  } = chat;

  const scrollRef = useRef<HTMLElement>(null);
  /** 输入框的对外把手：Hero 的推荐问句要能把文字塞进去 */
  const composerApi = useRef<ComposerApi | null>(null);

  /**
   * 要不要跟着新内容走。
   *
   * 进入会话时打开；用户自己往上翻就关掉（正在读历史的人不能被拽回底部）；
   * 再翻回底部、或者自己发了一条消息，重新打开。
   */
  const stickRef = useRef(true);

  /**
   * 等着落位的滚动位置。`top === null` 表示这条会话没有记忆，落到最底部。
   *
   * 切会话时只**登记**，等正文真正渲染出来才落位：骨架屏的高度不是正文高度，
   * 在骨架期按 scrollHeight 落位只能落到 0，等消息到了又会被当成"用户不在底部"，
   * 于是"刚进来"永远停在顶部。
   */
  const restoreRef = useRef<{ id: string; top: number | null } | null>(null);

  /** 正文容器的 ResizeObserver：正文一变高就贴底（流式、代码高亮、图片加载都算） */
  const observerRef = useRef<ResizeObserver | null>(null);

  const chatRef = useRef(chat);
  chatRef.current = chat;

  // 滚动监听只挂一次：回调里用 ref 取"当前会话"，免得切换那一瞬间的滚动事件
  // 还落在旧会话的闭包里，把新会话的位置记到旧会话头上。
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /**
   * 该显示骨架吗？
   *
   * 判断必须用**同步可得**的 `session.loaded`，不能用 messagesLoading ——
   * 那个是在 effect 里才置 true 的，于是切到冷会话的第一帧会满足
   * "messages 为空 + loading 还是 false"，先把 Hero 空态渲染出来，
   * 下一帧再切成骨架 → 用户看到 Hero 闪一下。
   * loaded 从列表数据里来，渲染时就有，不存在这个空窗。
   */
  const sessionPending = activeSession?.loaded === false;
  const showSkeleton = !hydrated || sessionPending || (messagesLoading && messages.length === 0);

  const actions = useMemo<MessageActions>(
    () => ({
      beginEdit: (messageId, content) => chatRef.current.beginEdit(messageId, content),
      updateEditDraft: (value) => chatRef.current.updateEditDraft(value),
      endEdit: () => chatRef.current.endEdit(),
      editAndResend: (messageId, text) => {
        chatRef.current.endEdit();
        void chatRef.current.editAndResend(messageId, text);
      },
      regenerate: (messageId) => void chatRef.current.regenerate(messageId),
      continueGeneration: (messageId) => void chatRef.current.continueGeneration(messageId),
    }),
    [],
  );

  // 切会话 → 登记落位任务（有记忆用记忆，没记忆贴底）
  useBeforePaint(() => {
    restoreRef.current = activeId ? { id: activeId, top: recallScroll(activeId) } : null;
    stickRef.current = true;
  }, [activeId, recallScroll]);

  // 正文就绪后落位。骨架屏期间不动：骨架的高度没有参考价值。
  useBeforePaint(() => {
    const el = scrollRef.current;
    const pending = restoreRef.current;
    if (!el || !pending || pending.id !== activeId || showSkeleton) return;
    restoreRef.current = null;
    el.scrollTop = pending.top ?? el.scrollHeight;
    stickRef.current = isNearBottom(el);
  }, [activeId, showSkeleton]);

  /**
   * 正文一变高就贴底 —— 流式输出"跟不跟"，靠的就是这一条。
   *
   * 不能靠"messages 变了就滚"：气泡里的正文是节流渲染的（见 useThrottledText），
   * 高度变化和 React 提交不在同一帧；而且代码高亮、图片、表格重排都会让高度
   * 在之后继续变。盯住容器本身的尺寸最省心。
   */
  const attachContent = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      // 还没落位（刚进会话）时别抢：落位由上面那个 effect 负责
      if (!el || restoreRef.current || !stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(node);
    observerRef.current = ro;
  }, []);

  // 视口变矮、输入框长高都会改变可视区高度：不重新贴底就会停在"差一点到底"
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (restoreRef.current || !stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 滚动：判断这是"用户自己往上翻了"还是"我们贴底造成的"。
  // 贴底不记位置（下次进来本来就该在底部），往上翻了才记。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const id = activeIdRef.current;
      if (!id) return;
      const atBottom = isNearBottom(el);
      stickRef.current = atBottom;
      if (atBottom) forgetScroll(id);
      else rememberScroll(id, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [forgetScroll, rememberScroll]);

  // 这里原本挂了一个 beforeunload 拦截（生成中刷新就弹"更改可能未保存"）。
  // 后来两种模式都能续传了，这个拦截就变成纯粹的骚扰：
  //   登录用户：生成跑在服务端，刷新回来接着看，一个字都不丢
  //   游客：    runId + 已消费的水位存在 localStorage，刷新后从断点接上
  // 所以删掉，别拦用户刷新。

  /** 自己发消息 = 想立刻看到回答，不管刚才翻到哪，都重新贴底 */
  const handleSend = useCallback(
    (text: string) => {
      stickRef.current = true;
      send(text);
    },
    [send],
  );

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={openMobileSidebar}
          aria-label="打开侧栏"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
        >
          <PanelLeft size={16} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {activeSession?.title ?? "新对话"}
        </h1>
        <ThemeMenu mode={themeMode} onSelect={setTheme} />
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium md:hidden",
            live ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
          )}
        >
          {live ? "live" : "未配置"}
        </span>
      </header>

      {/* transform-gpu：把消息滚动区提到独立合成层，滚动时不再重绘整页（见设置弹层里的说明） */}
      <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto transform-gpu">
        {showSkeleton ? (
          <MessageSkeleton />
        ) : messages.length === 0 ? (
          <Hero
            onPick={(text) => {
              composerApi.current?.setText(text);
              composerApi.current?.focus();
            }}
          />
        ) : (
          <div ref={attachContent} className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
            {messages.map((message) => {
              // data-role 是给端到端测试用的锚点：按角色定位气泡，不依赖样式
              const isEditingThis = editState?.messageId === message.id;
              return (
                <div key={message.id} data-role={message.role}>
                  <Bubble
                    message={message}
                    streaming={streaming}
                    editing={isEditingThis}
                    // 只有正在编辑的那条才需要草稿，别的传空串，避免逐字重渲染时把所有气泡都标记为脏
                    draft={isEditingThis ? (editState?.draft ?? "") : ""}
                    actions={actions}
                  />
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* 输入框单独成组件：文字是它自己的 state，按键只重渲染这一块，
          不再顺着 ChatShell → 侧栏 / 消息列表整棵树重跑 */}
      <Composer
        api={composerApi}
        sessionId={activeId}
        streaming={streaming}
        model={model}
        getDraft={getDraft}
        setDraft={setDraft}
        onSend={handleSend}
        onStop={stop}
      />
    </>
  );
}

/**
 * 输入框。
 *
 * 文字存在本地 state，同时回写到 useChat 里按会话存的草稿（ref，不触发渲染）——
 * 这样"按键"和"切会话/重挂"两件事互不牵连：按键只动这一块，切回来还能接着写。
 */
function Composer({
  api,
  sessionId,
  streaming,
  model,
  getDraft,
  setDraft,
  onSend,
  onStop,
}: {
  api: { current: ComposerApi | null };
  sessionId: string | null;
  streaming: boolean;
  model: ReturnType<typeof useModelContext>;
  getDraft: (sessionId: string | null) => string;
  setDraft: (sessionId: string, value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState(() => getDraft(sessionId));
  const [lastSession, setLastSession] = useState(sessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 切会话就换一份草稿。在渲染期就地调整（React 的官方写法），不会闪一帧旧文字
  if (sessionId !== lastSession) {
    setLastSession(sessionId);
    setText(getDraft(sessionId));
  }

  const update = (next: string) => {
    setText(next);
    if (sessionId) setDraft(sessionId, next);
  };

  // 从外面塞话（首页推荐问句）
  api.current = {
    setText: update,
    focus: () => textareaRef.current?.focus(),
  };

  // 自适应高度：只跟着这一块自己的文字走
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  function submit() {
    if (streaming || !text.trim()) return;
    const value = text;
    update("");
    void onSend(value);
  }

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        <div className="relative flex flex-wrap items-end gap-x-2 gap-y-1.5 rounded-[26px] border border-border bg-background p-2 pl-4 shadow-sm transition-colors focus-within:border-primary/60">
          <textarea
            ref={textareaRef}
            data-composer="1"
            value={text}
            onChange={(event) => update(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="给 chat-mini 发送消息…"
            className="max-h-[200px] min-w-[9rem] flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
          />
          {/* 窄屏放不下一行时，这组会整体折到第二行，而不是把输入框挤成三行 */}
          <div className="ml-auto flex items-center gap-1.5">
            <ReasoningPicker
              levels={model.reasoningLevels}
              value={model.reasoning}
              onChange={model.setReasoning}
            />
            <ModelPicker
              groups={model.groups}
              selected={model.selected}
              onSelect={model.select}
            />
            <button
              type="button"
              onClick={streaming ? onStop : submit}
              disabled={!streaming && (!text.trim() || !model.selectedId)}
              title={!model.selectedId ? "先在设置 → 模型里配置一个模型" : undefined}
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
        </div>
        {!model.selectedId ? (
          <p className="mt-2 text-center text-[11px] text-amber-600">
            还没有可用模型。点输入框右侧的「配置模型」，或打开设置 → 模型添加一个。
          </p>
        ) : null}
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          内容由 AI 生成，请自行核对
          <span className="hidden sm:inline"> · Enter 发送，Shift+Enter 换行</span>
          <span className="hidden md:inline"> · 自研 NDJSON 事件协议</span>
        </p>
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
  actions: MessageActions;
};

/**
 * 一条消息。**必须是 memo 的**。
 *
 * 生成时每来一个 token 都会换掉 messages 数组，但只有正在写的那一条是**新对象**
 * 其余消息引用不变 —— 没有 memo 的话每次 token 都会把所有历史消息连同 markdown
 * 一起重渲染一遍，长对话里这就是"越聊越卡"的来源。
 */
const Bubble = memo(function Bubble({ message, streaming, editing, draft, actions }: BubbleProps) {
  const isStreamingThis = message.role !== "user" && streaming && Boolean(message.pending);
  // 流式正文按帧率上限节流后再交给 markdown 解析器（见 useThrottledText）
  const shownContent = useThrottledText(message.content, isStreamingThis);

  if (message.role === "user") {
    if (editing) {
      return (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%] rounded-2xl border border-primary/50 bg-muted p-2">
            <textarea
              // biome-ignore lint/a11y/noAutofocus: 进入编辑态就该直接能打字
              autoFocus
              value={draft}
              onChange={(event) => actions.updateEditDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  actions.endEdit();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (draft.trim()) actions.editAndResend(message.id, draft);
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
                onClick={actions.endEdit}
                className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => actions.editAndResend(message.id, draft)}
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
            onClick={() => actions.beginEdit(message.id, message.content)}
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
          {shownContent}
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
              onClick={() => actions.continueGeneration(message.id)}
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
          onClick={() => actions.regenerate(message.id)}
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
});

/**
 * 流式正文节流。
 *
 * Streamdown 每次拿到新字符串都要重新解析整段 markdown（含代码高亮）。token 是
 * 几毫秒一个的，逐 token 解析等于把主线程占满；这里按 intervalMs 限流，
 * 让渲染跟着帧走而不是跟着 token 走。
 *
 * 两个关键点：
 *   1. 流式结束立刻对齐最终正文 —— 最后几个字绝不能丢；
 *   2. 节流窗口内的中间态不补渲染，只渲染"最新的那一份"（latestRef）。
 */
const STREAM_RENDER_INTERVAL_MS = 80;

function useThrottledText(text: string, active: boolean) {
  const [shown, setShown] = useState(text);
  const latestRef = useRef(text);
  const lastRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  latestRef.current = text;

  useEffect(() => {
    if (!active) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastRef.current = 0;
      setShown(latestRef.current);
      return;
    }

    const now = performance.now();
    const waited = now - lastRef.current;
    if (waited >= STREAM_RENDER_INTERVAL_MS) {
      lastRef.current = now;
      setShown(latestRef.current);
      return;
    }
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastRef.current = performance.now();
      setShown(latestRef.current);
    }, STREAM_RENDER_INTERVAL_MS - waited);
  }, [text, active]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return active ? shown : text;
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

/**
 * 冷会话在拉消息时的骨架。
 *
 * 关键不是好看，是**占位尺寸接近真实内容**：以前这里是一行"正在加载会话…"，
 * 数据到了整块区域突然换成两三条消息，观感就像页面刷新了一次。
 * 现在换成同尺寸的灰块，加载完成时几乎看不出版面变化。
 *
 * 注意：不做"预热"。冷会话依然会发一次请求，只是这期间不再闪。
 */
function MessageSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8"
      data-skeleton="1"
      aria-busy="true"
      aria-label="正在加载会话"
    >
      {[0, 1].map((row) => (
        <div key={row} className="animate-pulse space-y-4">
          {/* 用户那一侧：靠右的短气泡 */}
          <div className="flex justify-end">
            <div className={cn("h-9 rounded-2xl bg-muted", row === 0 ? "w-2/5" : "w-1/4")} />
          </div>
          {/* 助手那一侧：整段正文 */}
          <div className="space-y-2.5">
            <div className="h-3.5 w-full rounded-full bg-muted" />
            <div className="h-3.5 w-11/12 rounded-full bg-muted" />
            <div className={cn("h-3.5 rounded-full bg-muted", row === 0 ? "w-4/5" : "w-2/3")} />
          </div>
        </div>
      ))}
    </div>
  );
}
