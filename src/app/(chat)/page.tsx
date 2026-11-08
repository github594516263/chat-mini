/**
 * 草稿态：URL 是 `/`，还没有会话身份。
 *
 * 这里刻意返回 null —— 界面由 (chat)/layout.tsx 里的 ChatShell 渲染。
 * 为什么不让页面渲染界面：页面会随 /c/[id] 的参数变化被卸载重建，
 * 视图一旦挂在页面里，切会话就等于重开一次界面（输入框失焦、滚动归零）。
 * 挂到 layout 上则真正"零重建"，而且不限条数。
 */
export default function DraftPage() {
  return null;
}
