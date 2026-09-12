# ADR 0013：博查 Web Search Provider

- 状态：已接受
- 日期：2026-08-31

## 背景

需要在现有 `search` 能力中接入博查 Web Search，同时保持 SearchHit、Router fallback、debug/raw 脱敏和退出码等公共契约不变。博查的 Web Search 与 AI Search、结构化卡片是不同协议，本次只覆盖 `/v1/web-search`。

## 决策

新增内置 Provider Type/Instance `bocha`，默认端点为 `https://api.bocha.cn`，标准环境变量为 `BOCHA_API_KEY` 和 `BOCHA_BASE_URL`。请求固定使用 `POST /v1/web-search`，Bearer 鉴权和 JSON body，发送 `query`、`count`、`summary: true` 和 freshness（`oneDay`、`oneMonth`、`oneYear` 或 `noLimit`）。域名约束通过 `site:`/`-site:` 写入查询，并在本地再次过滤、去重和限制结果。

响应映射 `data.webPages.value` 到统一 SearchHit，非空 `summary` 优先于 `snippet`。顶层 `code` 缺失或为数值 200 时视为成功；非法 code、缺失或错误类型的 `data` 字段返回可恢复的 `invalid_response`，缺少 `webPages/value` 的合法 data 视为空结果。业务码和 HTTP 状态按稳定错误码分类；HTTP 403 为不可重试的 `quota_exceeded`，但由于存在最终非 2xx 状态，`auto` 仍会切换到下一个 Provider。错误消息和 raw 仅保留脱敏后的上游信息。

博查加入默认 Search 主 Route 的 Exa 之后、Brave 之前。省略 Route 的配置和新生成的默认配置使用该顺序；已有显式 Route 不自动插入博查，不引入迁移层。该 Provider 仅支持 Search，不扩展 Extract 或公共字段。

## 结果

博查可以通过现有 `search` 命令参与自动回退，并与其他 Provider 共享配置、诊断、Schema v2 和输出 envelope。区域端点、域名过滤和凭据覆盖仍由显式配置控制，真实 API 联调不属于本次验收范围。
