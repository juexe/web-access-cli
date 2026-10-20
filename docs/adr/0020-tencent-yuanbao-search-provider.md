# ADR 0020：腾讯云元宝搜索 Provider

- 状态：已接受
- 日期：2026-10-20

## 背景

需要在现有 `search` 能力中接入腾讯云元宝搜索（Tencent Yuanbao Search，`wsa`）。它提供两种接入方式：云 API 3.0 签名调用（`wsa.tencentcloudapi.com`）和服务 API KEY 方式（`api.wsa.cloud.tencent.com`）。本项目只支持 API KEY 方式的 `POST /SearchPro`，因为签名方式需要额外引入腾讯云 SDK 或自行实现 TC3-HMAC-SHA256，且与现有 Bearer 凭据模型不一致。

## 决策

新增内置 Provider Type/Instance `yuanbao`，默认端点为 `https://api.wsa.cloud.tencent.com`，标准环境变量为 `YUANBAO_API_KEY` 和 `YUANBAO_BASE_URL`，仅支持 Search。请求固定为 `POST /SearchPro`，`Authorization: Bearer <API KEY>`，请求体使用元宝的小写驼峰字段名（`Query`，可选 `Site`、`Freshness`、`Cnt`）。`Cnt` 只在 `--limit` 超过 10 时按 10 向上取整发送（上限 50），因为极速版不支持该参数且标准版默认返回 10 条；`Mode`、`Industry`、`Deeplinks` 目前不映射。

域名约束优先使用元宝原生的 `Site` 参数：单个 include 域名映射为 `Site=<domain>`，1 到 5 个 exclude 域名映射为 `Site=exclude:<domain>|<domain>`；其他组合只保留本地严格过滤，不把 `site:` 语法拼进 `Query`，以免污染检索词。`freshness` 映射为 `Freshness=d1|m1|y1`，与现有 `day|month|year` 语义一致。

响应固定读取 `Response.Pages`：它是 JSON 字符串数组，逐条解析后映射为统一 SearchHit，摘要优先取标准摘要 `passage`，其次取动态摘要 `content`。单条 Pages 解析失败时跳过该条并保留其余结果；全部条目都无法解析时返回可恢复的 `invalid_response`。`Response.Error` 表示业务错误：`UnauthorizedOperation` 为 `auth_error`，`ResourceNotFound` 与 `ResourceUnavailable` 为 `quota_exceeded`，`RequestLimitExceeded` 为 `rate_limited`，其余为 `provider_error`。业务错误常以 HTTP 200 返回，因此统一标记为可回退，避免单个 Provider 未开通或欠费就中断整条 Route。错误消息和 `raw` 只保留脱敏后的上游内容。

元宝加入默认 Search 主 Route 的 Bocha 之后、Brave 之前。省略 Route 的配置和新生成的默认配置使用该顺序；已有显式 Route 不自动插入元宝，不引入迁移层。Provider 仅支持 Search，不扩展 Extract 或公共字段。

## 结果

元宝搜索可以通过现有 `search` 命令参与自动回退，并与其他 Provider 共享配置、诊断、Schema v2 和输出 envelope。云 API 签名方式、`Mode`/`Industry`/`Deeplinks` 等未映射参数、以及真实 API 联调都不属于本次范围。
