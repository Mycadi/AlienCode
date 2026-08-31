# Codex 上下文压缩的 Node 内存约束

## 背景

使用 Node 运行 `acode.mjs` 且激活 `ANTHROPIC_API_KIND=codex` 的 apikey profile 时，上下文压缩会携带完整会话。压缩 cache-prefix fork 与 Codex Responses 请求转换叠加后，可能同时保留多份大型消息对象和 JSON 字符串，导致 V8 `Reached heap limit` 并直接终止进程。

## 行为要求

- 仅当运行时存在激活的 apikey profile，且 `ANTHROPIC_API_KIND` 严格等于 `codex` 时，禁用压缩 cache-prefix fork。
- Codex 压缩继续使用既有 streaming compact 路径，不改变摘要内容、重试和错误处理。
- 非 Codex profile、无激活 profile及 feature flag 已关闭时，保持既有 cache-prefix 行为。
- Codex adapter 应在同步转换边界内完成 Anthropic JSON 的解析、Responses input 转换和最终序列化。
- 发起异步网络请求时只传递最终序列化字符串，避免在网络等待期间继续持有中间 Anthropic/Codex 请求对象。
- 不改变 Codex endpoint、认证、模型透传、工具转换和响应流转换行为。

## 验收

- 测试覆盖 Codex profile 禁用 fork，以及非 Codex 路径保持 feature flag 行为。
- 测试覆盖 Codex 请求同步转换边界、模型透传和消息格式转换。
- `compact.test.ts` 与 `codex-fetch-adapter.test.ts` 定向测试通过。
