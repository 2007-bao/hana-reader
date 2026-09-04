# Hana Reader

一个面向 AI / 多 Agent 产物审阅的 Hana 文件阅读工作台。

> 当前版本：`0.1.9` · M0 只读大版本已验收

## 当前目标

先把「选择文件夹 → 浏览目录 → 打开文件 → 阅读 Markdown / 代码」这条链路做得稳定、轻盈，再逐步加入编辑、Copilot 和可撤销修改建议。

## M0 范围

- 选择一个本地文件夹
- 延迟展开目录树
- 阅读 Markdown 文件的安全预览
- 阅读 JSON、HTML、JavaScript、TypeScript、Python 等文本代码
- 统一的 Hana 主题 iframe 页面
- 单文件 2 MB 阅读上限，避免 M0 阶段大文件拖垮页面
- 记住上次打开的文件夹、文件与阅读滚动位置，启动时尝试恢复

暂不包含：编辑、AI 对话、批注、全文搜索、多标签和 GitHub 远程仓库浏览。

## 开发方式

这是一个可直接被 Hana 加载的无构建依赖插件骨架：

1. 在 Hana 设置 → 插件中开启允许 Agent 插件开发工具与全权插件（开发时需要）。
2. 使用 Hana 的插件 dev loop 安装本目录源码。
3. 修改 `assets/` 或 `routes/` 后 reload。
4. 通过插件诊断面板确认页面加载状态。

也可以把插件文件夹拖入 Hana 设置 → 插件进行本地安装。

页面加载、鉴权与空白页排查记录见 [`docs/PLUGIN_LOADING.md`](docs/PLUGIN_LOADING.md)。

## 目录结构

```text
manifest.json       插件声明与最小权限
routes/ui.js        Page shell 与 ResourceIO 路由
assets/             iframe 页面静态资源
  panel.js          M0 阅读器界面
  panel.css         Hana 风格界面样式
  hana-bridge.js    当前 M0 所需的轻量 SDK 协议适配
tests/               manifest 与结构测试
COLLABORATION.md    GitHub 协作约定
```

## 权限边界

- 用户资源读取通过服务端 `ctx.resources`，不直接使用本地路径读文件。
- 当前只声明 `resource.read`，没有写入用户文件的权限。
- 浏览器页面只通过宿主资源选择能力选择目录，再通过同插件路由请求内容。
- Markdown 原始 HTML 默认按文本展示，避免阅读文档时执行不可信脚本。

## GitHub 工作流

GitHub 仓库公开，但暂不接入 GitHub API。GitHub 只用于保存源码、Issue、分支、Commit 与 PR。

默认流程：`Issue → feat/fix 分支 → 有意义的 Commit → PR → 本地验证 → 合并 main`。

## 后续路线

- M1：所见即所得 Markdown 编辑、保存冲突检测、当前文件 Copilot
- M2：代码编辑与安全预览、AI 修改建议、Diff 预览、接受 / 拒绝 / 撤销、轻量批注
- 后续：全文搜索、跨文件问答、Git 状态等按真实痛点增加
