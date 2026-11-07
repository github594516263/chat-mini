/** 【临时·路由改造 A/B 实测用】变体 B 的取数接口。结论落地后随 spike/ 一起删除。 */

import { listMessages } from "@/lib/chat-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_USER = "917a5d66-21ca-40c3-a3bf-f3ff0153384b";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const data = await listMessages(DEMO_USER, id);
  if (!data) return Response.json({ ok: false }, { status: 404 });
  return Response.json({
    ok: true,
    session: data.session,
    messages: data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
  });
}
