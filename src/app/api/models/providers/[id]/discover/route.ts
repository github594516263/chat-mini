import { requireUser } from "@/lib/api-guard";
import { discoverProviderModels } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";
import { isSameOrigin, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** POST /api/models/providers/:id/discover —— 测试连接 + 拉取 /models */
export async function POST(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isSameOrigin(request)) return jsonError(403, "跨站请求被拒绝");

  const { id } = await context.params;
  try {
    return Response.json(await discoverProviderModels(auth.user.id, id));
  } catch (error) {
    return modelErrorResponse(error);
  }
}
