import { requireUser } from "@/lib/api-guard";
import { createProvider, listModelSettings } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/models/providers —— 设置页用：provider 列表 + 脱敏凭据状态 */
export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  try {
    return Response.json(await listModelSettings(auth.user.id));
  } catch (error) {
    return modelErrorResponse(error);
  }
}

/** POST /api/models/providers —— 新建 provider（可同时带 API Key） */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");

  try {
    const provider = await createProvider(auth.user.id, {
      name: body.name,
      baseUrl: body.baseUrl,
      protocol: body.protocol,
      authType: body.authType,
      apiKey: body.apiKey,
      enabled: body.enabled,
    });
    return Response.json({ provider }, { status: 201 });
  } catch (error) {
    return modelErrorResponse(error);
  }
}
