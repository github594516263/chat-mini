# 会话路由改造 v2 · 实测定稿

> 本文件推翻 v1（`rewrite` + native history 浅跳）。
> v1 的核心假设是"真实路由会让切会话变贵"，实测证明**贵不是问题，状态丢失才是问题**；
> 而状态丢失可以用"状态提升到 layout"解决 —— 所以正确的解法是**主流 Next 做法 + 一处改造**，
> 不需要任何自研历史栈。

---

## 一、实测结论（先看数字）

同一份 UI（4301 字正文 + 输入框草稿 + 100ms 心跳），在 dev server 上跑 5 轮取中位数。
心跳 tick 是"正在生成的流还在不在"的代理指标：remount 会让它归零。

| 场景 | 切换耗时 | RSC 请求 | page remount | 草稿存活 | 后退键 |
|---|---|---|---|---|---|
| **A** 真实路由 `/spike/route/[id]`（带 prefetch） | **63ms** | 1 | 是 | ❌ 丢失 | ✅ 正确回溯 |
| **A-** 同 A，关掉 prefetch（冷 RSC） | 64ms | 1 | 是 | ❌ 丢失 | ✅ |
| **C** 真实路由 + **状态提升到 layout** | **66ms** | 1 | 是 | ✅ 存活 | ✅ |
| **B** 单路由浅导航（客户端取数） | **36ms** | 0 | 否 | ✅ 存活 | ❌ 退出应用 |

复现：`node scripts/spike-routing.mjs http://127.0.0.1:3123`（脚本与页面都是临时的，见 §八）。

### 三个决定性事实

1. **真实路由会 remount page 子树**（`mounts` 5→6，草稿被清空）。
   这就是"切走把生成掐断"的形态 —— 也是我们必须处理的东西。
2. **layout 不会随 param 变化重挂**。把草稿/run 提到 layout 层（变体 C），
   page 照样 remount，但草稿存活、心跳不归零。**这一处改造就消灭了 ① 的唯一硬伤。**
3. **A/C 与 B 的耗时差是 30ms**（66 vs 36），而 B 付出的代价是后退键失效、深链不存在、
   多标签互相踩。用 30ms 换一套自研历史栈 + 丢失后退键，**不划算**。

> dev server 下 prefetch 是关闭的（Next 开发模式行为），所以 A 与 A- 数字一致；
> 生产构建下 A/C 会命中 Router Cache，实际只会更快，不会更慢。
> 因此"63~66ms"应当理解为**悲观上界**。

### 关于 B 变体后退键的现象

按下后退后 URL 变成上一个**页面**（`/spike/route/...`），也就是说浏览器退出了应用，
而不是回到上一条会话。这正是"URL 不承载身份"的可观测后果。

---

## 二、定稿形态：① + 状态提升（记作 ①+C）

```
app/layout.tsx                    ← 全局壳
  └ SessionStateProvider          ← 提升层：run 订阅、流式状态、草稿、最近列表缓存
      └ app/c/[id]/page.tsx       ← 服务端取会话 + 消息，SSR 首屏（真实路由）
      └ app/page.tsx              ← 草稿态（无 id），发包后才 replace 到 /c/<id>
```

三条不变量：

| # | 不变量 |
|---|---|
| I1 | URL 是"哪条会话"的唯一真相（pathname 载体，不用 query） |
| I2 | 页面切换会 remount，因此**任何跨会话要存活的状态都必须住在 layout 之上** |
| I3 | 导航一律走路由（`router.push` / `router.replace`），不手写 `history.pushState` |

为什么这次不做第二套机制：跳转成本已经只有 60ms 量级，不值得为 30ms 自建历史栈。

---

## 三、状态提升：到底哪些要上去

这是本次改造的真正工作量所在。逐个判定：

| 状态 | 现在住哪 | 改造后 | 理由 |
|---|---|---|---|
| **流式 run 订阅**（`abortRef`/`runRef`/SSE） | `use-chat.ts`（在 page 内） | **提到 Provider** | 切走不能掐断生成；这是变体 C 救回来的核心 |
| **输入框草稿** | `chat.tsx` 内部 `useState` | **按会话 id 存在 Provider** | 切走再回来草稿要还在 |
| 消息正文 | `sessions[].messages` | 仍可在 page（SSR 注入）+ Provider 缓存 | SSR 首屏 → 首帧就有内容 |
| 流式中已收到的增量 | `use-chat.ts` | Provider（按 runId + seq 水位） | 切走后回来要能续上已收内容 |
| 滚动位置 | DOM | 暂不做（见 §七） | 价值低，成本高 |
| 侧栏折叠/主题/设置开关 | `AppShell` | 不动 | 本来就在 layout 层 |

判定口诀：**跨会话存活的（生成、草稿）上提；属于某条会话的（消息、滚动）留在页面。**

---

## 四、分步实施（每步可独立验收、独立回滚）

### Step 1 · 打通真实路由（不动状态）✅
- 新增 `app/c/[id]/page.tsx`：`getCurrentUser` → `getSession(userId, id)` → 渲染页面
- 不存在/非本人 → `notFound()`（与 `/api/sessions/[id]` 的 404 语义一致，不泄露存在性）
- 侧栏点击从 `selectSession(id)` 改为 `router.push(`/c/${id}`)`
- **验收**：粘 `/c/<id>` 直开正确；刷新不跳走；点侧栏 URL 变化且界面更新

### Step 2 · 状态提升（核心）✅
- 实际做法比原计划更省：**没有拆 hook**，而是把 `useChat()` 整个提到路由组 layout 的 client 宿主里（`chat-shell.tsx`），页面通过 context 取状态
- 已一并完成：`streaming` 改为按会话集合、run 订阅改为 `Map<sessionId, RunEntry>`、草稿按会话存
- **验收**：生成中切走再切回 → 正文连续、无重复前缀；草稿跨会话保留；两路生成可并存

### Step 3 · 草稿态（`/`）✅
- `/` 上发第一条消息 → 服务端建出会话 → `router.replace(`/c/${id}`)`
- 空对话不写历史格；`/` 本身不产生 URL 身份
- **验收**：新建→发送→URL 变 `/c/<真id>`（实测见 Step 2 验收里的「新建对话 → URL 换成 /c/<真id>」）

### Step 4 · 删除与重定位 ✅
- 删当前会话 → `router.replace(下一条 ?? "/")`（**必须 replace**，不能让后退回到已删资源）
- 实测：删除后按后退不会回到已删会话

### Step 5 · 深链鉴权回跳 ✅
- 未登录访问 `/c/<id>` → 登录页带 `?next=/c/<id>`
- `login-form.tsx` 提交后读 `next`，服务端 `safeNextPath()` 做同源白名单（只接受单个 `/` 开头，挡掉 `//`、协议、反斜杠、控制字符、登录页自己）
- **验收**：`?next=//evil.com`、`?next=https://example.com`、`?next=/\example.com` 全部落到 `/`

### Step 6 · 清理 ✅
- `activeKey` 保留但**降级**：它只在 `/`（草稿态）时决定"上次看的是哪条"，URL 里有 id 时永远以 URL 为准 —— 这是它现在唯一合法的职责
- 游客模式例外标注见 §七

### Step 7 · 回归 ✅
- 新增四个自洽脚本（自己建数据、自己清理，不依赖任何固定 id）：
  `e2e-routing-link.mjs`、`e2e-routing-state.mjs`、`e2e-routing-concurrent.mjs`、`e2e-routing-auth.mjs`
- 数据准备抽到 `scripts/lib/e2e-fixture.mjs`（只动 `[e2e]` 前缀的会话）

---

## 五、实施中必须踩准的四个细节

1. **SSR 快照 + 流式续传会打架**：SSR 拿的是请求时刻的快照，客户端起来后如果该消息 `status=streaming` 且有 `runId`，要用现有 `resumeRun` 从 `afterSeq` 续，**不能把 SSR 内容当基线再全量追加**。
2. **切换要 abort 的是订阅，不是生成**：现有 `selectSession` 的注释已经写对了（"只断订阅，不掐生成"），提层后要保持这个语义。
3. **`streaming` 必须是"按 sessionId 的集合"**，不能是单个布尔：提层后可能同时有两条会话在生成（另一个标签发起的）。
4. **`router.push` 到当前会话要短路**：否则点同一项会堆历史。

---

## 六、验收清单

- [x] 粘 `/c/<id>` 直开 → 正确会话，刷新不跳走
- [x] 切 3 条会话，后退 3 次 → 精确回溯，正文一致
- [x] 新建 → 发送 → URL 变 `/c/<真id>`
- [x] 生成中切走再切回 → 正文连续、无重复前缀、按钮状态正确
- [x] 切走再回来，草稿还在；切到别的会话，草稿是**那一条**的
- [x] 删除当前会话 → URL 变下一条，后退不回已删资源
- [x] 改名 → URL 不变
- [x] 未登录粘深链 → 登录后回原会话；`?next=//evil.com` → 回 `/`
- [x] 不存在的 id / 别人的 id → not-found 内容（服务器确实抛了 404 边界；HTTP status 见 Step 2 偏差说明）
- [ ] 全流程无 document 请求；每切一次恰好 1 个 RSC 请求（dev 下 Router Cache 语义与生产不同，留待 build 后核对）

---

## 七、明确不做 / 已知缺口

| 项 | 结论 |
|---|---|
| 标题进 URL | 不做：标题会自动生成且可改，每次改名都要重写历史链接 |
| 滚动位置恢复 | 暂不做：要自己做 keyed 滚动记忆，收益低于成本；后退时浏览器自带部分行为 |
| 跨标签实时同步（BroadcastChannel） | 不做：URL 方案已消除"看错会话"；列表同步留给后续 |
| 公开分享 `/share/[id]` | 独立需求（鉴权模型不同），单独做 |
| **游客模式** | 游客会话没有服务端实体，`/c/<id>` 只能在同一浏览器里直开；服务端无从判定归属，所以归属校验只能放在客户端：本地没有这条 id 时把地址栏纠正回 `/`（服务端仍返回 200 + not-found 内容，见 Step 2 偏差说明） |

---

## 八、临时脚手架 —— ✅ 已全部删除（2026-11-08）

实测用的文件曾**无鉴权、userId 写死**，属于安全隐患。现已清理：

| 路径 | 状态 |
|---|---|
| `src/app/spike/**`（route/shallow/keepalive + layout/spike-state） | 已删除 |
| `src/app/api/spike/[id]/route.ts` | 已删除 |
| `src/components/spike-probe.tsx`、`spike-keepalive.tsx` | 已删除 |
| `scripts/spike-routing.mjs`、`spike-heap.mjs`、`fixture-spike.mjs`、`.spike-sessions.json` | 已删除 |
| DB 里的 `[spike]` 会话 + 探针跑出来的测试会话 | 已软删除（66 条，`scripts/clean-test-data.mjs --apply`） |

测量能力没有丢：临时页面上的测量逻辑已经内化成四个正式 e2e（见 §四 Step 7）。

---

## 进度

### Step 1 · 打通真实路由 —— ✅ 已完成（2026-11-07）

改动：

| 文件 | 改了什么 |
|---|---|
| `src/app/c/[id]/page.tsx`（新增） | 服务端 `getCurrentUser()` + `getSession()`；不存在/非本人 → `notFound()`（与 `/api/sessions/[id]` 同为 404，不泄露存在性） |
| `src/components/chat.tsx` | 新增 `initialSessionId` / `initialSession` 两个 props；侧栏 `onSelect` 改为「先 `selectSession` 再 `router.push('/c/'+id)`」 |
| `src/lib/use-chat.ts` | 水合时 `activeId` 优先级改为 **URL > localStorage > 第一条**；服务端确认过的会话若不在列表前 50 条，补进列表（避免「URL 有 id、侧栏没有」） |
| `scripts/probe-step1.mjs`（临时） | 14 项验收脚本 |

验收结果（`node scripts/probe-step1.mjs`）：**14/14 通过** —— 直开、标题正确、侧栏切换写 URL、后退回溯、刷新保持、404、游客直开。

**与计划的偏差（有意为之）**：
- 消息正文**没有做成 SSR**，仍由客户端拉 `/api/sessions/[id]/messages`。Step 1 的目标只是"URL 能承载会话"，一次动太多会把回滚单位搞大。SSR 消息留到 Step 2 之后单独评估。

**已知缺口（下一步要修）**：
- 新建对话、删除当前会话时，URL **不会**跟着变（Step 3 / Step 4）。
- 切会话仍会 remount → 草稿与生成中断（Step 2）。
- 游客：`/c/<id>` 只有同一浏览器能打开，且服务端无法判定归属（§七 已列为已知缺口）。

### Step 2 · 状态提升 —— ✅ 已完成（2026-11-08）

结构改动（这一步把 v2 的核心落地了）：

| 文件 | 作用 |
|---|---|
| `src/app/(chat)/layout.tsx`（新） | 路由组 layout。`getCurrentUser()` + `live` → `<ChatShell>`。**它不随 `/c/[id]` 参数变化重挂**，这是整件事的地基 |
| `src/components/chat-shell.tsx`（新） | 客户端宿主：`useChat()` + `<AppShell>` + `ChatContext.Provider`。侧栏也一起搬进来了，切会话不再重建侧栏 |
| `src/components/chat-context.tsx`（新） | `ChatController = ReturnType<typeof useChat>` + `useChatContext()` |
| `src/components/chat-view.tsx`（新） | 原 `chat.tsx` 的页面主体，改为从 context 取状态（逐行比对过，只改了取数方式） |
| `src/lib/session-route.ts`（新） | URL↔会话 id 的唯一解释层（正则只出现在这里） |
| `src/app/(chat)/page.tsx`、`src/app/(chat)/c/[id]/page.tsx` | 只渲染 `<ChatView />`；后者保留服务端存在性校验 |

`use-chat.ts` 里的四处关键改动：

1. **streaming 从布尔变成"按会话的集合"**。原来是 `streaming: boolean`，会话提到 Provider 之后它会让"别的会话在后台跑"把当前会话的发送按钮也变灰。现在 `streamingIds: string[]`，`streaming = streamingIds.includes(activeId)`。
2. **单订阅变成 `Map<sessionId, RunEntry>`**（controller + 服务端 runId + `stoppedByUser`）。原来一个 `abortRef` 兜住全局，只能同时跑一个；`send` 里 `if (abortRef.current) return` 会让"另一个会话正在生成"变成**静默吃掉你的发送**。现在两条会话可以同时生成，`stop()` 只停当前这条。
3. **`selectSession` 不再 abort**。状态已经活在 Provider 里，切走之后订阅继续把增量写进对应会话，切回来就是完整正文。
4. **草稿 `drafts: Record<sessionId, string>`**：输入框内容按会话存，`draft`/`setDraft` 走 context。

URL 所有权（Step 3/4 顺带做完的部分）：
- `URL → 状态`：`ChatShell` 里一个 effect 调 `syncFromUrl`，后退/前进/直开链接都走这条。**不做反向 effect**（用 `activeId` 去纠正 URL 会和后退键打架）。
- `状态 → URL`：只由用户动作显式触发 —— `selectSession → router.push`，`newSession → router.replace('/')` 再 `replace('/c/<真id>')`，`deleteSession → router.replace(下一条)`（必须是 replace，否则后退会回到一条已删会话）。
- 老会话不在列表前 50 条时，`syncFromUrl` 会补拉 `/api/sessions/<id>` 并插进列表，避免"URL 有 id、侧栏没这条"。

验收（`node scripts/probe-step2.mjs` / `probe-step2d.mjs`）：

```
草稿：A 打草稿 → 切 B（空）→ 切回 A（还在）→ 切回 B（B 的也在）        4/4
流式：A 生成中切到 B → B 不显示 A 的停止按钮、B 可发送              2/2
     切回 A：109 字 → 703 字（订阅没断）、仍在流式中、无重复气泡        4/4
URL： 新建 → /c/<真id>；删除 → 立刻离开已删 id；后退不回已删会话       4/4
并发：S1 生成中在 S2 发送 → 两路 stream 并存；停 S1 不影响 S2          9/9
回归：Step 1 的 14 项全部通过（probe-step1.mjs）                    14/14
```

**新增的已知偏差（服务端 404 的 status）**：
`/c/<不存在的 id>`（登录态）页面**内容**是对的 —— 服务端确实抛了 `NEXT_HTTP_ERROR_FALLBACK;404`，渲染出 not-found 树；但 **HTTP 状态码是 200**，因为 `(chat)` layout 的 shell 先被流式刷出去了，状态码已经发走、无法回改。
要拿到真的 404 得把校验提到任何 flush 之前（等于放弃流式 SSR 或加 middleware 做 DB 校验），代价明显大于收益。**数据接口 `/api/sessions/[id]` 仍然是正确的 404**，所以"不泄露 id 是否存在"这条性质没有丢。

### Step 5–7 · 收尾 —— ✅ 已完成（2026-11-08）

| 改动 | 说明 |
|---|---|
| `src/lib/session-route.ts` 加 `safeNextPath()` | 登录回跳只接受站内路径：挡掉 `//evil.com`、协议、反斜杠、控制字符、登录页自身 |
| `src/app/login/page.tsx` | 接 `searchParams.next`；已登录访问登录页也按 `next` 跳 |
| `src/components/login-form.tsx` | 成功后 `router.replace(next ?? "/")` |
| `src/components/account-panel.tsx` | 退出登录后 `router.replace("/")`：身份变了，不能停在 `/c/<id>` |
| `src/components/chat-shell.tsx` | 游客态兜底：URL 里的 id 不在本地仓里 → `router.replace("/")`，不让地址栏声称一条不存在的会话 |

验收（`e2e-routing-auth.mjs`）：**7/7** —— 登录回跳、三种恶意 `next` 全部落到 `/`、游客打开别人的链接纠偏回 `/`、游客自己的会话深链保留。

### 全量回归（2026-11-08）

| 套件 | 结果 |
|---|---|
| `e2e-routing-link.mjs` | 14/14 |
| `e2e-routing-state.mjs` | 17/17 |
| `e2e-routing-concurrent.mjs` | 9/9 |
| `e2e-routing-auth.mjs` | 7/7 |
| `e2e-chat-server.mjs`（服务端全链路） | 21/21 |
| `e2e-resume.mjs`（中断/续传/停止/继续） | 全通过 |
| `e2e-actions.mjs`（重新生成/编辑重发/复制） | 全通过 |
| `e2e-chat.mjs`（游客多会话） | 全通过 |
| `e2e-sidebar.mjs`（搜索/重命名/排序） | 全通过 |
| `tsc --noEmit` | 0 error |

**仍未做（明确记录，不是遗漏）**：
- 滚动位置恢复（`Map<sessionId, scrollTop>`）—— §七 保持"暂不做"
- 生产构建下的 RSC 请求数核对（dev 与生产 Router Cache 语义不同）
- 消息正文 SSR（当前仍客户端拉；URL 承载身份这件事已经达成）

---

### Step 8 · 视图层上移：真正的「零重建」 —— ✅ 已完成（2026-11-08）

对照 `vercel/ai-chatbot`（同栈同构：`(chat)` 路由组 + `/chat/[id]`）发现的差距：
**它的路由页是 `return null`，整个聊天界面挂在 layout 上。** 我们之前把 `ChatView` 留在 page 里，
所以切会话等于重建一次界面（输入框重算高度、滚动归零、失焦）。

改动：

| 文件 | 改了什么 |
|---|---|
| `(chat)/layout.tsx` | 不变（仍只做 auth + live） |
| `components/chat-shell.tsx` | 直接渲染 `<ChatView />`；`children`（页面）退化为空壳 |
| `(chat)/page.tsx` | 变成 `return null`（草稿态没有界面，界面在 layout） |
| `(chat)/c/[id]/page.tsx` | 变成 `return null`（不再渲染 ChatView） |
| `lib/use-chat.ts` | 新增 `missingSessionId`：URL id 拉不到 404 时记下来 |
| `components/chat-shell.tsx` | 新增 `SessionNotFound` 视图；`syncFromUrl` 的 effect 依赖加上 `hydrated` |
| `components/chat-view.tsx` | composer 加 `data-composer` 标记（测试稳定性） |

**实测量到的是"同一个 DOM 节点"，不是"看起来没闪"**：

```
✅ 切会话后 <main> 是同一个 DOM 节点（没有重建）
✅ 切会话后输入框是同一个 DOM 节点（没有重建）
✅ 切会话后草稿的值还在（按会话隔离）  — 切前 "光标位置测试-ABCDE" → 切后 "光标位置测试-ABCDE"
✅ 切会话后焦点没有被打断（仍在输入框）
```

**404 语义随之改变（必须记录）**：
- 视图不在 page 里了，服务端 `notFound()` 只会得到「404 页 + layout 里照常渲染的聊天界面」这种自相矛盾的画面
- 所以存在性判断搬到客户端：`ChatShell` 发现 URL id 不在列表里 → 拉 `/api/sessions/[id]` → 404 就渲染 **「会话不存在」** 面板，且**不渲染输入框**（不装作一条空会话）
- `/api/sessions/[id]` 的服务端 404 语义不变；RSC payload 对所有 id 完全一致，不泄露存在性

**已知小偏差**：切回某条会话时，草稿文本在，但光标落在末尾 —— 受控 textarea 换值的固有行为
（要记住光标得自己存 `selectionStart`，判断不值得，已在测试里断言并注释）。

**验收**：15/15（深链）+ 28/28（状态/零重建）+ 9/9（并发）+ 7/7（鉴权）
+ 21/21（服务端全链路）+ actions/resume/chat/sidebar 全通过。

---

## 决策记录

| 日期 | 决策 | 结论 |
|---|---|---|
| 2026-11-07 | v1 全 RSC 是否太贵 | 否：63ms（dev，悲观上界） |
| 2026-11-07 | 单路由浅导航（v1）| **放弃**：省 30ms，但丢后退键 + 需自研历史栈 |
| 2026-11-07 | 真实路由的 remount 是否致命 | 否：状态提升到 layout 后草稿与生成均存活（变体 C 实测） |
| 2026-11-07 | **定稿** | **①+C：真实路由 `/c/[id]` + 状态提升 + 不做浅导航** |
| 2026-11-08 | 生成状态用布尔还是按会话 | **按会话集合**：全局布尔会让后台会话把当前会话的按钮变灰 |
| 2026-11-08 | 单订阅还是按会话多订阅 | **`Map<sessionId, RunEntry>`**：否则"别的会话在生成"会静默吃掉发送 |
| 2026-11-08 | 切会话是否 abort 订阅 | **否**：状态在 Provider 里，订阅继续跑，切回来即完整正文 |
| 2026-11-08 | 视图放 page 还是 layout | **layout**：放 page 会随参数变化被卸载重建（实测：放 layout 后 `<main>` 与输入框是同一个 DOM 节点） |
| 2026-11-08 | 404 谁来判 | **客户端**：服务端 `notFound()` 会和 layout 里的界面同时出现，自相矛盾；改由 ChatShell 拉 `/api/sessions/[id]` 判 404 |
| 2026-11-08 | 是否开 `cacheComponents` | **暂不开**：视图已上移，Activity 保活（3 条上限）收益被覆盖；PPR 外壳另算，等阶段 1 |
