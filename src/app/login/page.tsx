import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/session-route";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // `?next=` 让深链鉴权回跳成为可能：在 /c/<id> 被挡下来的人，登录后应该回到那条会话
  const next = safeNextPath((await searchParams).next);

  // 服务端读 cookie：已登录的人不该再看到登录页（也避免登录后按后退回来）
  const user = await getCurrentUser();
  if (user) redirect(next ?? "/");

  const allowRegister = process.env.ALLOW_REGISTER === "true";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <LoginForm allowRegister={allowRegister} next={next} />
      </div>
    </main>
  );
}
