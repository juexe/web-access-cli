# web-access-cli

[English](README.md) | 简体中文

[![CI](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个 Agent-neutral 的网页能力 CLI。它把“搜索”和“网页正文提取”定义为稳定能力，把 Tavily、Exa、Bocha、Brave、SearXNG、AnySearch、XCrawl、DeepSeek、Firecrawl、Jina 等差异收敛到内部统一 schema。

CLI 是主要产品形态，不绑定 Pi、Claude Code、Codex、Cursor、OpenCode 或其他 Agent。Skill、MCP 和 Agent 插件只能作为 CLI 上层 adapter 接入，不能污染核心能力和 Provider 实现。

## 能力与 provider

| 能力 | Provider Type | 统一输出 |
| --- | --- | --- |
| `search` | Tavily、Exa、Bocha、Brave、SearXNG、AnySearch、XCrawl、DeepSeek、xAI x_search、xAI web_search | `rank`、`title`、`url`、`snippet` |
| `extract` | Firecrawl v2、Jina Reader、Exa Contents、AnySearch、XCrawl、HTTP | Markdown `Document` |

Provider Type 描述实现类型；Provider Instance 是一份可配置实例。一个 Type 可以有多个 Instance，例如 `exa_team` 和 `exa_personal`。每个能力都有主 `providers` Route 和兜底 `providers_fallback` Route；两组数组同时决定启用状态和 `auto` 顺序，CLI 只在原分组内部调整成员顺序。

## 安装

要求 Node.js 22.19 或更高版本。

从 npm 全局安装：

```sh
npm install --global web-access-cli
web-access --help
```

也可以使用 pnpm 安装：

```sh
pnpm add --global web-access-cli
web-access --help
```

从源码开发：

```sh
git clone https://github.com/juexe/web-access-cli.git
cd web-access-cli
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

## 项目结构

```text
src/cli.ts                 Commander CLI 与退出码
src/config/                配置文件、环境变量与 Route 合并
src/core/                  公共类型、schema、错误、路由和诊断
src/providers/             Provider adapter、registry、HTTP/RSC 提取
src/transport/             代理、超时、重定向和响应大小限制
schemas/                   构建生成的 JSON Schema
test/                      node:test 单元测试与本地 HTTP 集成测试
```

Provider adapter 应只负责协议映射；fallback、deadline、attempts、envelope 和退出码由 `src/core` 统一处理。不要在 adapter 中引入 Pi、Claude Code、Codex 或其他 Agent 的生命周期和工具注册代码。

## 开发工作流

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

`pnpm check` 会按上述顺序执行 lint、类型检查、测试和构建。修改 `src/core/schema.ts` 后必须重新运行 `pnpm build`，并提交更新后的 `schemas/*.schema.json`。Provider 测试应使用 `test/helpers.ts` 的 mock transport 或本地 HTTP server，不依赖真实 API key 和外网稳定性。

## 命令

```sh
web-access search "Agent-neutral web CLI"
web-access search "TypeScript release" --provider exa --limit 10 --freshness month
web-access search "browser automation" --include-domain example.com --exclude-domain blocked.example.com

web-access extract https://example.com/article
web-access extract https://example.com/article --provider http --timeout 30000
web-access extract https://example.com/article --json

web-access providers
web-access doctor

web-access config edit
web-access --config "/path/to/config.json" config edit
web-access config init
web-access --config "/path/to/config.json" config init --json
```

CLI 提供 `search`、`extract` 两个能力命令，`providers`、`doctor` 两个诊断命令，以及 `config init`、`config edit` 配置维护命令。当前版本不提供 batch/all、answer、PDF 专线、Node SDK 或通用 MCP 集成。仓库提供可选的 [web-access-cli Agent Skill](skills/web-access-cli/SKILL.md)，仅供源码仓库使用，不包含在 npm 发布包中。

### 通用选项

- `--config <path>`：显式指定配置文件。
- `--json`：输出紧凑 schema v2 JSON envelope；不指定时，成功命令输出面向人的 Markdown，失败始终输出 JSON。
- `--help`、`--version`：输出常规 CLI 帮助或版本文本。

成功命令默认输出面向人的 Markdown。`search` 输出 YAML front matter 和编号结果列表；`extract` 输出 YAML front matter 和规范化后的 Markdown 正文；`providers`、`doctor` 和 `config edit` 输出标题和格式化 JSON 数据；`config init` 输出新配置的绝对路径。需要 schema v2 envelope 时显式追加 `--json`。提取失败（包括 `partial`）以及所有失败路径始终输出 JSON envelope。诊断信息不会混入 stdout。

## 配置

配置是严格 JSON；未知字段会报错。CLI 只读取显式路径或用户级路径，不会向上查找项目目录中的配置文件。

所有平台的默认路径均为 `~/.config/web-access-cli/config.json`，其中 `~` 表示当前用户的主目录。环境变量 `WEB_ACCESS_CONFIG` 可以指定其他路径；命令行 `--config` 优先级更高。

`web-access config edit` 会在配置文件缺失时创建父目录和完整默认配置，再优先使用 `VISUAL`、其次使用 `EDITOR` 打开；变量值可以包含带引号的可执行文件路径和参数，解析时不会执行 shell，并将配置路径作为独立的最后一个参数传入。已有文件会原样打开，即使内容暂时不是有效 JSON 也不会被覆盖或格式化。命令只等待编辑器进程启动，不等待编辑器关闭。两个变量都未设置、格式无效或启动失败时返回 `open_failed`；如果配置刚刚创建成功，文件仍会保留以便手动编辑。

`config init` 按标准凭据环境变量创建新配置，已存在文件时拒绝覆盖。它保留全部内置 Instance 定义，将检测到的 Search provider 写入主 Route，Search fallback 留空，将检测到的远程 Extract provider 写入主 Route，并把 `http` 放入 Extract fallback。能力命令使用 `auto` 成功或发生可回退失败后，会原子重排对应的 `providers` 或 `providers_fallback` 数组；成员不会跨组移动。旧的 `_providers` 和 `_providers_fallback` 字段会被严格配置校验拒绝。

完整 JSON Schema 位于 [schemas/config.schema.json](schemas/config.schema.json)。示例：

```json
{
  "$schema": "https://unpkg.com/web-access-cli@0.5.0/schemas/config.schema.json",
  "providers": [
    {
      "id": "exa_team",
      "type": "exa",
      "apiKeyEnv": "TEAM_EXA_API_KEY",
      "headers": {
        "X-Team": "docs"
      }
    },
    {
      "id": "searx_local",
      "type": "searxng",
      "baseUrl": "http://127.0.0.1:8080"
    },
    {
      "id": "firecrawl_local",
      "type": "firecrawl",
      "baseUrl": "http://127.0.0.1:3002"
    }
  ],
  "search": {
    "providers": ["searx_local", "exa_team", "brave"],
    "providers_fallback": ["deepseek"],
    "limit": 5,
    "timeoutMs": 120000,
    "attemptTimeoutMs": 60000,
    "maxResponseBytes": 5242880
  },
  "extract": {
    "providers": ["firecrawl_local", "jina", "exa_team"],
    "providers_fallback": ["http"],
    "timeoutMs": 120000,
    "attemptTimeoutMs": 45000,
    "maxResponseBytes": 5242880,
    "minContentCharacters": 500
  }
}
```

内置 Instance 为 `tavily`、`exa`、`bocha`、`brave`、`searxng`、`firecrawl`、`jina`、`http`、`anysearch`、`xcrawl`、`deepseek`、`xai_x_search`、`xai_web_search`。配置同 ID 时会覆盖内置实例的字段；自定义 ID 可以创建同 Type 的额外实例。出现在对应主 Route 或 fallback Route 中的实例才启用。Bocha 默认 base URL 为 `https://api.bocha.cn`，必须配置 API key；AnySearch 默认 base URL 为 `https://api.anysearch.com`，支持匿名调用；XCrawl 默认 base URL 为 `https://run.xcrawl.com`，必须配置 API key；DeepSeek 默认 base URL 为 `https://api.deepseek.com/anthropic/v1`，必须配置 API key。

默认 Route：

- Search 主轮：`tavily -> exa -> bocha -> brave -> searxng -> anysearch -> xcrawl`
- Search fallback：`deepseek -> xai_x_search -> xai_web_search`
- Extract 主轮：`firecrawl -> jina -> exa -> anysearch -> xcrawl`
- Extract fallback：`http`

默认 Route 将内置 provider 分为主轮和 fallback。自定义 ID 会合并到 Instance 列表，但仍需显式加入 Route；省略能力 Route 时使用上述默认分组，Search 主 Route 显式空数组会报错，Extract 主 Route 可以显式为空以禁用 Extract。`auto` 会跳过未完成配置的 Instance。AnySearch 与 XCrawl 可设置 `searchFilterMode`：`strict`（默认，遇到 freshness 时跳过）或 `best_effort`（将日期改写为查询片段）。域名条件会改写查询并在本地再次严格过滤。XCrawl Extract 固定使用同步 Scrape 的 Markdown 输出；Map、Crawl 和异步任务不属于当前 CLI 能力。

DeepSeek Search 通过 Anthropic-compatible Messages API 调用原生 `web_search_20250305` server tool，一次搜索是完整模型轮次，因此延迟和成本可能高于专用搜索 endpoint。它位于默认 Search fallback，仅在全部主轮 Provider 未配置、返回最终非 2xx HTTP 响应或发生其他可恢复失败后触发。Adapter 只接受 `web_search_tool_result` 中的结构化 URL，按 URL 合并 citation 摘要，绝不从模型 prose 中猜测 URL。域名条件会改写查询并在本地再次严格过滤；DeepSeek 不支持 `freshness`，遇到该参数时以可恢复错误跳过；重定向会被严格拒绝，且不会访问 `Location` 目标。Provider 私有的 `encrypted_content` 是 CLI 无法展示或解码的 opaque payload，不具备诊断价值，因此会从 `raw` 中移除。

XAI hosted Search 使用 `XAI_AUTH_JSON` 指向外部 OAuth JSON 文件，每次调用只读取 `access_token`，由外部 CLIProxyAPI 负责刷新和回写。可用 `authJson`/`authJsonEnv` 与 `model`/`modelEnv` 为实例覆盖路径和模型。`xai_web_search` 支持最多 5 个 allow 或 exclude 域名（两者不能同时使用）；`xai_x_search` 不接受 `freshness`。模型搜索可能需要更长时间；Search 默认单次超时 60 秒、总超时 120 秒。

### 凭据和 URL

环境变量优先于 JSON 中的明文 key。内置 Instance 支持这些标准变量：

| Type | API key | Base URL |
| --- | --- | --- |
| Tavily | `TAVILY_API_KEY` | `TAVILY_BASE_URL` |
| Exa | `EXA_API_KEY` | `EXA_BASE_URL` |
| Bocha | `BOCHA_API_KEY` | `BOCHA_BASE_URL`，默认 `https://api.bocha.cn` |
| Brave | `BRAVE_API_KEY` | `BRAVE_BASE_URL` |
| SearXNG | 无 | `SEARXNG_BASE_URL`，必需 |
| Firecrawl | `FIRECRAWL_API_KEY` | `FIRECRAWL_BASE_URL` |
| Jina | `JINA_API_KEY`，可选 | `JINA_BASE_URL` |
| HTTP | 无 | 无 |
| AnySearch | `ANYSEARCH_API_KEY`，可选 | `ANYSEARCH_BASE_URL`，默认 `https://api.anysearch.com` |
| XCrawl | `XCRAWL_API_KEY` | `XCRAWL_BASE_URL`，默认 `https://run.xcrawl.com` |
| DeepSeek | `DEEPSEEK_API_KEY` | 无标准环境变量；默认 `https://api.deepseek.com/anthropic/v1` |
| xAI Search | `XAI_AUTH_JSON` | 无标准环境变量；默认 `https://cli-chat-proxy.grok.com/v1`，模型 `grok-4.6` |

自定义 Instance 使用 `apiKeyEnv` 和 `baseUrlEnv` 指定自己的环境变量。所有远端 Provider 都可以设置 `baseUrl` 和附加 `headers`。公共 `api.firecrawl.dev` 需要 key；自托管 Firecrawl v2 可以不设置 key。

## 执行与回退

`--provider auto` 先按 `providers` 顺序执行；只有主轮全部失败且结果可回退时才进入 `providers_fallback`：

1. 未完成配置的实例会记录为失败 attempt 并跳过。
2. Provider 返回的最终 HTTP 响应不在 2xx 范围时，包括鉴权、请求、限流和服务器错误，Router 会尝试下一个实例。
3. 网络错误、超时、响应过大、无可用正文等其他可恢复错误也会继续 Route。
4. 没有最终非 2xx 响应的不可恢复错误，例如无效输入或在成功响应中检测到不支持的内容，会立即停止。
5. 两组实例全部失败时返回 `provider_exhausted`。提取过程中产生的最佳短正文会保留在 `partial`。

执行这些 Route 前，`extract --provider auto` 会在任一组启用了 HTTP Instance 时先探测一个源站 Markdown 变体：文件型路径追加 `.md`，目录路径使用 `index.md`，请求 `text/markdown`/`text/plain`，只接受足够长且非 HTML 的文本响应。未命中或请求失败时不产生额外 attempt，并继续原有 Route；命中时结果归属已启用的 HTTP Instance，且不改变 Provider 顺序。显式非 HTTP 选择不变；显式 HTTP 会先探测 Markdown，未命中后再请求原 URL。

每次 `auto` 调用完成后，成功 Instance 移到所在组队头，未尝试 Instance 保持在中间，发生上述可回退失败的 Instance 稳定移到所在组队尾；顺序学习不会跨组移动 provider。所有 Instance 都失败时顺序不变。Search 与 Extract 独立学习；显式 Instance、不可回退错误和用户取消不会更新顺序。写入采用原子替换，并发进程由最后写入者生效。

Attempt 会保留 Provider 的原始错误码、HTTP status 和 `retryable` 值。`retryable` 表示原始操作是否适合对同一 Provider 重试，不再是自动 Route 切换到下一 Provider 的唯一条件。

显式指定 Instance 时严格执行，不触发 fallback。若实例不在 Route 中，返回 `provider_disabled`。

默认上限：Search 总超时/单次超时为 120s/60s，Extract 为 120s/45s；单个响应硬上限为 5 MiB。`--timeout` 只覆盖本次命令的总超时。

## 输出契约

能力命令使用 output schema v2，默认 envelope 刻意保持精简：

```json
{
  "schemaVersion": 2,
  "ok": true,
  "provider": "exa",
  "data": {
    "results": [
      {
        "rank": 1,
        "title": "Example",
        "url": "https://example.com/",
        "snippet": "Example snippet"
      }
    ]
  }
}
```

使用 `--json` 时，能力命令成功只包含 `schemaVersion`、`ok`、最终 Instance ID 和规范化 `data`。失败时包含精简 `error`；实际尝试过 Provider 时，`attempts` 只保留 Instance ID、错误码和可选 HTTP status。提取质量失败可包含不含 raw 的 `partial` 文档。排序无法写回时，成功或失败 envelope 会额外包含 `warnings: [{ "code": "provider_order_update_failed", "message": "..." }]`，但不会覆盖主要结果。搜索和提取输入错误也使用相同的精简失败结构。

面向人的输出中，提取以 YAML front matter 开头、随后是 Provider 规范化的 Markdown 正文；搜索使用编号 Markdown 列表；诊断和配置编辑使用标题加格式化 JSON 数据。元数据值统一使用 JSON 双引号标量编码，正文内容不改写。已有脚本和其他机器消费者应显式追加 `--json`。

默认提取输出示例：

```markdown
---
provider: "local_http"
url: "https://example.com/article"
title: "Example title"
---

# Article content
```

所有成功和失败 envelope 使用 schema version 2。稳定 schema 位于 [schemas](schemas)。

退出码：

- `0`：成功
- `2`：输入、配置、未知或未启用 provider
- `1`：运行时/provider/doctor/编辑器启动失败
- `130`：用户取消

`providers` 会列出每个 Instance 的 Type、能力、Route 启用状态、凭据来源和 base URL 来源；`searchRoute`/`searchFallbackRoute` 与 `extractRoute`/`extractFallbackRoute` 是下一次 `auto` 使用的两组有效顺序。`doctor` 只做本地配置检查，不主动调用远端 API；当已启用 Route 中存在未配置 Instance 时，命令返回 `doctor_failed` 和退出码 `1`。

## HTTP 与安全边界

- 默认遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。
- 最多跟随 5 次重定向；跨 origin 重定向会移除鉴权、Cookie 和常见 token headers。
- 所有响应都执行流式字节上限，避免先完整缓冲超大响应。
- HTTP Extract 使用 LinkeDOM、Mozilla Readability、Turndown，并对 Next.js RSC payload 做后备解析。
- HTTP Extract 在 route 已启用 HTTP Instance 时优先读取可用的源站 Markdown 变体（`.md` 或目录 `index.md`）。
- PDF、图片、音频、视频、zip 和通用二进制内容会返回 `unsupported_content`。
- 按项目设计，CLI 不阻止 localhost、私网地址或云元数据 URL。调用者必须在不可信输入场景中自行实施 URL allowlist、网络隔离或出站代理策略。

## 项目边界

本项目大量参考 `pi-web-access` 的 provider 和内容提取实现，但不包含 Pi-specific 注册、工具协议或 UI 代码。

欢迎贡献。提交 Issue 或 Pull Request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全漏洞请按照 [SECURITY.md](SECURITY.md) 私下报告。

许可证为 MIT，第三方与上游归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
