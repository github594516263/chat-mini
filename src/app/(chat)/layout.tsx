import { ChatShell } from "@/components/chat-shell";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * 聊天区的 layout：把「会话状态」和「侧栏骨架」提到页面之上。
 *
 * 这一层是本次改造的关键 —— 它不会随 /c/[id] 的参数变化而重挂，
 * 所以切会话时流式订阅不断、草稿不丢，而 page 子树该重建就重建。
 */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const live = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  const user = await getCurrentUser();

  return (
    <ChatShell
      live={live}
      user={
        user ? { id: user.id, username: user.username, displayName: user.displayName } : null
      }
    >
      {children}
    </ChatShell>
  );
}
