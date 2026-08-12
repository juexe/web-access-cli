# ADR 0006：AnySearch Provider 协议映射

- 状态：已接受
- 日期：2026-08-12

## 背景

AnySearch 为搜索提供结构化 REST 接口，为提取提供固定的 JSON-RPC `tools/call` 接口。项目需要在保持统一 Search/Extract 契约的同时支持该服务，并继续让核心对 MCP/Agent 生命周期保持中立。

## 决策

新增内置 `anysearch` Provider Type，adapter 使用 `POST /v1/search` 和 `POST /mcp`，所有请求复用统一 `HttpTransport`。Extract 只实现官方 Skill 当前使用的固定 `extract` 工具调用，不引入 MCP SDK、会话初始化、工具发现、SSE/stdio 或通用 MCP 集成。

AnySearch 不加入默认 Route。Search 的 `searchFilterMode` 为 instance 专属配置：`strict` 遇到 freshness 时返回可回退的 `provider_unavailable`；`best_effort` 将日期和域名条件改写为查询，并在本地再次严格过滤。匿名调用允许存在 base URL 即可。

## 结果

Provider 协议差异被限制在 adapter 内，公共 request/data/envelope 和 schemaVersion 不变。响应中的自动注册信息不被保存或暴露，raw 序列化会递归脱敏凭据、token 和配置中的 API key。
