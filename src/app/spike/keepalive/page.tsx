/** 【临时·路由改造实测用】变体 D 的宿主页。结论落地后随 spike/ 一起删除。 */

import { notFound } from "next/navigation";

import { SpikeKeepAlive } from "@/components/spike-keepalive";
import { listMessages, listSessions } from "@/lib/chat-repo";

export const dynamic = "force-dynamic";

const DEMO_USER = "917a5d66-21ca-40c3-a3bf-f3ff0153384b";
const NAV_SIZE = 20;

export default async function SpikeKeepAlivePage() {
  const { sessions } = await listSessions(DEMO_USER, { limit: NAV_SIZE });
  const first = sessions[0];
  if (!first) notFound();

  const data = await listMessages(DEMO_USER, first.id);
  if (!data) notFound();

  return (
    <SpikeKeepAlive
      initial={{
        id: data.session.id,
        title: data.session.title,
        messages: data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
      }}
      nav={sessions.map((s) => ({ id: s.id, title: s.title }))}
    />
  );
}
