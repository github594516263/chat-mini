/**
 * 单个会话的真实路由：/c/[id]
 *
 * 这个文件只提供「URL 里有一个会话 id」这个事实，不渲染任何界面。
 * 界面挂在 (chat)/layout.tsx 的 ChatShell 上 —— 于是切会话时根本没有子树要卸载，
 * 输入框不失焦、滚动不归零、组件实例不重建。参考 vercel/ai-chatbot 的同构写法。
 *
 * 那"会话存在吗、是你的吗"谁来管？
 *   客户端：ChatShell 看到 URL id 不在列表里就去拉 /api/sessions/[id]，
 *           拿到 404 就渲染 not-found 态（不存在和不属于你都不泄露）。
 * 为什么不在服务端 notFound()：
 *   界面已经不在 page 里，服务端拦下来只会得到「404 页 + layout 里照常渲染的聊天界面」
 *   这种自相矛盾的画面；而 /api/sessions/[id] 的 404 语义本来就还在。
 */
export default function ConversationPage() {
  return null;
}
