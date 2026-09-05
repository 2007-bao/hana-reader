# S5 Maple 风格三栏布局

## 目标

S5 将阅读器收束为清爽的三栏工作区：文件树、阅读/编辑区、AI / Notebook 工具区。移除独立顶部工具栏，避免重复占用 Hana 页面高度。

## 布局规则

- 左右栏和中间栏独立滚动，工作区本身不因文件树长度而增高。
- 左右栏可折叠；折叠状态写入本地布局设置。
- 栏间分隔线支持指针拖动调整宽度，宽度写入本地布局设置。
- 三栏统一使用中间栏的近白背景，仅通过清晰但柔和的分界线区分区域。
- 强调色改为更明亮、灵动的 Hana 蓝；h1 / h2 使用蓝色层级，h3-h6 回到正文色，批注使用正文橙色下划线。

## 视觉变量

当前 CSS 以以下变量作为后续换色入口；Markdown 排版和代码 token 已通过这些变量统一控制：

- `--reader-bg`
- `--reader-middle-bg`
- `--reader-side-bg`
- `--reader-card`
- `--reader-soft`
- `--reader-border`
- `--reader-text`
- `--reader-muted`
- `--reader-accent`
- `--reader-accent-soft`
- `--reader-shadow`
- `--maple-galaxy` / `--maple-sea`
- `--maple-red`（正文批注橙色）

## 代码阅读

本阶段不引入新的代码编辑器内核。源码编辑继续使用轻量文本编辑框，保留语法可读性、Tab 缩进、自动保存和回撤；Markdown 编辑继续使用 Milkdown。只读 / 编辑控件采用阅读区悬浮控件，选区批注采用正文下方动态菜单与 hover 气泡。
