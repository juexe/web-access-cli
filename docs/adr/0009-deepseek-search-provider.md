# ADR 0009：DeepSeek Search Provider 协议映射

- 状态：已接受
- 日期：2026-08-19

## 背景

DeepSeek 不提供本项目可直接映射的专用搜索 endpoint，但其 Anthropic-compatible Messages API 支持原生 `web_search_20250305` server tool，并在响应中返回结构化搜索结果。项目需要利用该协议提供统一 Search 能力，同时避免把模型回答文本误当作可靠来源。

## 决策

新增内置 `deepseek` Provider Type 和同名 Instance，仅支持 Search。默认 base URL 为 `https://api.deepseek.com/anthropic/v1`，默认 Instance 只从 `DEEPSEEK_API_KEY` 读取标准凭据；通用 `apiKey`、`apiKeyEnv`、`baseUrl`、`baseUrlEnv` 和附加 header 仍可用于显式覆盖，不读取 `DEEPSEEK_BASE_URL`，也不新增专属配置字段。

Adapter 固定向 `{baseUrl}/messages` 发送 `deepseek-v4-flash`、`max_tokens: 4096` 与最多 5 次 `web_search_20250305` tool use，并使用 `anthropic-version: 2023-06-01`。请求经过统一 `HttpTransport`，传递调用者 signal 和响应字节上限，并以 `maxRedirects: 0` 严格拒绝重定向；配置 header 不能覆盖实际凭据或固定协议 header。

响应只解析 `web_search_tool_result` 中 `type: web_search_result` 的条目。`text.citations[].cited_text` 按原始 URL 关联为 snippet；模型 prose、thinking、tool-use 控制块、错误条目和 `page_age` 均不进入公共结果。结果继续由 `normalizeHits` 执行 HTTP(S) 校验、去 fragment、去重、域名过滤、排序和 limit 截断。有结果块但内容为空是成功的空结果；完全没有结果块则是可回退的 `provider_error`。

域名约束使用 `site:`/`-site:` 改写查询，并在结果上本地严格复核。DeepSeek 不支持 `freshness`；此类请求在联网前返回可回退的 `provider_unavailable`。默认 Search Route 将 DeepSeek 放在最后，因为一次调用是完整模型轮次，具有比专用检索 endpoint 更高的潜在延迟与 token 费用。

## 结果

公共 `SearchRequest`、`SearchHit`、envelope 和 `schemaVersion` 保持不变。DeepSeek 的模型回答不会被信任为搜索来源，所有网络、取消、响应上限、错误分类、attempt、fallback、raw 与脱敏继续由现有 transport/common/router 边界处理。真实请求只用于人工联调，不作为自动化测试或 CI 门禁。
