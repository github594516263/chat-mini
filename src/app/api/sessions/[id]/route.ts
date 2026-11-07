import { requireUser } from "@/lib/api-guard";
import { getSession, normalizeTitle, renameSession, softDeleteSession } from "@/lib/chat-repo";
import { explainDbError } from "@/lib/db";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/sessions/:id */
export async function GET(_request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  try {
    const session = await getSession(auth.user.id, id);
    // 不存在和"不是你的"都返回 404：403 会泄露这个 id 是否存在
    if (!session) return jsonError(404, "会话不存在");
    return Response.json({ session });
  } catch (error) {
    return jsonError(500, "读取会话失败", explainDbError(error));
  }
}

/** PATCH /api/sessions/:id  { title } */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");

  const title = normalizeTitle(body.title);
  if (!title) return jsonError(400, "标题不能为空");

  try {
    const ok = await renameSession(auth.user.id, id, title);
    if (!ok) return jsonError(404, "会话不存在");
    return Response.json({ session: await getSession(auth.user.id, id) });
  } catch (error) {
    return jsonError(500, "重命名失败", explainDbError(error));
  }
}

/** DELETE /api/sessions/:id —— 软删除，误删还能救回来 */
export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  try {
    const ok = await softDeleteSession(auth.user.id, id);
    if (!ok) return jsonError(404, "会话不存在");
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(500, "删除失败", explainDbError(error));
  }
}
