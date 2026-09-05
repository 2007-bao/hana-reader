# 下一次会话交接

## 当前状态

- 项目：Hana Reader
- 仓库：<https://github.com/2007-bao/hana-reader>
- 当前本地分支：`feat/offline-search-and-polish`
- 版本目标：`v1.1.0`
- 稳定基线：`main` / `v0.9.0`
- 当前验证：`npm test`（构建 + 28 项顺序测试）
- 工作区无关目录：`knob-motion-lab/`，不要查看、修改、提交或打包

## 本阶段已经完成

### 阅读与编辑

- 左侧项目文件树、延迟展开、常见文本/代码阅读
- Markdown 安全渲染、GFM、任务列表、代码高亮
- Milkdown Markdown 所见即所得编辑器
- 多类型文本安全写回、版本冲突检测、撤销和安全 HTML 预览
- 自动保存失败可见，并可重试或放弃草稿
- Maple Mono、Maple 蓝色语义色板、三栏布局、文件树图标/层级线/滚动保持

### Copilot

- `routes/ui.js` 的 `POST /copilot/ask` 通过 `model:sample-text` 接入 Hana utility 模型
- 前端只提交用户勾选的当前文件或选区
- 总结 / 解释 / 知识点 / 审阅快捷任务
- 文件级对话历史、失败重试、上下文 8k/16k/24k 档位和服务端截断
- Markdown 修改建议需代码块、原文精确匹配和确认后才进入编辑器/安全自动保存

### Markdown 批注审阅

- 选区批注、高亮、下划线
- 批注编辑、回复、完成、删除、状态/类型筛选、批量完成、最近一次操作撤销
- 侧栏列表、定位原文、文本锚点恢复
- 使用浏览器本地存储，不改写普通 Markdown 原文

### Notebook

- 多份本地 Notebook、标题编辑、切换、新建、删除
- 当前文件/选区引用
- 从批注或 Copilot 回复加入笔记
- Markdown 预览、下载导出和带版本哈希的安全写回

### 离线搜索与工作区维护

- `POST /resources/search` 递归扫描当前选定文件夹的文本资源
- 支持大小写选项、相对路径、行号/列号、预览片段和结果高亮
- 搜索结果打开文件并定位代码行或 Markdown 近似位置
- 服务端固定边界：500 文件 / 单文件 1 MB / 总读取 8 MB / 100 结果
- 二进制、过大或不可读文件被跳过，不阻塞整次搜索
- 最近打开文件按根资源 + 相对路径保存在本机，并可一键清除记录
- `Ctrl/Cmd + Shift + F` 搜索、`Escape` 关闭/取消、`Ctrl/Cmd + S` 保存
- 文件树、工具切换和搜索结果补充基础无障碍语义与焦点样式

## 当前明确限制

1. Copilot 依赖 Hana 宿主的 `model.sample` 能力和已配置的 utility 文本模型；不可用时应给出降级提示。
2. Copilot 自动应用只处理能在当前 Markdown 原文中精确找到的纯文本选区；含复杂渲染格式的选区会拒绝自动覆盖。
3. 批注、Notebook、最近文件和 Copilot 历史存于当前浏览器本地，尚未做跨设备 sidecar 同步。
4. Notebook “写回文件”目前选择已有资源并执行安全覆盖，不负责创建新文件。
5. 全文搜索是用户主动触发的受限扫描，不做常驻项目索引；当前搜索结果最多 100 条。
6. 实际 Hana UI reload 仍受 dev loop 工作区路径权限限制，尚未完成宿主侧视觉和模型返回形状冒烟。

## 下一步建议

- 先运行 `npm test`，确认构建产物和测试数量没有回退。
- 若继续离线开发，优先做搜索文件名过滤/排序、最近文件分组、批注导入导出和 Notebook 本地数据导入导出。
- 清理死 CSS 前先建立选择器使用清单，不要直接删除历史规则。
- 长文档虚拟化前准备 Markdown/代码基准文件和 Chromium 性能测试，避免为了性能破坏选区和批注定位。
- 宿主 dev loop 恢复可用后，手测：打开 Markdown → 选区批注/恢复；全文搜索 → 结果定位；Copilot 上下文 → 失败重试 → 建议应用；Notebook 引用/预览/导出/写回。
- 如果宿主模型返回结构不同，只修改 `routes/ui.js` 的 `extractModelText()` 兼容层，不要把 API Key 或宿主路径放进前端。
- 通过测试后检查 `git diff --stat` 和 `git ls-tree -r --name-only HEAD`，确认没有 `knob-motion-lab/`。
- 未获负责人明确授权前，不要 push、建 PR、合并或发布 GitHub 标签。

## 关键实现入口

- `src/panel.js`：页面状态、搜索、最近文件、文件树、编辑器、Copilot、批注、Notebook 和事件绑定
- `src/annotation-engine.js`：文本选区锚点、恢复定位和 DOM 标记
- `src/annotation-store.js`：本地批注存储与稳定资源键
- `src/notebook-store.js`：多份 Notebook 存储、迁移和引用拼接
- `assets/panel.css`：Maple 视觉、搜索、Copilot/批注/Notebook 交互样式
- `routes/ui.js`：页面壳、ResourceIO 搜索/读写与 Copilot route
- `tests/`：manifest、渲染、编辑器、写回、搜索、Copilot 和本地状态回归

## 开发纪律

- 先确认 `git branch --show-current` 和 `git status`。
- 不要纳入 `knob-motion-lab/`。
- 修改后运行 `npm test`，不要只运行 build。
- 不要破坏标题色阶：银河蓝 → 清晨蓝 → 溪水蓝 → 冰蓝 → 极浅青蓝。
- 不提交 API Key、Cookie、个人文件、会话导出或真实项目内容。
