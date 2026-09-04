# S3 安全写回设计

## 支持范围

S3 对 Markdown、Python、JSON、HTML、CSS、JavaScript、TypeScript、YAML、XML、Shell 等文本文件使用统一源码编辑器；Markdown 保留 Milkdown 所见即所得编辑器，其他文本使用源码编辑器。

## 写回协议

1. `/resources/read` 返回 `resource` 与 `version`，前端将其作为编辑基线。
2. `/resources/write` 必须同时接收 `resource`、完整 `content` 与 `expectedVersion`。
3. 服务端调用 `ctx.resources.writeExpectedVersion`，版本不一致时返回 `409`，并附带最新远端文本与版本。
4. 客户端先展示本地与远端 Diff，不自动覆盖远端内容。

## 撤销

成功写回后，内存中保留写回前的完整文本与新版本。撤销操作再次走同一个版本保护写回接口；若远端再次变化，撤销也会被拒绝，不会强制覆盖。

## 安全边界

- `resource.write` 是 S3 新增的最小权限；仍不允许浏览器直接访问本地路径。
- 单次写回不超过 2 MB；Markdown 超过 512 KB 不进入编辑态。
- 写回前必须查看 Diff 并显式确认。
- 冲突时只能载入远端版本或退出，不能静默合并。
- 文件类型不决定写回权限，统一按文本内容处理；二进制文件不提供编辑入口。
