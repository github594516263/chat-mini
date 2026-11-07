import Chat from "@/components/chat";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Page() {
  // 服务端读一次环境变量，只用于在界面上诚实地标注当前是 mock 还是 live
  const live = Boolean(process.env.DEEPSEEK_API_KEY?.trim());

  // 游客也能用（决策 D3）：未登录返回 null，只是顶栏显示"登录"入口
  const user = await getCurrentUser();

  return (
    <Chat
      live={live}
      initialUser={
        user ? { id: user.id, username: user.username, displayName: user.displayName } : null
      }
    />
  );
}
