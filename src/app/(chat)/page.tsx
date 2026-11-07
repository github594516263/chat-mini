import { ChatView } from "@/components/chat-view";

export const dynamic = "force-dynamic";

/** 根路径 = 草稿态（还没有会话身份）。第一条消息发出后由 ChatShell 换成 /c/<id>。 */
export default function HomePage() {
  return <ChatView />;
}
