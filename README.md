# Hana Reader

一个面向 AI / 多 Agent 产物审阅的 Hana 本地优先阅读工作台。

> 当前版本：`v1.5.3` · 插画化三栏阅读、编辑、AI 辅助、Notebook 与正文标记
>
> GitHub：<https://github.com/2007-bao/hana-reader>

## 项目定位

Hana Reader 不是普通 Markdown 编辑器，而是一个“阅读—理解—记录—审阅—修改”的轻量工作台：

- 左侧只负责浏览当前文件夹；
- 中间负责阅读、编辑和安全预览；
- 右侧只保留 AI 辅助与 Notebook；
- 高亮、划线和擦除直接作用于正文，不把阅读内容挪到侧栏。

所有用户文件通过 Hana ResourceIO 访问；正文标记、Notebook、会话位置和 Copilot 历史默认保存在当前浏览器本地。

## v1.5.3 本轮完成：放大空状态与冲浪收起栏

- 初始阅读插画放大约 40%，保留中心留白和蝴蝶点击热点的相对位置。
- 收起栏改用定制 SVG 冲浪浪花：卷起的浪峰、泡沫和飞溅水珠比旧 PNG 更清晰，左右 rail 自动镜像。
- 三朵浪花分布在上、中、下三个高度，略微越过 rail 边界；收起时从外侧错落拍入，静止后保持安静。
- 仍遵守 reduced-motion：关闭位移动效，只保留静态的镜像浪花。

## v1.5.2 本轮完成：透明插画与安静收起栏

- 中间栏旋钮升级为独立于文件内容的持久 dock；切换文件时复用整个控件节点，避免闪烁和卡顿。
- 旋钮左侧对应只读、右侧对应编辑；点击和左右方向键均可操作，并在 reduced-motion 下静态切换。
- 中间空状态改用用户提供的透明抠图，保留原始插画细节，不再强行路径化；AI 空状态也改用透明图片素材。
- 折叠图标继续使用内联 SVG；收起栏删除大面积海浪，只保留每侧 3 个 16–24px 的独立小浪花，静态、错落、不裁切。
- 旋钮缩小约 5%；侧栏折叠和右侧栏拖拽时，旋钮位置跟随工作区平滑移动。
- 选区工具条改为“划线”、字号增大、硬边紧凑矩形；实验源目录仍不参与 Reader 构建。

## v1.2.0 本轮完成

### 工作区与视觉

- 左侧文件树移除搜索、最近打开和多余说明，仅保留选择、刷新、打开目录和折叠。
- 文件夹使用黄色闭合 / 展开图标，Markdown、README、JSON、压缩包、代码和样式文件使用类型图标。
- 中间阅读区随窗口自适应，左右留白统一；只读 / 编辑的 Quiet 原生 SVG 旋钮固定在阅读区右上方。
- 旋钮左侧代表只读、右侧代表编辑；点击或方向键先完成可中断的 SVG 转场，再切换编辑器，避免重绘打断动效。
- 标题只保留 h1 / h2 的 Hana 蓝色层级，h3-h6 回到正文色；代码、引用和分隔线使用统一的明亮 Hana 蓝。
- 右侧切换收束为“AI 辅助”和“笔记本”，不再显示 AI 预设、上下文档位或批注列表。

### 阅读、编辑与回撤

- 支持 Markdown、JSON、HTML、JavaScript、TypeScript、Python 等文本阅读。
- Markdown 使用本地 Milkdown 所见即所得编辑器；其他文本使用源码编辑器。
- 自动保存、版本冲突保护、安全 HTML 预览和 `512 KB` 编辑上限保持不变。
- 编辑态 `Ctrl/Cmd + Z` 使用编辑器原生撤销；只读态按最近时间撤销最近一次正文标记操作或最近一次安全写回。
- 选择文件夹后可通过本地目录入口打开系统文件资源管理器。

### 正文标记

- 选中文本后，在正文下方的悬浮菜单中添加高亮、下划线或擦除已有标记。
- 取消选区后悬浮菜单自动消失；高亮和下划线使用文本锚点保存在本地。

### AI 辅助

- 通过 Hana `model:sample-text` 接入文本模型。
- 默认只提交当前打开的文本文件和当前对话历史，不再要求用户配置上下文选项。
- 支持直接提问、Enter 发送、Shift + Enter 换行、失败重试和按文件保存对话历史；模型不可用时不影响本地阅读与编辑。

### Notebook

- 右侧 Notebook 保持极简：选择、新建、改名、直接编辑；导出会选择已有文本文件并安全覆盖写入，右键笔记本或删除按钮即可删除。
- 多份 Notebook 独立保存在浏览器本地，不改写当前阅读文件。

## 保留的服务端能力

`routes/ui.js` 仍保留受限 `POST /resources/search`，供未来重新接入搜索体验或其他受控工作流；本轮不在左侧提供搜索入口，也不做常驻索引。服务端边界为最多 500 个文件、单文件 1 MB、总读取 8 MB、最多 100 个结果。

## 当前限制与后续方向

- Copilot 依赖 Hana `model.sample` 与可用的 utility 文本模型。
- 正文标记、Notebook、会话位置和 Copilot 历史尚未做跨设备 sidecar 同步。
- Notebook 导出通过 ResourceIO 选择已有文本文件并安全覆盖；当前不负责创建新的 ResourceIO 文件。
- 后续优先考虑 Notebook 导入导出、轻量多标签、长文档分段渲染和死 CSS 清理。
- `knob-motion-lab/` 仍是独立实验源目录；插件只接入复制后的 `assets/native-knob.svg`，不依赖实验目录参与构建。

## 给下一次 AI / 新对话的交接说明

开始工作前按顺序阅读：

1. `README.md`：当前版本、范围和安全边界；
2. `docs/NEXT_SESSION_HANDOFF.md`：本阶段交接与验收；
3. `docs/ROADMAP.md`：已完成与后续路线；
4. `COLLABORATION.md`：分支、提交和资料边界；
5. `src/panel.js`：页面状态、三栏布局、编辑、Copilot、批注和 Notebook；
6. `src/annotation-engine.js`、`src/annotation-store.js`：正文标记与本地批注；
7. `src/notebook-store.js`：Notebook 存储；
8. `assets/panel.css`：视觉与布局；
9. `routes/ui.js`：页面壳、ResourceIO、搜索和 Copilot 路由；
10. `tests/`：结构、渲染、写回和路由回归。

每次修改前确认：

- 当前分支和 `git status`；
- 除非任务明确要求，不修改或打包 `knob-motion-lab/`；旋钮集成只维护插件内的 `assets/native-knob.svg`；
- 修改后运行 `npm test`；
- 未经负责人确认，不 push、建 PR、合并或发布标签。

## 开发与验证

```powershell
npm install
npm test
```

`npm test` 会依次执行版本一致性检查、构建和顺序测试。开发时可在 Hana 设置 → 插件中开启插件开发工具，使用 dev loop 安装本目录并 reload。

## 目录结构

```text
manifest.json       插件声明、页面和宿主能力
package.json        构建、依赖与测试脚本
routes/ui.js        Page shell、ResourceIO 读写/搜索与 Copilot route
src/                可维护的前端源码与渲染内核
assets/             iframe 静态资源和构建产物
  panel.js          构建后的阅读工作台
  panel.css         Hana 蓝视觉与三栏布局
  hana-bridge.js    轻量 SDK 协议适配
  fonts/            Maple Mono 字体
docs/               技术记录、路线和交接文档
tests/              manifest、渲染、编辑器和路由回归
COLLABORATION.md    GitHub 协作约定
```

## 权限与安全边界

- 浏览器不直接读取本地路径，用户资源通过 Hana ResourceIO 访问。
- 读取、写回和版本校验均通过服务端路由完成。
- 写回携带读取时的 `version` 和内容哈希，拒绝过期内容。
- Markdown 原始 HTML 默认按文本处理；HTML 预览使用隔离 sandbox 和净化。
- 不提交 API Key、Cookie、个人文件、会话导出或真实项目内容。

## GitHub 工作流

默认流程：`Issue → feat/fix 分支 → 有意义的 Commit → PR → 本地验证 → 合并 main → 标签与安装包`。

当前本地目标：`feat/reader-visual-simplification` / `v1.5.3`；稳定基线：`main` / `v0.9.0`。本轮只做本地提交，不自动推送或合并。
