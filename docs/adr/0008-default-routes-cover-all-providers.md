# ADR 0008：默认 Route 覆盖全部内置 Provider

- 状态：已被 ADR 0017 补充
- 日期：2026-08-12

## 背景

新增 Provider Type 后若未同步默认 Route，会出现内置 Instance 已受支持却默认禁用的分裂状态。Route 同时决定启用范围和 `auto` 回退顺序，因此完整覆盖仍需保留明确、可审计的优先级。

## 决策

省略 Capability 的 Route 时，默认主 Route 与 fallback Route 一起覆盖支持该能力的全部内置 Instance；新增 Provider Type 时必须明确安排所属分组和顺序。Search 主 Route 为 `tavily -> exa -> bocha -> brave -> searxng -> anysearch -> xcrawl`，fallback 为 `deepseek -> xai_x_search -> xai_web_search`；Extract 主 Route 为 `firecrawl -> jina -> exa -> anysearch -> xcrawl`，fallback 为 `http`。DeepSeek 与 xAI 是完整模型轮次或托管搜索，放在 Search fallback 以避免不必要的延迟与费用；博查位于 Exa 之后、Brave 之前。

显式 Route 保持原样，Search 主 Route 不能显式为空，Extract 主 Route 可以显式为空以禁用 Extract；自定义 Instance ID 不会隐式加入任一默认 Route。`auto` 先完成主 Route，再在全部错误可回退时进入 fallback，并跳过未完成配置的 Instance。本决策取代 ADR 0006 与 ADR 0007 中 AnySearch、XCrawl 不加入默认 Route 的条款。

## 结果

缺省配置可以使用所有已支持 Provider，并继续通过明确分组和顺序控制回退。AnySearch 在主 Route 中可能被匿名调用；XCrawl 仅在配置凭据后被调用。调用者如需限制远端服务、数据发送或成本，仍应显式配置两组 Route。
