# ADR 0012：持久化自适应 Provider 顺序

- 状态：已接受
- 日期：2026-08-19

## 背景

CLI 每次能力调用都是独立进程。固定 Route 会让暂时异常或长期失效的 Provider 在每次查询中重复占用首段 deadline，也无法让刚刚成功的后备 Provider 在下一次调用中优先执行。直接重排用户的 `providers` 又会混淆启用意图与运行时状态。

## 决策

`search.providers` 与 `extract.providers` 继续定义启用集合和初始顺序；同级 `_providers` 由 CLI 保存对应 Capability 的实际顺序。所有 `--provider auto` 调用使用有效 `_providers`，显式 Instance 仍严格执行且不参与学习。内部数组缺失、格式错误、重复、引用未知 ID 或与用户 Route 成员集合不一致时整组重置；删除 `_providers` 可以手动恢复初始顺序。

学习沿用 ADR 0010 的 Route 切换资格。成功 Instance 置于队头，未尝试 Instance 保持在中间，符合回退资格的失败 Instance 稳定移到队尾，各组保留原相对顺序。全员失败时顺序不变；不可回退错误和用户取消不更新状态。

排序通过结构化 JSON 编辑和原子替换写回同一配置文件。默认配置缺失时，首次产生学习结果的 `auto` 调用创建完整默认配置。跨进程并发采用最后写入者生效，不引入强一致锁。写回失败不覆盖主要查询结果，而是在能力 envelope 中增加 `provider_order_update_failed` warning。`providers` 诊断的 Route 字段显示下一次 `auto` 使用的有效顺序。

本决策取代 ADR 0002 中“配置 Route 顺序始终就是 `auto` 执行顺序”的条款；ADR 0008 的默认顺序继续作为初始顺序。

## 结果

短生命周期 CLI 可以跨进程避开刚刚失败的 Provider，并优先复用已验证成功的 Instance，同时仍由用户 Route 严格控制启用范围。代价是能力调用会维护配置中的内部字段，并发调用可能丢失一次学习结果；原子替换保证配置不会出现半写文件，失败 warning 让未保存状态保持可观测。
