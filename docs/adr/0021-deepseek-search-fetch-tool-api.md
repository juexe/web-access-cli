# ADR 0021：DeepSeek 官方 Search / Fetch 工具协议

- 状态：已接受，取代 ADR 0009
- 日期：2026-10-20

## 背景

ADR 0009 把 DeepSeek 映射到 Anthropic-compatible Messages API 的原生 `web_search_20250305` server tool。该实现的每次调用都是一整轮模型推理，`max_tokens`、模型轮次、citation 拼接和 `encrypted_content` 都成为 provider 内部细节，延迟与费用显著高于专用检索 endpoint；它也因此只能停留在 Search fallback 末端。

DeepSeek 现已提供专用工具 API：`POST /v1/tools/search` 返回结构化结果，`POST /v1/tools/fetch` 返回 Markdown 正文。二者与模型 API 共用 `https://api.deepseek.com` 和 Bearer 鉴权，正好对应本项目的 `search` 与 `extract` 两个 Capability。

## 决策

**协议切换。** `deepseek` 改为直接调用官方工具 API：Search 使用 `POST {baseUrl}/v1/tools/search`，Fetch 使用 `POST {baseUrl}/v1/tools/fetch`。默认 base URL 从 `https://api.deepseek.com/anthropic/v1` 改为 `https://api.deepseek.com`；标准凭据仍是 `DEEPSEEK_API_KEY`，不新增 `DEEPSEEK_BASE_URL`、模型或专属配置字段。`anthropic-version`、`x-api-key`、`model`、`max_tokens`、`tools` 与 `messages` 全部移除；请求只用 `Authorization: Bearer` 与 JSON，配置 header 不能覆盖鉴权或协议 header。

**Search 映射。** 请求固定发送 `need_content: false`，`count` 取 `limit`（同时受协议上限 50 保护）。`snippet` 是面向展示的短摘要，公共契约只有一个 `snippet`，因此优先使用它，缺失时才回退到 `summary`；`content`、`rerank_score`、`site_*`、`date`、`authority` 不进入公共结果，但保留在 `raw`。`results` 为缺失或 `null` 时是成功的空结果，非数组才是 `invalid_response`。结果继续由 `normalizeHits` 执行 HTTP(S) 校验、去 fragment、去重、域名过滤、排序和 limit 截断。

**筛选语义。** 官方 Search 没有 `freshness` 字段，但支持 `after:` 搜索语法；域名约束本来就通过 `site:` / `-site:` 表达。两者都改写到 `query`，并在结果上本地严格复核。query 有 128 字符的硬限制：拼接后会超出预算时丢弃远端筛选提示、只保留用户原始 query 与 freshness，因为远端提示只是优化，本地过滤才是契约。

**Fetch 映射。** `extract` 向 Fetch 发送 `{url}`，把 `content` 作为 Markdown 正文、`title` 作为标题，`sourceUrl` 始终是请求 URL，`contentType` 始终是 `text/markdown`；正文为空或仅空白时返回可回退的 `no_usable_content`。Fetch 的 HTTP 404 表示目标不可抓取，同样映射为可回退的 `no_usable_content`，不进入 `provider_error`。

**错误分类。** 401 → `auth_error`，402 → `quota_exceeded`，429 → `rate_limited`，其余 4xx/5xx → `provider_error`；400/401/402/403 标记为不可重试同一 Provider，其余状态可重试。错误响应遵循 OpenAI 兼容 `{error:{message,type,param,code}}`，message 与 `raw` 在返回前排空 API key。

**默认 Route。** 原生检索 endpoint 不再占用模型轮次，DeepSeek 从 Search fallback 前移到主 Route 末端（`tavily -> exa -> bocha -> yuanbao -> brave -> searxng -> anysearch -> xcrawl -> deepseek`），同时作为 Extract 主 Route 的最后一名、位于 `http` fallback 之前。Search fallback 只保留 `xai_x_search` 与 `xai_web_search`。ADR 0008 与 ADR 0017 中的默认 Route 清单由本 ADR 补充。

## 结果

公共 `SearchRequest`、`SearchHit`、`Document`、envelope 与 `schemaVersion` 保持不变，但 `deepseek` 的默认 base URL、默认 Route 位置与 Capability 集合（新增 Extract）属于用户可见变更，需要同步中英文 README。旧配置若显式写了 `https://api.deepseek.com/anthropic/v1`，会命中 `/anthropic/v1/v1/tools/search` 并失败，必须改为默认值或自定义根地址。

网络、取消、响应上限、错误分类、attempt、fallback、raw 与脱敏仍由现有 transport/common/router 边界处理。真实请求只用于人工联调，不作为自动化测试或 CI 门禁。

## 相关

- ADR 0008 / ADR 0017：默认双 Route 与组内顺序
- ADR 0019：DeepSeek 兼容 HTTP 网关（复用 CLI 的能力命令，与本协议无关）
