import { requireUser } from "@/lib/api-guard";
import { createModel } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** POST /api/models/providers/:id/models —— 给某个 provider 添加模型 */
export async function POST(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");

  try {
    const model = await createModel(auth.user.id, id, {
      modelKey: body.modelKey,
      displayName: body.displayName,
      contextWindow: body.contextWindow,
      maxOutputTokens: body.maxOutputTokens,
      enabled: body.enabled,
    });
    if (!model) return jsonError(404, "provider 不存在");
    return Response.json({ model }, { status: 201 });
  } catch (error) {
    return modelErrorResponse(error);
  }
}
