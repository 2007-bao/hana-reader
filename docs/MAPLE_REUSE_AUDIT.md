# Maple 复用审计

> 目的：在继续调整 hana-reader 视觉系统前，先明确 Maple 上游资源、许可证和最小适配边界。原则是优先复用上游实现，避免重新手搓一套相似 CSS。

## 上游来源

### Maple Mono

- 仓库：https://github.com/subframe7536/maple-font
- 用途：代码、文件名、界面标签等需要等宽字形的内容
- 许可证：SIL Open Font License 1.1（上游 `OFL.txt`）
- 关键特征：圆角字形、连字、较好的符号对齐、可配置 OpenType 特性
- 复用要求：分发字体文件时一并保留 OFL 文本和作者信息；不把字体重新命名成暗示原作者背书的名称；确认具体发行包的字体文件和许可证版本后再纳入插件安装包。

### Obsidian Maple

- 仓库：https://github.com/subframe7536/obsidian-theme-maple
- 用途：主题变量、编辑器排版、代码块、文件树、组件状态和交互细节的参考/可复用来源
- 许可证：MIT（上游 `LICENSE`，Copyright (c) 2022 subframe7536）
- 关键目录：
  - `theme.css`：主题总入口和变量/组件实现
  - `resource/font`：主题内置字体资源
  - `resource/svg`：图标和装饰资源
  - `src/custom-functions.ts`：资源自动加载方式
  - `src/style-settings/`：可配置项来源
- 复用要求：复制实质性 CSS、SVG 或代码时保留 MIT 版权和许可证；不要只凭截图重写同等实现。

### VS Code Maple Theme

- 仓库：https://github.com/subframe7536/vscode-theme-maple
- 用途：代码语法 token 的颜色来源
- 复用原则：优先采用其 token 语义和颜色映射，再映射到 highlight.js 的 class；不自行创造一套与 Maple 无关的 token 颜色。

## 已确认的设计事实

Maple 不是一组背景色，而是一套内容呈现系统，至少包括：

1. **字体层**：正文、界面、代码分别有明确职责；Maple Mono 不是 CSS fallback 字符串，而是实际可分发的字体资源。
2. **颜色层**：基础背景、容器背景、强调色、激活态、代码 token、引用、链接、警告等是语义化关系，不是每个选择器单独填色。
3. **排版层**：标题层级、正文行高、段落间距、代码密度、中文/拉丁字符混排需要一起校准。
4. **内容层**：Markdown、代码、文件树、表格、引用和任务列表都有自己的视觉规则。
5. **交互层**：悬停、激活、滚动条、折叠、标签切换和组件动画共同构成体验。
6. **可配置层**：上游通过变量和 Style Settings 组织可调参数，hana-reader 应保留变量入口，而不是散落硬编码。

## hana-reader 的复用策略

### 第一优先级：直接带入

- Maple Mono 的正式 Web 字体文件和 OFL 文本
- Maple 的基础颜色/语义变量命名与组织方式
- Maple/VS Code Maple 的代码 token 颜色映射
- 能直接适配现有 DOM 的 Markdown/代码块细节

### 第二优先级：建立很薄的适配层

只处理以下差异：

- Obsidian 选择器改成 hana-reader 当前 DOM 选择器
- 上游资源路径改成本地插件资源路径
- 主题变量改接 Hana 的 light/dark 变量
- 上游组件状态改接现有折叠、选中文件和编辑状态
- highlight.js 的 class 映射到 Maple token 语义

### 明确不做

- 不重新手写一套“看起来像 Maple”的配色
- 不重新制作 Maple Mono 字体
- 不复制整份主题后再大面积改名、改色
- 不为了短期视觉效果破坏上游变量关系
- 不在没有上游依据时自行增加复杂动效和装饰

## 当前版本的问题

`assets/panel.css` 目前只有字体名 fallback 和少量手写颜色变量，尚未真正分发 Maple Mono，也没有完整接入 Maple 的编辑器排版和代码 token 体系。因此当前 `v0.6.1` 只能视为布局与配色修正版，不能称为 Maple 视觉复用完成版。

## 下一阶段顺序

1. 锁定 Maple Mono 的发行包版本，检查字体文件、体积、Web 字体格式和 OFL 文本。
2. 从上游主题中提取可直接复用的变量与 Markdown/代码相关规则，记录来源路径。
3. 从 VS Code Maple theme 确认 token 语义到 highlight.js class 的映射。
4. 设计最小适配层，先替换资源与变量，再调整 hana-reader DOM 选择器。
5. 用 Markdown、JSON、JS、CSS、HTML、中文混排样例做视觉回归，而不是只跑结构测试。
6. 在保留上游版权说明的前提下发布安装包。

## 当前结论

在完成上述审计前，不再继续扩大 `assets/panel.css` 的手写规则。下一次视觉改动必须能回答两个问题：

- 这条规则来自哪个上游文件或设计语义？
- 如果不是直接复用，为什么只需要这一层适配？
