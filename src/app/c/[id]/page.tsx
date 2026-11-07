import { notFound } from "next/navigation";

import Chat from "@/components/chat";
import { getCurrentUser } from "@/lib/auth";
import { getSession } from "@/lib/chat-repo";

export const dynamic = "force-dynamic";

/**
 * 单个会话的真实路由：/c/[id]
 *
 * 这一版（Step 1）服务端只做两件事：
 *   1. 判定登录态，顺手把"会话存不存在 / 是不是你的"这个问题在服务端回答掉
 *   2. 把会话标题带给客户端，让首屏就有标题而不是"新对话"
 *
 * 消息正文仍然由客户端用现有的接口拉（改 SSR 是后面的事，避免一次动太多）。
 *
 * 归属校验和 /api/sessions/[id] 保持同一语义：不存在和"不是你的"都返回 404，
 * 这样也不会泄露某个 id 是否真实存在。
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const live = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  const user = await getCurrentUser();

  // 游客：会话只存在浏览器 localStorage 里，服务端无从判断，交给客户端解析（已知缺口）
  const session = user ? await getSession(user.id, id) : null;
  if (user && !session) notFound();

  return (
    <Chat
      live={live}
      initialUser={
        user ? { id: user.id, username: user.username, displayName: user.displayName } : null
      }
      initialSessionId={id}
      initialSession={session}
    />
  );
}
