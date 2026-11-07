"use client";

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const SAMPLE = `## 渲染自检

这段是固定 markdown，用来确认 streamdown 的样式、代码高亮、表格、列表都正常工作。

| 检查项 | 期望 | 状态 |
| --- | --- | --- |
| 标题层级 | h2/h3 有区分 | 看上面 |
| 行内代码 | \`inline code\` 有底色 | 就是这个词 |
| 代码高亮 | 关键字有颜色 | 看下面 |
| 表格 | 有边框、可横向滚动 | 就是这张 |
| 引用 | 左侧竖线 | 见下 |

\`\`\`ts
// 事件协议的核心就这一段
for await (const event of provider({ messages, signal })) {
  emit(event); // JSON.stringify(event) + "\\n"
}
\`\`\`

> 引用块：协议握在自己手里，前端就不用跟着 SDK 走。

- 列表项一
- 列表项二，带 **加粗** 和 [链接](https://example.com)
  - 嵌套项

1. 有序项
2. 有序项
`;

export default function PreviewPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Streamdown mode="static" plugins={{ code }} className="text-[15px] leading-7">
        {SAMPLE}
      </Streamdown>
    </div>
  );
}
