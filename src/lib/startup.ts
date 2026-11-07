import { sweepExpiredSessions } from "@/lib/auth";
import { markStaleRuns } from "@/lib/chat-repo";
import { explainDbError } from "@/lib/db";
import { sweepAttempts } from "@/lib/rate-limit";

/**
 * 启动清理。由 src/instrumentation.ts 在 Node runtime 里调用一次。
 *
 * 为什么要做：生成跑在进程内存里，进程一重启，上一轮所有 status='running'
 * 的 run 都不可能是活的。不清理的话，界面上会留下永远转圈的"正在生成"。
 *
 * 这里所有错误都吞掉：数据库没起的时候，站点仍然应该能打开并给出可读的错误，
 * 而不是白屏。
 */
const globalForStartup = globalThis as unknown as { __chatStartupDone?: boolean };

export async function runStartupTasks(): Promise<void> {
  if (globalForStartup.__chatStartupDone) return;
  globalForStartup.__chatStartupDone = true;

  try {
    const stale = await markStaleRuns();
    if (stale.messages > 0 || stale.runs > 0) {
      console.log(
        `[startup] 清理上次残留：${stale.messages} 条消息标为生成中断，${stale.runs} 个 run 标为 error`,
      );
    }
  } catch (error) {
    console.warn(`[startup] 清理残留 run 失败：${explainDbError(error)}`);
  }

  try {
    const sessions = await sweepExpiredSessions();
    if (sessions > 0) console.log(`[startup] 清理过期登录会话 ${sessions} 条`);
  } catch (error) {
    console.warn(`[startup] 清理过期登录会话失败：${explainDbError(error)}`);
  }

  try {
    sweepAttempts();
  } catch {
    // 纯内存操作，理论上不会失败
  }
}
