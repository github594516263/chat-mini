import { notFound } from "next/navigation";

import { ChatView } from "@/components/chat-view";
import { getCurrentUser } from "@/lib/auth";
import { getSession } from "@/lib/chat-repo";

export const dynamic = "force-dynamic";

/**
 * 单个会话的真实路由：/c/[id]
 *
 * 服务端在这里只回答一个问题：「这条会话存在、而且属于你吗」。
 * 不存在和"不是你的"都返回 404（与 /api/sessions/[id] 一致，不泄露 id 是否存在）。
 * 消息正文由客户端拉取；会话状态住在 (chat)/layout.tsx 的 Provider 里。
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();

  // 游客：会话只存在浏览器 localStorage 里，服务端无从判断，交给客户端解析（已知缺口）
  if (user) {
    const session = await getSession(user.id, id);
    if (!session) notFound();
  }

  return <ChatView />;
}
