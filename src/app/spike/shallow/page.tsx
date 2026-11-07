/**
 * 【临时·路由改造 A/B 实测用】变体 B：单路由 + 客户端取数（浅导航）。
 *
 * 首屏仍然 SSR（两边首屏条件一致），但之后的切换只发一条 JSON 请求，
 * 地址栏不动、组件树不重挂 —— 用来验证"切会话会不会丢状态"这个关键问题。
 */

import { notFound } from "next/navigation";

import { SpikeProbe } from "@/components/spike-probe";
import { listMessages, listSessions } from "@/lib/chat-repo";

export const dynamic = "force-dynamic";

const DEMO_USER = "917a5d66-21ca-40c3-a3bf-f3ff0153384b";
const NAV_SIZE = 8;

export default async function SpikeShallowPage() {
  const { sessions } = await listSessions(DEMO_USER, { limit: NAV_SIZE });
  const first = sessions[0];
  if (!first) notFound();

  const data = await listMessages(DEMO_USER, first.id);
  if (!data) notFound();

  return (
    <SpikeProbe
      variant="B"
      activeId={data.session.id}
      title={data.session.title}
      messages={data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content }))}
      nav={sessions.map((s) => ({ id: s.id, title: s.title }))}
    />
  );
}
