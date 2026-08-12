# ADR 0008：默认 Route 覆盖全部内置 Provider

- 状态：已接受
- 日期：2026-08-12

## 背景

新增 Provider Type 后若未同步默认 Route，会出现内置 Instance 已受支持却默认禁用的分裂状态。Route 同时决定启用范围和 `auto` 回退顺序，因此完整覆盖仍需保留明确、可审计的优先级。

## 决策

省略 Capability 的 Route 时，默认 Route 包含支持该能力的全部内置 Instance；新增 Provider Type 时必须明确安排默认顺序。Search 顺序为 `tavily -> exa -> brave -> searxng -> anysearch -> xcrawl`，Extract 顺序为 `firecrawl -> jina -> exa -> anysearch -> xcrawl -> http`，通用 HTTP 保持最终后备。

显式 Route 保持原样，显式空数组继续表示禁用全部，自定义 Instance ID 不会隐式加入默认 Route。`auto` 仍跳过未完成配置的 Instance。本决策取代 ADR 0006 与 ADR 0007 中 AnySearch、XCrawl 不加入默认 Route 的条款。

## 结果

缺省配置可以使用所有已支持 Provider，并继续通过明确顺序控制回退。AnySearch 在前序 Provider 失败后可能被匿名调用；XCrawl 仅在配置凭据后被调用。调用者如需限制远端服务、数据发送或成本，仍应显式配置 Route。
