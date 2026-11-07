import { requireUser } from "@/lib/api-guard";
import { createSession, listSessions } from "@/lib/chat-repo";
import { explainDbError } from "@/lib/db";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sessions?limit=50&cursor=...
 * 只返回自己的、未删除的会话，按 updated_at 倒序。
 */
export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "50");
  const cursor = url.searchParams.get("cursor");

  try {
    const result = await listSessions(auth.user.id, {
      limit: Number.isFinite(limitParam) ? limitParam : 50,
      cursor,
    });
    return Response.json(result);
  } catch (error) {
    return jsonError(500, "读取会话列表失败", explainDbError(error));
  }
}

/** POST /api/sessions  { title? } */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  // 允许空 body：建一个标题为"新对话"的空会话
  const body = (await readJson(request)) ?? {};
  const title = typeof body.title === "string" ? body.title : null;

  try {
    const session = await createSession(auth.user.id, title);
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return jsonError(500, "创建会话失败", explainDbError(error));
  }
}
