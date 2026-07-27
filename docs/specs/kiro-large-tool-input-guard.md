# Kiro Opus 5 大型工具输入守卫

## 背景

Kiro 路由下的 `claude-opus-5` 在单次生成大型 `Write` 工具参数时，可能在 JSON 尚未闭合前停止发送响应字节。客户端无法恢复从未收到的文件内容，因此不得补造或执行残缺工具参数。

真实对照验证表明，将大型文件创建拆为小型 `Write` 和多个顺序 `Edit`，并将每次工具调用的完整序列化 JSON 输入限制在 3000 字符以内，可以完成同类任务。

## 触发条件

仅当以下条件同时满足时注入可靠性约束：

- Kiro 实际模型 ID 为 `claude-opus-5`；
- 当前请求同时提供名为 `Write` 和 `Edit` 的工具。

其他模型或工具集合不得改变现有行为。

## 行为要求

触发后，在发送给 CodeWhisperer 的合成 system turn 中追加固定约束：

- 以 `IMPORTANT`、`MUST`、`NEVER` 强制措辞声明约束，并说明超限输入可能被截断而失败；
- 每个 `Write` 或 `Edit` 调用的完整序列化 JSON 输入不得超过 3000 字符；
- 为路径、字段名和 JSON 转义预留余量，`content` 或 `new_string` 字段不得超过 1800 字符；
- 创建大型文件时，必须先使用小型 `Write` 建立初始文件；
- 再使用多个顺序 `Edit` 补齐文件；
- 不得将大型文件内容放入单个 `Write` 调用；
- 保留原 system、项目 `AGENTS.md` 和当前用户消息；
- 同一约束已存在时不得重复注入；
- 仅在发送给 Kiro 的工具 Schema 副本中设置 `Write.content.maxLength = 1800`、`Edit.new_string.maxLength = 1800`、`Edit.old_string.maxLength = 800`；
- 不修改 Anthropic 请求对象、全局 `Write/Edit` Schema 或本地工具校验行为。

## 安全边界

- 保留 Kiro 响应流 60 秒空闲超时；
- 保留仅含 chunk 元数据的安全诊断；
- 工具 JSON 在超时时仍不完整，必须明确失败；
- 不猜测、拼接或恢复上游未发送的内容；
- 不自动重试可能已经产生本地副作用的工具调用。

## 验收

- 请求转换测试覆盖触发、非触发、内容保留和去重行为；
- `kiro-fetch-adapter` 定向测试全部通过；
- Node 产物使用普通用户提示调用 Kiro `claude-opus-5`，成功生成至少 12KB 的单文件 HTML；
- 工具轨迹为小型 `Write` 加多个小型 `Edit`，且无空闲超时、残缺工具 JSON 或长时间挂起。
