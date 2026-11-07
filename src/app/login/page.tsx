import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // 服务端读 cookie：已登录的人不该再看到登录页（也避免登录后按后退回来）
  const user = await getCurrentUser();
  if (user) redirect("/");

  const allowRegister = process.env.ALLOW_REGISTER === "true";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <LoginForm allowRegister={allowRegister} />
      </div>
    </main>
  );
}
