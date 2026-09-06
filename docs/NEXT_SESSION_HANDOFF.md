# 下一次会话交接

## 当前状态

- 项目：Hana Reader
- 仓库：<https://github.com/2007-bao/hana-reader>
- 当前本地分支：`feat/reader-visual-simplification`
- 当前版本：`v1.7.0`
- 稳定基线：`main` / `v0.9.0`
- 当前目标：完成只读批注工具、右栏胶囊化、海浪触发收束与稳定阅读 dock 的宿主内手测和本地发布包验收
- `knob-motion-lab/` 是独立的旋钮实验源目录；当前插件只维护复制后的 `assets/native-knob.svg`，不把实验目录纳入构建

## 本阶段已经完成

### 工作区与文件树

- 左侧只保留选择文件夹、刷新、打开当前目录和折叠；前端搜索与最近打开入口已移除。
- 文件夹使用黄色闭合 / 展开图标，README、Markdown、JSON、压缩包、代码和样式文件有类型图标。
- 中间栏自适应宽度，阅读区左右留白统一，Quiet 原生 SVG 读写旋钮固定在右上方。
- 旋钮左侧为只读、右侧为编辑；点击 / 方向键先运行可中断转场，再切换底层阅读器状态。
- h1 / h2 使用 Hana 蓝，h3-h6 使用正文色；代码与引用竖线使用统一蓝色。
- 右侧仅有 AI 辅助和 Notebook 两个视图。
- v1.5.2 中间空状态改用用户提供的透明抠图 PNG，AI 空状态使用透明图片素材；不再对大幅插画强行路径化。
- v1.5.3 初始阅读插画放大约 40%；收起栏换为定制 SVG 冲浪浪花，三朵分布在上、中、下位置并略微越界。
- v1.5.4 左右折叠 rail 从 38px 加宽到 64px，展开按钮、浪花落点、窄屏规则和旋钮 dock 联动同步调整。
- v1.6.0 使用用户提供的透明海浪图，裁成紧凑纵向 PNG；同一素材左右镜像，作为越过 rail 的完整高度装饰层。
- v1.6.0 只读模式左右 padding 增加约三分之一，编辑模式保持原有密度；海浪折叠时从外侧以 280ms 强缓出涌入，reduced-motion 下静态显示。
- v1.6.1 折叠 rail 从 64px 调整为 96px；左侧展开图标回到未折叠标题栏高度并靠近中间边缘，折叠态移除 rail 与 resizer 竖线。
- v1.7.0 两侧折叠图标再向中间边缘移动约 5px。
- v1.6.1 只读模式左右 padding 再增加约三分之一，编辑模式与窄屏布局不变。
- v1.7.0 海浪动效只由对应侧栏的折叠动作触发；只读选择改为蓝紫色，工具栏改为三个 SVG 图标。
- v1.7.0 擦除按选区切片保留未选中的标记，右侧 AI / Notebook 控件统一为轻胶囊框。
- 折叠按钮继续使用内联 SVG，海浪静止后不持续漂浮，展开入口固定在顶部。
- `.workspace-shell` / `.workspace-body` 让旋钮与 grid 壳层持久存在；侧栏折叠使用 280ms grid transition，旋钮 dock 同步过渡 `right`，拖拽时实时跟随。
- 当前项目接受图片型插画与 SVG UI 图形并存：大幅插画优先保留原图细节，小型 UI 几何图形才优先使用 SVG。

### 阅读与编辑

- Markdown 安全渲染、GFM、任务列表、代码高亮和安全 HTML 预览。
- Milkdown Markdown 所见即所得编辑器；其他文本使用源码编辑器。
- 自动保存、版本冲突保护、放弃草稿和最近一次写回撤销保持。
- 编辑态 Ctrl/Cmd-Z 保留原生编辑器撤销；只读态按最近时间撤销批注或最近一次安全写回。
- 当前目录可通过 `hana.resources.open({ resource, mode: 'reveal' })` 交给宿主打开本地文件资源管理器。

### 正文批注

- 选区下方动态悬浮菜单只提供批注、高亮、划线。
- 批注直接显示为正文橙色波浪下划线，悬浮显示气泡；不再有右侧批注面板。工具栏文案使用“划线”。
- 文本锚点与本地存储仍保留，批注不写入普通 Markdown。

### AI 与 Notebook

- AI 默认提交当前文件和对话历史；不再显示预设、上下文长度和显式选区上下文选项。
- Notebook 只提供选择、新建、改名、直接编辑和 Markdown 导出。
- 批注、Notebook、会话位置和 Copilot 历史默认保存在本地浏览器。

### 服务端保留能力

- `POST /resources/search` 仍保留受限扫描 route，但当前前端不提供搜索入口。
- `routes/ui.js` 继续负责 ResourceIO 读、写、冲突校验和 Copilot route。

## 当前明确限制

1. Copilot 依赖 Hana 宿主的 `model.sample` / `model:sample-text` 与可用 utility 文本模型。
2. `resource.open` 的最终平台行为由宿主决定，本插件只请求 `mode: reveal`。
3. 批注、Notebook、会话位置和 Copilot 历史尚未做跨设备 sidecar 同步。
4. Notebook 导出通过 ResourceIO 选择已有文本文件并安全覆盖；当前不负责创建新的 ResourceIO 文件。
5. 长文档仍采用一次性渲染；引入虚拟化前必须先保护选区、批注锚点和编辑器生命周期。
6. 实际 Hana UI reload / 模型返回形状仍需在可用 dev loop 环境中手测。

## 下一步建议

1. 先运行 `npm test`，确认版本检查、构建和顺序测试全部通过。
2. 查看 `git diff --stat` 与 `git status --short -- . ':(exclude)knob-motion-lab'`，确认变更范围。
3. 只在本地创建有意义的 commit；未经负责人确认不要 push、建 PR、合并或发布标签。
4. 当前旋钮集成仍是未单独发布的实验功能；若继续调整，优先只改 `src/panel.js`、`assets/panel.css` 和 `assets/native-knob.svg`。
5. 后续再考虑批注 / Notebook 导入导出、轻量阅读历史和长文档性能。
6. 清理死 CSS 前先生成选择器使用清单；不要直接删除可能被后续 UI 复用的规则。
7. 宿主 dev loop 恢复后手测：打开 Markdown → 旋钮切换只读 / 编辑 → 选区批注 / 悬浮气泡 → Ctrl-Z；编辑 → 自动保存 → Ctrl-Z；AI 提问；Notebook 编辑 / 导出；打开本地目录。

## 关键实现入口

- `src/panel.js`：页面状态、三栏布局、文件树、编辑器、Copilot、正文批注、Notebook 和快捷键。
- `src/annotation-engine.js`：文本选区锚点、DOM 标记与批注类型。
- `src/annotation-store.js`：本地批注存储与稳定资源键。
- `src/notebook-store.js`：Notebook 存储、迁移和导出数据。
- `assets/panel.css`：Hana 蓝视觉、文件树、Quiet 旋钮、批注气泡和右栏样式。
- `assets/native-knob.svg`：Quiet 原生读写旋钮的独立资产。
- `routes/ui.js`：页面壳、ResourceIO 读写 / 搜索和 Copilot route。
- `tests/`：manifest、渲染、编辑器、写回、路由和结构回归。

## 开发纪律

- 开始前确认 `git branch --show-current` 和 `git status`。
- 除非任务明确要求，不修改或打包 `knob-motion-lab/`；插件侧使用 `assets/native-knob.svg`。
- 修改后必须运行 `npm test`，不要只运行 build。
- 不提交 API Key、Cookie、个人文件、会话导出或真实项目内容。
