"use client";

/**
 * 客户端登出：cookie 由服务端清。
 * 网络失败也按成功处理——本地 cookie 可能早就过期了，界面应该回到未登录态。
 */
export async function logoutRequest() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // 忽略：下面照样刷新，服务端会话会自己过期
  }
}
