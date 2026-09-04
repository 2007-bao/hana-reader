# Hana 插件页面加载说明

本文记录 Hana Reader 在 HanaAgent 中从「插件已识别」到「页面正常显示」的关键链路，避免后续开发再次遇到无提示空白或持续加载。

## 1. 页面加载链路

一个 Page 型插件至少经过以下步骤：

1. Hana 读取插件目录中的 `manifest.json`。
2. `contributes.page.route` 指向插件的服务端 route，例如 `/page`。
3. Hana 请求 `/api/plugins/<pluginId>/page`，得到 iframe HTML 壳。
4. HTML 壳加载 `assets/` 下的 CSS 和 JavaScript。
5. iframe 前端发送 `hana.plugin.ui` v1 的 `hana.ready` 事件。
6. Hana 将 iframe 从加载态切换为可见态。

因此，插件日志中出现 `loaded ... page`，只能证明第 1～3 步成功，不能证明前端资源已经执行。

## 2. 最关键的鉴权兼容点

本地 HanaAgent 连接会在插件页面 URL 中携带 `token`。页面壳生成静态资源地址时，必须把这个参数传递给 `panel.js` 和 `panel.css`；同时要附带随版本变化的资源修订号，避免已打开的 iframe 或浏览器继续使用旧 JS/CSS：

```js
const token = c.req.query('token') || '';
const params = new URLSearchParams({ v: ASSET_REVISION });
if (token) params.set('token', token);
const withAssetQuery = (url) => `${url}?${params.toString()}`;

const panelCss = withAssetQuery(`${assetBase}/panel.css`);
const panelJs = withAssetQuery(`${assetBase}/panel.js`);
```

否则可能出现：

- `/page` HTML 壳正常返回；
- `assets/panel.js` 无法通过本地鉴权；
- iframe 只显示初始加载提示，或被误认为空白页。

这是 Hana Reader v0.1.2 修复的主要问题。参考插件 `session-insight` 也采用了相同的资源 URL 处理方式。v0.1.11 进一步加入资源修订号，避免版本更新后复用旧缓存。

## 3. 前端握手约定

`panel.js` 应在界面完成首轮渲染后发送：

```js
render();
hana.ready();
```

通信桥使用：

```text
protocol: hana.plugin.ui
version: 1
type: hana.ready
kind: event
```

不要只依赖页面是否返回 HTML；Hana 主界面会等待 iframe 的 ready 握手，并可能在握手前将 iframe 隐藏。

## 4. 推荐的页面壳防护

页面壳应提供：

- 初始加载提示；
- `window.error` 兜底；
- `unhandledrejection` 兜底；
- `<div id="root" data-surface="page">`；
- CSS 和 JS URL 使用 `escapeAttr()`。

这样资源或前端发生异常时，用户能看到错误，而不是只能看到空白。

## 5. 排查顺序

遇到页面空白或一直加载时，按以下顺序排查：

1. 设置 → 插件 → 诊断：确认插件是 `loaded`，且没有 `formatIssue` 或加载错误。
2. Hana 日志：确认 `routes` 和 `page` 都加载成功。
3. 检查安装目录：确认 `manifest.json`、`routes/`、`assets/panel.js` 和 `assets/panel.css` 都在插件根目录下。
4. 检查 `/page` route 生成的资源 URL：本地连接不能丢失 `token`。
5. 检查 `panel.js` 是否发送 `hana.ready`，且发送时机在渲染之后。
6. 检查资源加载失败是否有可见错误提示。
7. 重新安装时提升插件版本，避免旧资源或旧安装记录造成混淆。
8. 更新插件后关闭并重新打开阅界页面，确认页面顶部显示当前运行版本；不要只依赖插件管理器显示的版本号。

## 6. 资源与权限边界

- Page UI 使用 `full-access`，但具体权限仍应按需声明。
- 用户文件读取统一走服务端 `ctx.resources` / ResourceIO。
- `assets/` 只放公开静态资源，不放 API Key、Cookie、用户文件或运行时私有数据。
- M0 只声明 `resource.read`，不具备写回用户文件的能力。

## 7. 版本记录

- `v0.1.0`：初始 M0 页面与 ResourceIO 阅读链路。
- `v0.1.1`：内联通信桥、渲染后握手、前端错误兜底。
- `v0.1.2`：静态资源 URL 继承本地 Hana `token`，解决页面持续加载问题。
- `v0.1.11`：静态资源 URL 增加版本修订号，并显示前端运行版本，避免旧 iframe / 缓存掩盖更新。
- `v0.2.0`：前端改为本地构建产物，源码与运行时资源分离；发布前必须重新运行 `npm run build`。
- `v0.3.0`：加入本地 Milkdown 所见即所得编辑预览；当前仍不声明写入能力，编辑内容不会写回文件。
