# Quiet 动效 v2（待宿主手测）

本阶段落在 `feat/reader-visual-simplification` / v1.8.1，已重新构建测试包，仍待宿主手测，主要修改 `src/panel.js`、`assets/panel.css` 与结构回归测试。

设计目标是让每次 `innerHTML` 重建后的内容变化拥有一层安静、可打断、低幅度的 CSS 入场交接，而不是做页面级翻页或持续性动画。

## 覆盖范围

1. **左侧文件夹展开 / 收起**：子树保留在一个可过渡的容器中，以 `grid-template-rows`、透明度和 5px 以内的位移完成展开与收束；快速反向时清理旧计时器，下一次展开可再次触发。
2. **文件切换**：中间阅读内容只做局部淡入和约 3px 的轻微位移，不做整页横向翻页；编辑器与只读态互切不额外叠加阅读区淡入，避免和旋钮转场重复。
3. **右侧工具切换**：AI 与 Notebook 的内容区局部淡入，顶部切换条保持稳定；Notebook 切换标签时只交接标签行下方的标题与编辑区域。
4. **既有动效保持**：持久 `.workspace` / `.workspace-shell`、Quiet 旋钮 dock、海浪折叠动效与 `prefers-reduced-motion` 语义不变。

## 实现原则

- 使用 CSS `opacity`、`transform` 与 accordion 所需的 `grid-template-rows`，不使用 `transition: all`、`@keyframes`、`scale(0)` 或 `requestAnimationFrame`。
- 使用已有 Quiet 曲线：
  - `--ease-out: cubic-bezier(.23, 1, .32, 1)`
  - `--ease-in-out: cubic-bezier(.77, 0, .175, 1)`
- 入场时长控制在 180–210ms（树 190ms、收起 / 展开 grid 210ms、阅读与正文 180ms、右栏 200ms），位移为低幅度（≤ 7px）。
- 用 `expandedDirsRendered` / `currentPassExpandedDirs` 记录真正新展开的目录；用 `collapsingDirs` 暂时保留正在收起的子树，普通重绘不会重复播放文件树动效。
- 用轻量 fingerprint 判断阅读区、右侧视图和 Notebook 正文是否发生了需要交接的状态变化；阅读区优先使用资源版本 / `baseSha256`，不再只用内容长度。首次 render 只建立 baseline，不播放入场。
- 入场节点直接使用 CSS `@starting-style` 声明起点，避免在 `innerHTML` 重建后再临时添加起始类导致 transition 起点丢失。收起节点保留在 `.tree-nested-shell` 容器内短暂播放 `q-exit-to`（210ms grid 收束），由 `runQuietEntrances()` 只负责提交退出状态；不再使用全局入场 guard。
- reduced-motion 下跳过入场启动，并由 CSS 将起始状态直接恢复为可见、无位移。

## 需要宿主手测

- [ ] 展开 / 收起多级目录：首次展开有轻微淡入，再次展开能重新触发；收起无残留；快速连续操作不闪烁、不堆积。
- [ ] 用键盘 Enter / Space 反复切换同一文件夹：状态及时变化，不出现抖动。
- [ ] 连续打开不同文件：正文局部淡入；来回切换只读 / 编辑时，阅读区不叠加额外淡入。
- [ ] HTML 源码 / 预览切换：只有轻微局部交接，不出现整页移动。
- [ ] AI / Notebook 切换：内容区淡入，顶部切换条稳定不跳。
- [ ] Notebook 多标签切换：仅标题与编辑区交接，标签行稳定；新建、删除、导出等普通重绘不重复播放动效。
- [ ] 系统开启“减少动态效果”：以上状态全部即时切换，无残留位移或透明度异常。
- [ ] 左右 rail 折叠与海浪动效行为与既有视觉基线一致，不受 Quiet v2 影响。
- [ ] Notebook 布局与既有像素级关系可接受；新增 `.notebook-pane-body` 不改变不必要的间距与弹性。

## 验证

已运行：

```powershell
npm test
```

结果：30 个测试全部通过。真实 Hana 宿主中的视觉、快速操作和 reduced-motion 手测仍未完成。
