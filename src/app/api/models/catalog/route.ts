import { requireUser } from "@/lib/api-guard";
import { getUserModelCatalog } from "@/lib/model-config";
import { modelErrorResponse } from "@/lib/model-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/models/catalog —— 当前登录用户的可用模型目录 */
export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  try {
    const catalog = await getUserModelCatalog(auth.user.id);
    return Response.json(catalog);
  } catch (error) {
    return modelErrorResponse(error);
  }
}
