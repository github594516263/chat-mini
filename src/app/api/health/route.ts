import { healthCheck } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health —— 部署与环境自检。
 * 故意不需要登录：出问题时（DB 连不上）也要能直接看到原因，而不是先被 401 挡住。
 */
export async function GET() {
  const db = await healthCheck();
  const body = {
    ok: db.ok,
    app: "chat-mini",
    db: {
      connected: db.ok,
      version: db.version ?? null,
      database: db.database ?? null,
      tables: db.tables ?? null,
      error: db.error ?? null,
    },
    node: process.version,
    checkedAt: new Date().toISOString(),
  };

  return Response.json(body, { status: db.ok ? 200 : 503 });
}
