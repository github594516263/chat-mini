import { ModelConfigError } from "@/lib/model-config";
import { jsonError } from "@/lib/http";

/** 把模型配置层的错误翻译成 API 响应；不把内部堆栈/密钥带回客户端 */
export function modelErrorResponse(error: unknown): Response {
  if (error instanceof ModelConfigError) {
    return jsonError(error.status, error.message, error.hint);
  }

  const message = error instanceof Error ? error.message : String(error);
  // MySQL 唯一键/表不存在等常见错误给可行动提示，其余只回 500
  if (message.includes("ER_NO_SUCH_TABLE")) {
    return jsonError(
      500,
      "模型配置表还没建",
      "用 root 重新执行 scripts/schema.sql，然后刷新页面。",
    );
  }
  return jsonError(500, "模型配置操作失败", message.slice(0, 300));
}
