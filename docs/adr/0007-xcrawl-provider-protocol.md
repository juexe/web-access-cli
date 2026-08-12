# ADR 0007：XCrawl Provider 协议映射

- 状态：已接受；默认 Route 条款由 ADR 0008 取代
- 日期：2026-08-12

## 背景

XCrawl 同时提供 Search、Scrape、Map、Crawl 和异步任务接口。项目需要支持其网页搜索与单页正文提取，但不能让 Provider 协议扩张现有 `search`、`extract` 稳定能力边界。

## 决策

新增内置 `xcrawl` Provider Type，adapter 使用 `POST /v1/search` 和同步 `POST /v1/scrape`，所有请求复用统一 `HttpTransport`。Extract 固定请求 Markdown，不实现 Map、Crawl、异步结果轮询或 webhook，也不新增 XCrawl 专属 CLI 参数。

XCrawl 初始不加入默认 Route；该默认 Route 条款后由 ADR 0008 取代。XCrawl 仍必须配置 Bearer Token。Search 与 AnySearch 共用 `searchFilterMode`：`strict` 遇到 freshness 时返回可回退的 `provider_unavailable`；`best_effort` 将日期和域名条件改写为查询，并在本地再次严格过滤。

## 结果

XCrawl 的协议与计费触发保持显式，公共 request、data、envelope 和 `schemaVersion` 不变。未来若支持 Map、Crawl 或异步任务，需要先把它们作为独立产品能力重新建模。
