import { requireUser } from "@/lib/api-guard";
import { deleteProvider, updateProvider } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/models/providers/:id —— 改名/改地址/改密钥；apiKey 空 = 不改 */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");

  try {
    const provider = await updateProvider(auth.user.id, id, {
      name: body.name,
      baseUrl: body.baseUrl,
      protocol: body.protocol,
      authType: body.authType,
      apiKey: body.apiKey,
      enabled: body.enabled,
      revision: body.revision,
      clearKey: body.clearKey,
    });
    if (!provider) return jsonError(404, "provider 不存在");
    return Response.json({ provider });
  } catch (error) {
    return modelErrorResponse(error);
  }
}

/** DELETE /api/models/providers/:id —— 级联删除模型和凭据 */
export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  try {
    const ok = await deleteProvider(auth.user.id, id);
    if (!ok) return jsonError(404, "provider 不存在");
    return Response.json({ ok: true });
  } catch (error) {
    return modelErrorResponse(error);
  }
}
