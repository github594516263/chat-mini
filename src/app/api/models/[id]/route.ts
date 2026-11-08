import { requireUser } from "@/lib/api-guard";
import { deleteModel, updateModel } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/models/:id —— 修改模型行 */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");

  try {
    const model = await updateModel(auth.user.id, id, {
      modelKey: body.modelKey,
      displayName: body.displayName,
      contextWindow: body.contextWindow,
      maxOutputTokens: body.maxOutputTokens,
      enabled: body.enabled,
      reasoningLevels: body.reasoningLevels,
      defaultReasoning: body.defaultReasoning,
    });
    if (!model) return jsonError(404, "模型不存在");
    return Response.json({ model });
  } catch (error) {
    return modelErrorResponse(error);
  }
}

/** DELETE /api/models/:id */
export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  try {
    const ok = await deleteModel(auth.user.id, id);
    if (!ok) return jsonError(404, "模型不存在");
    return Response.json({ ok: true });
  } catch (error) {
    return modelErrorResponse(error);
  }
}
