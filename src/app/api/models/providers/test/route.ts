import { requireUser } from "@/lib/api-guard";
import { testProviderConnection } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/models/providers/test —— 新建前测试连接，不落库 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const body = await readJson(request);
  if (!body) return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");

  try {
    return Response.json(await testProviderConnection(body));
  } catch (error) {
    return modelErrorResponse(error);
  }
}
