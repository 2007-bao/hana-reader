# 下一次会话交接

## 当前状态

- 项目：Hana Reader
- 仓库：<https://github.com/2007-bao/hana-reader>
- 当前本地分支：`feat/complete-reader-workbench`
- 版本目标：`v1.0.0`
- 稳定基线：`main` / `v0.9.0`
- 当前验证：`npm test`（新增批注 DOM、Copilot route、Notebook/批注存储回归后共 22 项）
- 工作区无关目录：`knob-motion-lab/`，不要查看、修改、提交或打包

## 本阶段已经完成

### 阅读与编辑

- 左侧项目文件树、延迟展开、常见文本/代码阅读
- Markdown 安全渲染、GFM、任务列表、代码高亮
- Milkdown Markdown 所见即所得编辑器
- 多类型文本安全写回、版本冲突检测、撤销和安全 HTML 预览
- Maple Mono、Maple 蓝色语义色板、三栏布局、文件树图标/层级线/滚动保持

### Copilot

- `routes/ui.js` 的 `POST /copilot/ask` 通过 `model:sample-text` 接入 Hana utility 模型
- 前端只提交用户勾选的当前文件或选中文本
- 总结 / 解释 / 知识点 / 审阅快捷任务
- 文件级对话历史、失败重试、上下文 8k/16k/24k 档位和服务端截断
- Markdown 修改建议需代码块、原文精确匹配和确认后才进入编辑器/安全自动保存

### Markdown 批注审阅

- 选区批注、高亮、下划线
- 批注编辑、回复、完成、删除、最近一次操作撤销
- 侧栏列表、定位原文、文本锚点恢复
- 使用浏览器本地存储，不改写普通 Markdown 原文

### Notebook

- 多份本地 Notebook、标题编辑、切换、新建、删除
- 当前文件/选区引用
- 从批注或 Copilot 回复加入笔记
- Markdown 预览、下载导出和带版本哈希的安全写回

## 当前明确限制

1. Copilot 依赖 Hana 宿主的 `model.sample` 能力和已配置的 utility 文本模型；不可用时应给出降级提示。
2. Copilot 自动应用只处理能在当前 Markdown 原文中精确找到的纯文本选区；含复杂渲染格式的选区会拒绝自动覆盖。
3. 批注存于当前浏览器本地存储，尚未做跨设备 sidecar 同步。
4. Notebook “写回文件”目前选择已有资源并执行安全覆盖，不负责创建新文件。
5. 全文搜索、跨文件问答、Git 状态、多标签等是候选能力，不要在本阶段顺手扩展。

## 下一步只做这些

- 在 Hana dev loop 中 reload 本地插件，检查实际 `model:sample-text` 返回形状与 UI 交互。
- 重点手测：打开 Markdown → 选择文本 → 批注/高亮/下划线 → 关闭再打开恢复；Copilot 勾选上下文 → 失败重试 → 代码块建议应用；Notebook 引用/预览/导出/安全写回。
- 如果宿主实际模型返回结构不同，只修改 `routes/ui.js` 的 `extractModelText()` 兼容层，不要把 API Key 或宿主路径放进前端。
- 通过 `npm test` 后检查 `git diff --stat`，确认 diff 不包含 `knob-motion-lab/`。
- 未获负责人明确授权前，不要 push、建 PR、合并或发布 GitHub 标签。

## 关键实现入口

- `src/panel.js`：页面状态、文件树、编辑器、Copilot、批注、Notebook 和事件绑定
- `src/annotation-engine.js`：文本选区锚点、恢复定位和 DOM 标记
- `src/annotation-store.js`：本地批注存储与稳定资源键
- `src/notebook-store.js`：多份 Notebook 存储、迁移和引用拼接
- `assets/panel.css`：Maple 视觉、Copilot/批注/Notebook 交互样式
- `routes/ui.js`：ResourceIO 安全读写与 Copilot 模型 route
- `tests/`：manifest、渲染、编辑器、写回、Copilot route 和本地状态回归

## 开发纪律

- 先确认 `git branch --show-current` 和 `git status`。
- 不要纳入 `knob-motion-lab/`。
- 修改后运行 `npm test`，不要只运行 build。
- 不要破坏标题色阶：银河蓝 → 清晨蓝 → 溪水蓝 → 冰蓝 → 极浅青蓝。
- 不提交 API Key、Cookie、个人文件、会话导出或真实项目内容。
