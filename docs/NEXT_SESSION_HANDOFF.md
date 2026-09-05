# 下一次会话交接

## 当前状态

- 项目：Hana Reader
- 仓库：<https://github.com/2007-bao/hana-reader>
- 稳定基线：`main` / `v0.9.0`
- 最近提交：右侧 Notebook 基础能力与后续路线文档
- 最近发布包：`hana-reader-v0.9.0.zip`
- 当前测试：`npm test`，14 项全部通过
- 工作区无关目录：`knob-motion-lab/`，不要提交

## 已经完成到哪里

Hana Reader 已经完成基础阅读工作台：

- 左侧项目文件树
- 中间 Markdown / 常见代码阅读
- Markdown 编辑、安全写回、冲突检测、Diff、撤销
- 安全 HTML 预览
- Maple Mono、蓝色语义色板和三栏布局
- 文件树图标、父子层级线、滚动位置保持
- 右侧 Copilot / Notebook 切换
- Notebook 独立本地自动保存

当前右侧 Copilot 只有界面入口，AI 尚未实际接入。

## 下一阶段真正要完成的功能

### A. AI Copilot

需要完成：

- 接入 Hana AI 对话能力
- 读取用户明确选择的当前文件或选中文本上下文
- 总结、解释、提取知识点
- 生成修改建议并安全应用回 Markdown
- 对话历史、错误处理、重试和上下文长度控制

### B. Markdown 扩展批注与审阅

需要完成：

- 选中文本后的批注入口
- 批注、高亮、下划线等标记
- 批注编辑、删除、回复和完成状态
- 标记与原文位置绑定
- 重新打开文件后恢复
- 批注侧栏与原文定位
- 批注写回、撤销和冲突检测
- 保持普通 Markdown 文件兼容

### C. Notebook 增强

基础文本 Notebook 已完成，后续可增加：

- 关联当前文件和选中文本
- 从批注或 AI 回复生成笔记
- Markdown 预览
- 多份笔记、导出和安全写回

## 新会话建议阅读顺序

1. `README.md`
2. `docs/NEXT_SESSION_HANDOFF.md`（本文件）
3. `docs/ROADMAP.md`
4. `COLLABORATION.md`
5. `src/panel.js`
6. `assets/panel.css`
7. `src/markdown-engine.js`
8. `src/markdown-editor.js`
9. `routes/ui.js`
10. 与任务相关的 `tests/`

## 关键实现入口

- `src/panel.js`
  - `state`：全局界面状态
  - `renderCopilot()`：右侧 Copilot / Notebook
  - `saveNotebook()`：Notebook 本地自动保存
  - `renderTreeNode()`：文件树节点和图标
  - `render()`：页面重建与文件树滚动恢复
- `assets/panel.css`
  - `--maple-*`：Maple 色板
  - Markdown 标题层级配色
  - 代码默认深色配色
  - 引用、代码块银河蓝竖线
  - 文件树层级线和分组间距
- `src/markdown-engine.js`
  - Markdown 安全渲染
  - 标题编号 `.heading-number`
  - 后续批注扩展的主要入口
- `routes/ui.js`
  - ResourceIO 读取、写回和版本冲突保护

## 开发纪律

- 先看当前 `git branch --show-current` 和 `git status`。
- 不要把 `knob-motion-lab/` 纳入提交。
- 不要覆盖或破坏当前 Maple 标题色阶：银河蓝 → 清晨蓝 → 溪水蓝 → 冰蓝 → 极浅青蓝。
- 不要恢复海蓝色作为主要标题色。
- 代码块大部分保持深色，仅保留少量语义高亮。
- 引用和代码块左侧竖线保持银河蓝。
- 独立功能使用 `feat/` 分支，修复使用 `fix/` 分支。
- 修改后运行 `npm test`；14 项全部通过后再提交和发布。
- 先实现最小可验收版本，再扩展功能，不要一次性引入重量级编辑器或复杂依赖。
