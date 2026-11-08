import { requireUser } from "@/lib/api-guard";
import { setUseSystemModels } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/models/preferences —— 目前只有「没有自建模型时使用系统默认」开关 */
export async function PUT(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");
  if (typeof body.useSystemModels !== "boolean") {
    return jsonError(400, "useSystemModels 必须是布尔值");
  }

  try {
    await setUseSystemModels(auth.user.id, body.useSystemModels);
    return Response.json({ ok: true, useSystemModels: body.useSystemModels });
  } catch (error) {
    return modelErrorResponse(error);
  }
}
