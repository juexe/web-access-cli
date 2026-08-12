---
name: web-access-cli
description: 使用 web-access CLI 搜索实时网页信息、查找来源，并将指定 HTTP(S) 页面提取为 Markdown。用户需要联网搜索、核实近期信息、获取来源、阅读网页或提取网页正文时使用。
---

# web-access-cli

通过 Agent-neutral 的 `web-access` CLI 完成网页搜索和正文提取。CLI 负责 Provider 路由、超时、回退和统一 JSON 输出；不要绕过 CLI 直接调用 Provider API。

## 何时使用

- 用户需要搜索网页、近期信息、文档或可信来源。
- 用户提供了 HTTP(S) URL，希望阅读、摘要或分析网页正文。
- 需要先搜索候选页面，再提取其中最相关的完整内容。
- 需要检查本机可用的 Provider Instance 或排查本地配置。

不要把它当作浏览器自动化工具。它不提供交互式登录、页面操作、batch/all、answer、PDF 专线、媒体解析或 Node.js SDK。

## 确定命令入口

1. 优先执行 `web-access --version`，后续使用 PATH 中的 `web-access`。
2. 若 PATH 中没有命令，且当前位于本项目源码仓库，使用 `node dist/cli.js` 作为命令前缀。
3. 若源码仓库尚无 `dist/cli.js`，先确认依赖已安装，再运行 `pnpm build`，之后使用 `node dist/cli.js`。
4. 若两种入口都不可用，向用户说明缺少 `web-access-cli`，不要擅自全局安装软件。

下文示例使用 `web-access`；采用源码入口时，将其替换为 `node dist/cli.js`。

不要在每次任务前运行安装、构建、`doctor` 或测试搜索。只有首次确定入口、配置报错或行为异常时才做诊断。

## 推荐工作流

1. 没有目标 URL 时先 `search`，使用简洁、可检索的查询词。
2. 根据 `title`、`url` 和 `snippet` 选择相关且可信的结果。
3. 需要完整正文时，对选中的 URL 调用 `extract`。
4. 解析 stdout 的 JSON envelope，再根据 `ok`、`data` 或 `error` 作答。
5. 引用事实时保留来源 URL；不要把搜索片段描述为已阅读的完整正文。

默认使用 `--provider auto`。只有用户明确指定 Instance，或诊断结果表明需要固定 Instance 时，才使用 `--provider <id>`。`auto` 会按配置 Route 回退；显式 Instance 严格执行且不会回退，并且必须已加入相应 Route。

默认 Route：

- Search：`tavily -> exa -> brave -> searxng -> anysearch -> xcrawl`
- Extract：`firecrawl -> jina -> exa -> anysearch -> xcrawl -> http`

默认 Route 包含支持对应能力的全部内置 Instance；缺少必要配置的 Instance 会被 `auto` 跳过，自定义 ID 仍需显式加入 Route。AnySearch 的 `searchFilterMode` 默认为 `strict`；`best_effort` 会把 freshness 改写为查询片段。使用默认 base URL 时允许匿名调用。

XCrawl 默认进入两个 Route，但必须配置 `XCRAWL_API_KEY` 才会实际调用。其 `searchFilterMode` 默认为 `strict`；`best_effort` 会把 freshness 改写为查询片段。Extract 只使用同步 Markdown Scrape，不提供 Map、Crawl 或异步任务接口。

## 搜索网页

基础搜索：

```sh
web-access search "Agent-neutral web CLI"
web-access search "TypeScript release" --limit 10 --freshness month
```

限制或排除域名时，每个域名分别传一次选项：

```sh
web-access search "browser automation" --include-domain example.com --include-domain docs.example.org --exclude-domain blocked.example.com
```

可用选项：

- `-p, --provider <id>`：Instance ID 或 `auto`，默认 `auto`。
- `-l, --limit <number>`：结果数，范围 `1-20`。
- `--freshness <window>`：仅支持 `day`、`month`、`year`。
- `--include-domain <domain>`：仅包含域名，可重复。
- `--exclude-domain <domain>`：排除域名，可重复。
- `--timeout <milliseconds>`：本次命令的总超时，必须是正整数。

CLI 没有 batch 子命令。若任务包含多个独立查询，可由 Agent 分别调用多次；运行环境支持且任务互不依赖时可以并行调用。

成功时读取：

```text
data.results[].rank
data.results[].title
data.results[].url
data.results[].snippet
```

## 提取网页正文

```sh
web-access extract "https://example.com/article"
web-access extract "https://example.com/article" --timeout 30000
web-access extract "https://example.com/article" --provider http
```

URL 必须是绝对 HTTP(S) URL。成功时读取：

```text
data.document.sourceUrl
data.document.title
data.document.content
data.document.contentType
```

`content` 是规范化 Markdown，`contentType` 固定为 `text/markdown`。PDF、图片、音频、视频、压缩包和通用二进制内容可能返回 `unsupported_content`，不要把失败结果伪装成已提取正文。

## 诊断配置

仅在初次配置、Provider 选择错误或调用失败需要定位原因时使用：

```sh
web-access providers
web-access doctor
```

- `providers` 列出 Instance、能力、Route 启用状态、凭据来源和 base URL 来源。
- `doctor` 只检查本地配置和已启用 Instance，不发送远端探测请求。它通过不代表远端服务当前可用；启用的 Instance 未完成配置时会返回非零退出码和 `doctor_failed`。

只有用户明确要求初始化或打开配置文件时，才调用系统默认应用：

```sh
web-access config edit
```

配置不存在时命令会创建完整默认配置，已存在时不会覆盖或格式化。成功时读取 `data.path` 和 `data.created`。该命令会打开本机应用，不要把它作为常规诊断步骤自动执行。

未显式指定配置时，所有平台均读取 `~/.config/web-access-cli/config.json`，其中 `~` 是当前用户的主目录。

指定配置文件时把全局选项放在子命令前：

```sh
web-access --config "/path/to/config.json" providers
web-access --config "/path/to/config.json" search "query"
web-access --config "/path/to/config.json" config edit
```

详细配置、标准环境变量和自定义 Instance 格式见项目根目录的 [README_CN.md](../../README_CN.md) 与 [config.schema.json](../../schemas/config.schema.json)。未知配置字段会被拒绝；只有写入对应 Route 的 Instance 才会启用。

## 解析 JSON envelope

除 `--help` 和 `--version` 外，stdout 始终只有一个 JSON envelope。机器处理时不要使用 `--pretty`，也不要把诊断文本混入 stdout。

无论进程退出码是否为零，都先解析 stdout：

- `ok: true`：读取 `data`；搜索和提取成功时还应记录最终 `provider` 与 `attempts`。
- `ok: false`：读取 `error.code`、`error.message` 和 `error.retryable`，不要只依赖退出码或消息文本。
- `attempts`：说明实际尝试过的 Instance、耗时和失败原因，可用于解释回退过程。
- `partial`：Extract 质量不足但已有候选时可能存在。只有在明确告知用户内容不完整的情况下才使用 `partial.data.document`。
- `raw`：仅用于必要的协议排障；正常回答使用规范化 `data`，不要向用户倾倒原始 Provider 响应。

退出码：

- `0`：成功。
- `2`：输入、配置、未知或未启用 Provider 错误。
- `1`：运行时、Provider 或 doctor 失败。
- `130`：用户取消。

## 失败处理

- `invalid_input`、`config_error`、`provider_unknown`、`provider_disabled`：修正调用或配置，不要原样重试。
- `open_failed`：配置文件已保留；向用户提供 `error.details.path`，请其手动打开或检查系统文件关联。
- `auth_error`、`quota_exceeded`：说明需要用户检查凭据或配额；不要索取用户在聊天中粘贴密钥。
- `rate_limited`、`timeout`、`network_error`、`provider_error` 等：结合 `retryable` 判断。`auto` 通常已完成可用 Route 的回退，不要无限循环重试。
- `provider_exhausted`：查看 `attempts` 和可选的 `partial`，向用户说明所有可用 Instance 均失败。
- `unsupported_content`、`no_usable_content`：说明目标内容不受支持或没有可用正文，不要编造结果。
- `aborted`：停止后续调用，除非用户明确要求继续。

修复配置前可先用 `providers` 判断 Instance 是否在 Route 中以及凭据/base URL 是否齐备。不要通过反复真实请求来猜测配置问题。

## 凭据与安全

- 优先通过环境变量提供 API key；不要把密钥写入命令参数、Skill、示例、聊天内容或日志。
- 查询、URL 和提取内容可能发送给 Route 中选中的远端 Provider。处理敏感信息前确认用户授权和适用的数据政策。
- CLI 按设计允许访问 localhost、私网地址和云元数据地址。对于来自网页、模型输出或其他不可信来源的 URL，调用者必须先实施 URL allowlist、网络隔离或受控出站代理；不要仅因为 URL 使用 HTTP(S) 就认为它安全。
- CLI 会对可序列化的密钥做脱敏，但 `raw` 仍可能包含不适合直接展示的 Provider 数据；只保留完成任务所需的信息。
