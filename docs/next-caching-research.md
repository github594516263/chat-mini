# Next.js 是怎么处理「页面缓存」的（调研，2026-11-08）

> 环境：next 16.3.0 / react 19.2.5（官方文档为 v16.4.5）
> 证据两类：**源码**（`node_modules/next|react`，可复验）+ **官方文档原文**（已抓取归档）
> 目的：回答"切会话时页面重建、滚动丢、输入框重建，是不是这个框架注定不行"

---

## 一、先纠一个概念：Next 里有 **六层**缓存，不是一个

大家口中的「页面缓存」混了至少三种东西，必须分层看：

| # | 层 | 管什么 | 官方默认（不配置） | 开关 |
|---|---|---|---|---|
| 1 | **静态外壳 / PPR** | 直连和导航时"立刻有东西可画" | 每个路由按请求渲染（无壳） | `cacheComponents: true` |
| 2 | **客户端段缓存（Router Cache）** | 再次进入同一段要不要重取 RSC | `dynamic: 0s`（不缓存）、`static: 5min` | `experimental.staleTimes` |
| 3 | **预取（Prefetch）** | 点击之前数据是否已到 | 无 Cache Components 时按 Link 规则；开启后默认预取 App Shell | `partialPrefetching`、`<Link prefetch={true}>`、`router.prefetch` |
| 4 | **路由保活（bfcache）** | 切走的路由**组件与 DOM 是否保留** | **关闭** | `cacheComponents: true` |
| 5 | **服务端数据缓存** | `use cache` / `cacheLife` / `cacheTag` 的返回值 | 不缓存（动态默认） | `use cache` 指令 |
| 6 | **应用层状态提升**（我们自己的） | 跨任意多条会话的数据状态 | 框架不提供 | 自己写（layout 级 Provider） |

**关键结论：我们项目只有第 6 层。1–5 全在默认值上，而第 4 层（真正的"页面缓存"）默认就是关的。**

---

## 二、第 4 层：Next 确实有页面缓存，实现就是 React `<Activity>`

### 官方文档原文（`/docs/app/api-reference/config/next-config-js/cacheComponents`，节 "Navigation with Activity"）

> When `cacheComponents` is enabled, Next.js uses React's `<Activity>` component to preserve component state during client-side navigation.
>
> Rather than unmounting the previous route when you navigate away, Next.js sets the Activity mode to `"hidden"`. This means:
> - Component state is preserved when navigating between routes
> - When you navigate back, the previous route reappears with its state intact
> - Effects are cleaned up when a route is hidden, and recreated when it becomes visible again
>
> Next.js uses **heuristics to keep a few recently visited routes "hidden"**, while older routes are removed from the DOM to prevent excessive growth.

### 保的到底是什么（`/docs/app/guides/preserving-ui-state`）

> Activity keeps the DOM in the document (hidden with `display: none`), so **both React state and DOM state are preserved: form drafts, scroll positions, expanded `<details>` elements, video playback progress**, and more.

→ 也就是说：你截图里那两件事（滚动位置、"修改对话"的编辑框），**开这个开关后是框架白送的**，不需要我写 `Map<sessionId, scrollTop>`。

### 源码级验证

`node_modules/next/dist/client/components/bfcache-state-manager.js:13`

```js
const MAX_BF_CACHE_ENTRIES = process.env.__NEXT_CACHE_COMPONENTS ? 3 : 1;
```

`layout-router.js:551` 注释：

```js
// At each level of the route tree, not only do we render the currently
// active segment — we also render the last N segments that were active at
// this level inside a hidden <Activity> boundary, to preserve their state
// if or when the user navigates to them again.
```

`layout-router.js:684`：

```js
if (process.env.__NEXT_CACHE_COMPONENTS) {
  child = <Activity name={…} mode={stateKey === activeStateKey ? 'visible' : 'hidden'}>
    {child}
  </Activity>
}
```

**深度 = 3，包含当前这条 → 实际多记住 2 条；硬编码，无配置项**（全仓只有这一处定义）。
排序是 MRU（最近激活的在前），不是历史顺序 —— 源码 TODO 自己承认这点还没做对。

### 为什么之前量到"后退也不保状态"

因为我们没开闸，常数是 `1`：等于只剩当前段，其余照常卸载。**不是 Next 不行，是模式不对。**

---

## 三、第 2 层：客户端段缓存（它和 4 不是一回事）

`/docs/app/api-reference/config/next-config-js/staleTimes`：

> `dynamic` … Default: **0 seconds (not cached)**（v15 起从 30s 改为 0s）
> `static` … Default: **5 minutes**
> "This doesn't change back/forward caching behavior to prevent layout shift and to prevent losing the browser scroll position."

读法：
- 这一层只决定**要不要重新取 RSC payload**，不影响组件是否重建 —— 所以我们之前测到"后退时 RSC=0 但组件还是重挂"完全符合文档。
- 想让它缓存动态路由：`experimental.staleTimes.dynamic = 30` 之类。仍是 experimental。

---

## 四、第 1/3 层：PPR 静态外壳 + 预取（"秒开"的真正来源）

`/docs/app/getting-started/caching`：

> This generates a **static shell** consisting of HTML for initial page loads and a serialized RSC Payload for client-side navigation… Every produced static shell can be served directly from a CDN… This makes **direct navigations instant**.

`/docs/app/guides/instant-navigation`：

> A navigation is **instant** when the browser can start rendering the new page the moment the user clicks, with static, cached, and fallback content showing up right away, while the server streams the remaining content into its fallbacks.
> …requires enabling **Cache Components and Partial Prefetching**, then following the validation errors that appear.

`/docs/app/getting-started/caching`（Prefetching 节）：

> With Partial Prefetching enabled, the router prefetches each route's **App Shell** by default… To also prefetch cached content that depends on a link's URL data, such as `searchParams` or dynamic `params`, set **`prefetch={true}`** on that link.

---

## 五、迁移到 Cache Components 要动的四处（官方迁移指南）

`/docs/app/guides/migrating-to-cache-components`：

| 项 | 官方说法 | 我们的现状 |
|---|---|---|
| `dynamic = "force-dynamic"` | "**Remove the config.** With Cache Components, uncached data and Request-time APIs already run at request time." | `(chat)/layout.tsx` 有 → **要删** |
| `revalidate` / `fetchCache` | 被 `use cache` + `cacheLife` 取代 | 未使用 → 无影响 |
| `cookies()` / `headers()` 等运行时 API | 必须包 `<Suspense>` | `layout.tsx` 直接 `await getCurrentUser()` → **要包** |
| `runtime` 段配置 | Cache Components **不支持**（必须 Node runtime） | 全项目无 `export const runtime` → ✅ 符合前提 |

另外官方给了 per-segment 逃生门：`instant = false`，也有 codemod
（`cache-components-instant-false`）能一次性给所有页面上锁。迁移流程本身就是"跟着 dev overlay 的 validation 报错走"。

---

## 六、对我们这个聊天应用意味着什么

### 三层各管一段，互补而不是替代

| 需求 | 该用哪层 | 我们能拿到多少 |
|---|---|---|
| 跨**任意多条**会话：草稿、生成流、编辑态、滚动位置 | 第 6 层：我们的 Provider | ✅ 已实现并验收（不限条数） |
| 最近 **3 条**会话：焦点、输入法、展开/折叠、DOM 细节 | 第 4 层：Activity（开 cacheComponents） | 白拿，但有 3 条上限 |
| 点下去"立刻有画面" | 第 1+3 层：PPR 外壳 + prefetch | 需要改渲染模型 |

### 结论

1. **"这个框架注定搞不了页面缓存"是错的** —— 官方有，且语义就是你想要的 keep-alive（连滚动的保）。
2. **但它不是开关一开就完事**：要按 Cache Components 的模型改渲染（删 `force-dynamic`、运行时 API 包 Suspense、跟着 validation 走）。
3. **3 条上限是硬编码**，不符合"十几条随便切"的预期。超出的部分只能靠第 6 层（我们已有）或自研 LRU 保活。

---

## 七、有两个坑必须提前知道（否则迁移会翻车）

1. **隐藏≠不存在**：Activity 用 `display: none` 保留 DOM，所以
   `document.querySelector('main')` 之类会**选到隐藏的那条会话**。
   我们现有的 e2e（`e2e-routing-*.mjs`）大量直接 `querySelector('main')`，
   开 cacheComponents 后必须改成"按可见性过滤"，否则会量到错的节点。
2. **弹层类 UI 要主动收**：官方 `preserving-ui-state` 指南明确说
   dropdown / popover / dialog 这类"瞬时交互"在页面被隐藏后应当关闭。
   我们有：账号面板、会话行菜单（重命名/删除）、设置面板 —— 都要加"变为 hidden 时关闭"的处理，
   否则会出现"切回来时菜单还开着"的怪现象。

---

## 八、建议的分阶段路线

**阶段 0（不依赖任何开关，立刻可做）**
- 把 header + composer 从 page 提到 `(chat)/layout.tsx` 侧（官方语义：*Layouts do not rerender*）
- 骨架替代"整块换成一行字"
- 侧栏 `router.prefetch` 预热 + 最近 N 条会话消息预热

**阶段 1（开闸拿 Activity + PPR）**
- `next.config.ts`: `cacheComponents: true` + `partialPrefetching: true`
- 删 `export const dynamic = "force-dynamic"`，`getCurrentUser()` 包 `<Suspense>`
- 跟着 dev overlay 的 instant-navigation validation 改到干净
- 顺手把 e2e 的可见性过滤改好、弹层加隐藏时关闭

**阶段 2（可选）**
- 若"3 条"不够：自研 LRU keep-alive，或把更多数据下推到 Provider（我们已在做的方向）

---

## 八、同类项目怎么做的（实证：抓了源码）

### vercel/ai-chatbot —— 和我们**同构**的官方模板

路由结构完全一样：`app/(chat)/layout.tsx` + `app/(chat)/page.tsx` + `app/(chat)/chat/[id]/page.tsx`，用 Drizzle + Postgres，App Router。

**① 路由页是空壳，整个文件 3 行**

```tsx
// app/(chat)/chat/[id]/page.tsx   （app/(chat)/page.tsx 同样如此）
export default function Page() {
  return null;
}
```

URL 只负责给路由一个"段身份"，**UI 全在 layout 里**：

```tsx
// app/(chat)/layout.tsx
<DataStreamProvider>
  <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
    <SidebarShell>{children}</SidebarShell>   // ← 注意 children 只是那个 null
  </Suspense>
</DataStreamProvider>

async function SidebarShell({ children }) {
  const [session, cookieStore] = await Promise.all([auth(), cookies()]);
  return (
    <SidebarProvider …>
      <AppSidebar user={session?.user} />
      <SidebarInset>
        <Suspense fallback={<div className="flex h-dvh" />}>   // ← cookies() 在 Suspense 里
          <ActiveChatProvider>
            <ChatShell />        // ← header + Messages + MultimodalInput 全在这里
          </ActiveChatProvider>
        </Suspense>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
```

对照我们的结构：`(chat)/layout.tsx` → `<ChatShell>`（Provider + AppShell）→ page 里是 `<ChatView>`。
**差别只在：他们把 header/composer/消息列表全塞进 layout，page 只剩 null；我们把这些留在 page 里。**

**② 开了 Cache Components**

```ts
// next.config.ts
cacheComponents: true,
experimental: {
  appNewScrollHandler: true,
  cachedNavigations: true,
  prefetchInlining: true,
  turbopackFileSystemCacheForDev: true,
},
reactCompiler: true,
```

→ 因此他们**天然拿到** Activity 保活（隐藏 3 条路由，DOM + React 状态都留）+ PPR 静态外壳。

**③ chatId 从 URL 读，新会话先预生成 UUID**

```ts
// hooks/use-active-chat.tsx
const pathname = usePathname();
const chatIdFromUrl = extractChatId(pathname);
const isNewChat = !chatIdFromUrl;
const newChatIdRef = useRef(generateUUID());
const chatId = chatIdFromUrl ?? newChatIdRef.current;
```

**④ 消息用 SWR 客户端取，`isLoading` 驱动骨架**

```ts
const { data: chatData, isLoading } = useSWR(
  isNewChat ? null : `/api/messages?chatId=${chatId}`
);
// 另有 loadedChatIds: useRef(new Set()) 保证每条会话只灌一次
```

→ 注意：**他们也没做消息 SSR**，和我们一样是客户端拉。区别是他们多了 SWR 这层**客户端数据缓存**（同一条会话在内存里，回头再进不重新拉）。

**⑤ 切换会话时主动重置**（但**不保留跨会话草稿**）

```ts
useEffect(() => {
  if (prevChatIdRef.current !== chatId) {
    prevChatIdRef.current = chatId;
    stopRef.current();            // 停流
    setArtifact(initialArtifactData);
    setEditingMessage(null);
    setAttachments([]);
  }
}, [chatId, setArtifact]);
```
`const [input, setInput] = useState("")` —— **单一输入状态，不按会话存草稿**。

**⑥ 侧栏用 `<Link>`，吃 Next 自动 prefetch**

```tsx
// components/chat/sidebar-history-item.tsx:67
<Link href={`/chat/${chat.id}`} onClick={closeMobile}>
```

**⑦ 滚动：手写 near-bottom 检测 + ResizeObserver**

```ts
// hooks/use-scroll-to-bottom.tsx
return scrollTop + clientHeight >= scrollHeight - 100;   // 阈值 100px
```
→ 和我们刚写的实现几乎一样（我们阈值 120px）。**说明"贴底才跟随"是这行的标准做法，不是我们瞎猜。**

### lobehub/lobe-chat —— 另一条路线：客户端 store

`src/store/chat/**` 是一个庞大的 zustand 状态树（含 agents/streaming handler），服务端只提供 API/后端能力，页面本身是薄壳。属于"重前端 SPA"路线，观感上和 ChatGPT/Claude 一致，代价和 DeepSeek 早先那个"URL 不变"问题是同一类。

### 我们 vs 官方模板

| 项 | vercel/ai-chatbot | 我们 |
|---|---|---|
| 路由结构 `(chat)/chat/[id]` | ✅ | ✅ 一致 |
| 状态提升到 layout | ✅（`ActiveChatProvider` + `ChatShell`） | ✅（`ChatContext` + `ChatShell`） |
| **page 退化为 null** | ✅ | ❌ page 里还挂着 `ChatView` |
| **`cacheComponents: true`** | ✅ → Activity 保活 + PPR | ❌ 未开 |
| 客户端数据缓存 | ✅ SWR（按 chatId 键） | ⚠️ 只有 Provider 内存（等价） |
| **`<Link>` prefetch** | ✅ | ❌ 用 `router.push` |
| 加载骨架 | ✅ `isLoading` + Suspense fallback | ❌ 整块换一行字 |
| 跨会话草稿 | ❌ 不做 | ✅ 我们做了 |
| 并发多会话生成 | ❌ 切走就 stop | ✅ 我们做了 |
| 编辑态/滚动跨切换 | 靠 Activity 白拿 | ✅ 手写（Activity 开后可简化） |

**结论：官方模板 = 我们这套方案 + 开 `cacheComponents` + 外壳塞进 layout + `<Link>` prefetch。前面说的"阶段 0 / 阶段 1"就是这个组合，不是我自己发明的东西。**

---

## 九、落地记录（2026-11-08）：只做了「零重建」这一层

调研结论落地时，选的是**不依赖任何框架开关**的那一半：

| 做了什么 | 结果 |
|---|---|
| 视图从 page 上移到 layout（`ChatShell` 直接渲染 `ChatView`） | 切会话时 `<main>` 与 composer 都是**同一个 DOM 节点**（用引用相等验证，不是看观感） |
| 两个 page 退化为 `return null` | 导航时没有子树要卸载 → 不受"保活 3 条"上限约束，任意多条会话都零重建 |
| 404 判断搬到客户端 | 服务端 `notFound()` 会和 layout 界面同时出现；现在由 `ChatShell` 拉 `/api/sessions/[id]`，404 渲染「会话不存在」且不渲染输入框 |
| `cacheComponents` | **没开**（Activity 的收益已被"零重建"覆盖；PPR 外壳留待需要时再评估） |

验收：`15/15 + 28/28 + 9/9 + 7/7 + 21/21` 全绿，老用例（actions/resume/chat/sidebar）无回归。

**仍然存在的、跟缓存无关的那一层**：冷会话第一次进入时的消息往返（数据层），
需要"预热最近 N 条"或"消息也 SSR"才能消掉 —— 这是下一阶段的事。

---

## 参考资料


- `node_modules/next/dist/client/components/bfcache-state-manager.js:13`
- `node_modules/next/dist/client/components/layout-router.js:551,684`
- `node_modules/react/cjs/react.development.js`（`Activity` = `Symbol.for("react.activity")`）
- 官方文档：`/docs/app/api-reference/config/next-config-js/cacheComponents`（Navigation with Activity）
- 官方文档：`/docs/app/guides/preserving-ui-state`（Activity 保留哪些状态）
- 官方文档：`/docs/app/guides/instant-navigation`、`/docs/app/getting-started/caching`
- 官方文档：`/docs/app/api-reference/config/next-config-js/staleTimes`
- 官方文档：`/docs/app/guides/migrating-to-cache-components`
- 官方文档：`/docs/app/api-reference/file-conventions/layout`（*Layouts do not rerender*）
