/**
 * 【临时·路由改造 A/B 实测用】变体 A：真实嵌套路由 + RSC 取数。
 *
 * 对应主流 Next 做法（Vercel 官方 chat 模板同构）：
 *   切会话 = <Link> → RSC 请求 → 服务端重跑这个 page（含 DB 读）。
 *
 * 故意不接鉴权，userId 写死 demo —— 只是测量脚手架，结论落地后删除整个 spike/ 目录。
 */

import { notFound } from "next/navigation";

import { SpikeProbe } from "@/components/spike-probe";
import { listMessages, listSessions } from "@/lib/chat-repo";

export const dynamic = "force-dynamic";

const DEMO_USER = "917a5d66-21ca-40c3-a3bf-f3ff0153384b";
const NAV_SIZE = 8;

export default async function SpikeRoutePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ noprefetch?: string; hoist?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const hoist = query.hoist === "1";

  const [data, list] = await Promise.all([
    listMessages(DEMO_USER, id),
    listSessions(DEMO_USER, { limit: NAV_SIZE }),
  ]);
  if (!data) notFound();

  return (
    <SpikeProbe
      variant={hoist ? "C" : "A"}
      activeId={data.session.id}
      title={data.session.title}
      messages={data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content }))}
      nav={list.sessions.map((s) => ({ id: s.id, title: s.title }))}
      noPrefetch={query.noprefetch === "1"}
      linkSuffix={hoist ? "?hoist=1" : query.noprefetch === "1" ? "?noprefetch=1" : ""}
    />
  );
}
