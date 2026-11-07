/**
 * Next 的服务启动钩子，每个进程启动时跑一次。
 * 只做数据库清理（残留 run / 过期登录会话），不做任何会阻塞启动的事。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runStartupTasks } = await import("@/lib/startup");
  await runStartupTasks();
}
