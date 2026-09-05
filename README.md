# Hana Reader

一个面向 AI / 多 Agent 产物审阅的 Hana 文件阅读工作台。

> 当前版本：`v1.0.0` · 阅读、Copilot、批注与 Notebook 工作台
>
> GitHub：<https://github.com/2007-bao/hana-reader>

## 项目定位

Hana Reader 的目标不是普通 Markdown 编辑器，而是一个“阅读—理解—记录—审阅—修改”的人机协作工作台：

- 左侧浏览项目文件
- 中间阅读、编辑和预览文本
- 右侧接入 AI Copilot 或记录个人 Notebook
- 选中文本批注、高亮、下划线和审阅状态

## 当前已完成

### 阅读与编辑

- 选择本地文件夹并延迟展开目录树
- 阅读 Markdown、JSON、HTML、JavaScript、TypeScript、Python 等文本文件
- Markdown 安全渲染、GFM 表格、任务列表和链接
- 本地 Milkdown Markdown 编辑器
- 多类型文本安全写回
- 版本冲突检测、Diff 预览和撤销
- 安全 HTML 预览
- 单文件 2 MB 读取上限、编辑内容 512 KB 上限

### Maple 视觉与布局

- Maple Mono Regular / Italic 字体
- Maple 蓝色语义色板
- 标题层级色阶：银河蓝 → 清晨蓝 → 溪水蓝 → 冰蓝 → 极浅青蓝
- 代码内容以深色为主，仅保留少量语义高亮
- 引用和代码块左侧竖线使用银河蓝
- 三栏布局，左右栏可折叠、拖动调整宽度
- 文件树使用文件/文件夹及文件类型图标
- 文件夹使用浅色层级竖线表达父子关系，不使用展开箭头
- 左侧文件树内部紧凑，不同文件夹之间适度分组
- 文件树和阅读区滚动位置保持

### Copilot

- 通过 Hana `model:sample-text` 接入实际文本模型
- 仅发送用户明确勾选的当前文件或选中文本
- 支持总结、解释、知识点提取和 Markdown 审阅快捷任务
- 按文件保存对话历史，支持失败重试和上下文长度控制
- 修改建议必须经过原文匹配、预览确认后才应用回 Markdown

### Markdown 批注与审阅

- 选中文本后添加批注、高亮或下划线
- 批注支持回复、编辑、删除、完成/重新打开和最近一次操作撤销
- 批注侧栏支持定位原文，并使用文本锚点在重新打开后恢复
- 批注存于本机浏览器，不向普通 Markdown 注入私有语法

### Notebook

- 多份 Notebook、标题编辑、切换、新建和删除
- 引用当前文件或选中文本
- 从批注或 Copilot 回复一键生成笔记
- Markdown 预览、下载导出和带版本校验的安全写回
- 内容独立于当前文件，使用浏览器本地存储自动保存

## 当前剩余候选能力

核心工作台已经完成。后续候选能力包括全文搜索、跨文件问答、Git 状态、多标签、sidecar 协作同步和更完整的审阅合并工作流。
完整清单与明确限制见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 给下一次 AI / 新对话的交接说明

新对话开始后，先按以下顺序阅读，不要直接猜测项目状态：

1. 本文件 `README.md`：项目定位、当前版本和交接信息
2. [`docs/NEXT_SESSION_HANDOFF.md`](docs/NEXT_SESSION_HANDOFF.md)：当前阶段、边界、任务入口和验收要求
3. [`docs/ROADMAP.md`](docs/ROADMAP.md)：后续功能清单
4. [`COLLABORATION.md`](COLLABORATION.md)：分支、提交、PR 和资料边界
5. `src/panel.js`：页面状态、Copilot、批注、Notebook、三栏布局和文件树
6. `src/annotation-engine.js`、`src/annotation-store.js`：批注定位与本地持久化
7. `src/notebook-store.js`：多份 Notebook、迁移和引用
8. `assets/panel.css`：Maple 视觉与三类右侧工作流样式
9. `src/markdown-engine.js`：Markdown 渲染、标题编号和安全扩展入口
10. `src/markdown-editor.js`：Markdown 编辑器
11. `routes/ui.js`：页面壳、ResourceIO 和 Copilot route
12. `tests/`：当前回归测试和验证方式

下一位 AI 处理代码前，应先确认：

- 当前分支和 `git status`
- 不要纳入无关目录 `knob-motion-lab/`
- 先阅读相关源文件和测试，再修改
- 修改后运行 `npm test`
- 通过测试后再提交、推送和发布

## 开发与验证

```powershell
npm install
npm test
```

开发时：

1. 在 Hana 设置 → 插件中开启插件开发工具权限。
2. 使用插件 dev loop 安装本目录源码。
3. 修改 `src/`、`assets/` 或 `routes/` 后运行 `npm run build`。
4. reload 插件并通过诊断面板确认页面状态。

也可以把插件文件夹拖入 Hana 设置 → 插件进行本地安装。

## 目录结构

```text
manifest.json       插件声明与权限
package.json        构建、依赖与测试脚本
routes/ui.js        Page shell、ResourceIO 读取与安全写回路由
src/                可维护的前端源代码与渲染内核
assets/             iframe 页面静态资源和构建产物
  panel.js          构建后的阅读工作台界面
  panel.css         Maple 视觉与布局样式
  hana-bridge.js    轻量 SDK 协议适配
  fonts/            Maple Mono 字体
docs/               技术记录、视觉测试与路线文档
tests/              manifest、渲染、编辑器和写回测试
COLLABORATION.md    GitHub 协作约定
```

## 权限与安全边界

- 浏览器不直接读取本地路径，用户资源通过服务端 `ctx.resources` 访问。
- 读取、写回和版本校验均通过 ResourceIO 路由。
- 写回必须携带读取时的 `version` 和内容哈希，拒绝过期内容。
- Markdown 原始 HTML 默认按文本处理，HTML 预览使用隔离 sandbox 和净化。
- 不提交 API Key、Cookie、个人文件、会话导出或真实项目内容。

## GitHub 工作流

默认流程：`Issue → feat/fix 分支 → 有意义的 Commit → PR → 本地验证 → 合并 main → 标签与安装包`。

当前稳定基线：`main` / `v0.9.0`；本地完成目标：`feat/complete-reader-workbench` / `v1.0.0`。

上一阶段已完成 PR：

- PR #30：Maple 文件树图标、层级线、滚动保持和蓝色视觉体系

后续候选功能和边界以 `docs/ROADMAP.md` 为准。`knob-motion-lab/` 是其他对话的旋钮实验目录，不属于本插件。
