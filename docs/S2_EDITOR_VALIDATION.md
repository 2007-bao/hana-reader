# S2 所见即所得编辑器验证记录

## 结论

S2 选用 **Milkdown + ProseMirror** 作为 Markdown-native 编辑内核。它能在 Hana iframe 的本地资源环境中挂载、直接显示渲染后的文档结构，并通过 Milkdown serializer 回到 Markdown；不需要 CDN，也不触碰 ResourceIO 写权限。

## 已验证范围

- 标题、段落、强调、行内代码、链接
- 有序 / 无序 / 嵌套列表
- GFM 任务列表与表格
- 引用、分隔线、图片、代码围栏
- 内存内编辑与 Markdown 序列化
- 20 组 Markdown round-trip fixture
- 编辑器 bundle 在 Chromium 中实际挂载
- 编辑预览与只读预览可切换；退出编辑丢弃本地草稿
- 编辑上限为 512 KB；超过上限保持只读

## 阶段边界

S2 不写回文件，不声明 `resource.write`，不做冲突检测、Diff、撤销持久化或保存按钮。当前读取结果中的 `version` 仅作为 S3 设计基线保留。

编辑态的序列化结果未来应作为 S3 的候选保存输入：保存前重新读取并比较基线 version，经过预览与冲突确认后才允许写回。

## 已知限制

- Milkdown 默认会规范化部分 Markdown 表示（例如无序列表标记），S3 需要决定是否接受语义等价而非字节级保真。
- 编辑器目前只做体验验证，没有工具栏和写回反馈。
- Hana 内真实安装验证仍需在用户环境中完成，尤其是中文 IME、iframe resize 与长文输入手感。
