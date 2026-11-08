"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { ChatContext } from "@/components/chat-context";
import { ChatView } from "@/components/chat-view";
import type { AccountUser } from "@/lib/account";
import { readSessionIdFromPath, sessionPath } from "@/lib/session-route";
import { useChat } from "@/lib/use-chat";

/**
 * 会话状态的宿主，挂在 (chat) layout 上 —— 比页面活得久。
 *
 * 分工：
 *   URL   → 状态：useEffect 里 syncFromUrl，后退/前进/直开链接都靠这条
 *   状态  → URL：用户动作（切换/新建/删除）显式调用 router，不用 effect 反推
 *
 * 为什么不用 effect 把 activeId 同步回 URL：那会和后退键打架 ——
 * 后退时 URL 先变、effect 再"纠正"回去，用户会看到地址栏弹回去。
 *
 * 视图也在这里渲染（不是一个 page 一个 ChatView）。
 * 因为路由页现在是空壳，切会话时没有任何子树需要卸载：
 * header、消息列表、输入框都是同一个实例，只换 props。
 * 这也是 vercel/ai-chatbot 的做法，区别只是他们把路由页写成 return null。
 */
export function ChatShell({
  live,
  user,
  children,
}: {
  live: boolean;
  user: AccountUser | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const urlSessionId = readSessionIdFromPath(pathname);
  const chat = useChat({ user, initialSessionId: urlSessionId });

  const { syncFromUrl, selectSession: select, newSession: create, deleteSession: remove } = chat;

  // 唯一的方向：URL → 状态
  // 依赖里带上 hydrated：守卫搬回客户端之后，syncFromUrl 必须在会话列表水合完成后
  // 再跑一次，否则"URL 里的 id 不存在"这条判断永远不会触发（列表空时它会提前返回）。
  useEffect(() => {
    syncFromUrl(urlSessionId);
  }, [syncFromUrl, urlSessionId, chat.hydrated]);

  /**
   * 游客态兜底：URL 里的 id 在本地仓里不存在（典型情况是别人发来的链接），
   * 就把地址栏纠正回草稿态 —— 不能让 URL 声称一条根本不存在的会话。
   * 登录态不适用：那边由服务端 notFound() + syncFromUrl 补拉负责。
   */
  useEffect(() => {
    if (user || !chat.hydrated || !urlSessionId) return;
    if (chat.sessions.some((session) => session.id === urlSessionId)) return;
    router.replace("/");
  }, [user, chat.hydrated, chat.sessions, urlSessionId, router]);

  const selectSession = useCallback(
    (sessionId: string) => {
      select(sessionId);
      const target = sessionPath(sessionId);
      if (window.location.pathname !== target) router.push(target);
    },
    [select, router],
  );

  // 登录态下 URL 里的会话拉不到（404）→ 渲染 not-found 态，而不是装作一条空会话
  const sessionMissing =
    Boolean(user) &&
    urlSessionId !== null &&
    chat.missingSessionId === urlSessionId &&
    !chat.sessions.some((session) => session.id === urlSessionId);

  const newSession = useCallback(() => {
    // 草稿态先回 /，等真 id 到手再 replace 到 /c/<id>
    router.replace("/");
    create({ onCreated: (id) => router.replace(sessionPath(id)) });
  }, [create, router]);

  const deleteSession = useCallback(
    (sessionId: string) => {
      remove(sessionId, {
        onActivated: (id) => router.replace(id ? sessionPath(id) : "/"),
      });
    },
    [remove, router],
  );

  return (
    <ChatContext.Provider value={chat}>
      <AppShell
        user={user}
        live={live}
        storage={user ? "server" : "local"}
        sessions={chat.sessions}
        activeId={chat.activeId}
        onSelect={selectSession}
        onNew={newSession}
        onDelete={deleteSession}
        onRename={chat.renameSession}
      >
        {sessionMissing ? <SessionNotFound onBack={() => router.replace("/")} /> : <ChatView />}
        {children}
      </AppShell>
    </ChatContext.Provider>
  );
}

/**
 * 会话不存在（或不属于当前用户）时的界面。
 *
 * 以前这是服务端 notFound() 干的活；现在界面在 layout 里，服务端拦住只会
 * 得到"404 页 + 聊天界面"并存的怪画面，所以改由客户端渲染这一块。
 * 文案与 HTTP 语义对齐：不区分"不存在"和"不是你的"。
 */
function SessionNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-medium text-foreground">会话不存在</h1>
        <p className="text-sm text-muted-foreground">
          这条对话可能已被删除，或者你没有访问权限。
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-2 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
        >
          开始新对话
        </button>
      </div>
    </div>
  );
}
