import { ChatShell } from "@/components/chat-shell";
import { getCurrentUser } from "@/lib/auth";
import { getUserModelCatalog } from "@/lib/model-config";
import { getModelCatalog } from "@/lib/models";

export const dynamic = "force-dynamic";

/**
 * 聊天区的 layout：把「会话状态」和「侧栏骨架」提到页面之上。
 *
 * 这一层是本次改造的关键 —— 它不会随 /c/[id] 的参数变化而重挂，
 * 所以切会话时流式订阅不断、草稿不丢，而 page 子树该重建就重建。
 */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  // 登录用户：目录来自自己的 provider/model 表；游客：仍用环境变量目录。
  // 两边都只下发布公开 id / 名字 / 状态，没有 key 和 base URL。
  let catalog = getModelCatalog();
  if (user) {
    try {
      catalog = await getUserModelCatalog(user.id);
    } catch (error) {
      // 新表还没建/数据库抖动：不要让整页 500，也不要偷偷回退到系统目录，
      // 否则登录用户会看到不属于自己的模型。设置页会显示具体错误。
      console.error("[models] 读取账户模型目录失败:", error);
      catalog = { groups: [], defaultId: "", mock: false, origin: "none" };
    }
  }
  const live = catalog.groups.some((group) => group.status === "live");

  return (
    <ChatShell
      live={live}
      catalog={catalog}
      user={
        user ? { id: user.id, username: user.username, displayName: user.displayName } : null
      }
    >
      {children}
    </ChatShell>
  );
}
