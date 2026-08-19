# ADR 0010：Auto Route 对非 2xx HTTP 响应回退

- 状态：已接受
- 日期：2026-08-19

## 背景

原有 Router 把 Route 回退资格完全等同于错误的 `retryable` 字段。Provider 返回 401、403 或普通 4xx 时，这些错误不适合重试同一 Instance，但 Route 中的其他 Instance 仍可能成功。用一个字段同时表示“重试同一 Provider”和“切换 Provider”会丢失这个区别。

## 决策

`--provider auto` 在错误可恢复，或错误携带的最终 HTTP status 不在 200–299 之间时，继续尝试 Route 中的下一 Instance。非 2xx 错误保留原始 `code`、`httpStatus` 和 `retryable`；例如 401 仍为不可重试同一 Provider 的 `auth_error`。

显式 Instance 仍只执行一次。正常重定向继续由 Transport 处理；HTTP 2xx 内的业务或协议错误继续使用各 Adapter 现有的 `retryable` 分类。`auto` 尝试完所有 Instance 仍失败时，顶层返回 `provider_exhausted`，原始错误保留在 `attempts` 和 `details.lastError` 中。

## 结果

Route 可以在某个 Provider 的凭据、请求或服务状态失败时继续提供能力，且 `retryable` 仍准确描述原始错误。代价是后续 Provider 可能带来额外延迟或费用，调用者可从有序 `attempts` 完整审计路径。本决策不新增配置、公共字段或 Schema 版本。
