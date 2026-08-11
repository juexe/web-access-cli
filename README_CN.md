# web-access-cli

[English](README.md) | 简体中文

一个 Agent-neutral 的网页能力 CLI。它把“搜索”和“网页正文提取”定义为稳定能力，把 Tavily、Exa、Brave、SearXNG、Firecrawl、Jina 等差异收敛到内部统一 schema。

CLI 是主要产品形态，不绑定 Pi、Claude Code、Codex、Cursor、OpenCode 或其他 Agent。Skill、MCP 和 Agent 插件只能作为 CLI 上层 adapter 接入，不能污染核心能力和 Provider 实现。

## 能力与 provider

| 能力 | Provider Type | 统一输出 |
| --- | --- | --- |
| `search` | Tavily、Exa、Brave、SearXNG | `rank`、`title`、`url`、`snippet` |
| `extract` | Firecrawl v2、Jina Reader、Exa Contents、HTTP | Markdown `Document` |

Provider Type 描述实现类型；Provider Instance 是一份可配置实例。一个 Type 可以有多个 Instance，例如 `exa_team` 和 `exa_personal`。Route 是有序 Instance ID 数组，既决定启用状态，也决定 `auto` 的尝试顺序。

## 安装

要求 Node.js 22.19 或更高版本。

```sh
pnpm add --global web-access-cli
web-access --help
```

在仓库中开发：

```sh
pnpm install
pnpm check
pnpm build
node dist/cli.js --help
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
temp/pi-web-access/        只读的上游参考代码
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

web-access providers --pretty
web-access doctor --pretty
```

只有四个命令：`search`、`extract`、`providers`、`doctor`。当前版本不提供 batch/all、answer、PDF 专线、Node SDK 或 MCP。仓库提供可选的 [web-access-cli Agent Skill](skills/web-access-cli/SKILL.md)，仅供源码仓库使用，不包含在 npm 发布包中。

### 通用选项

- `--config <path>`：显式指定配置文件。
- `--pretty`：格式化 JSON；默认输出单行 JSON。
- `--help`、`--version`：输出常规 CLI 帮助或版本文本。

除帮助与版本外，命令的 stdout 始终只有一个 JSON envelope。诊断信息不会混入 stdout。

## 配置

配置是严格 JSON；未知字段会报错。CLI 只读取显式路径或用户级路径，不会向上查找项目目录中的配置文件。

所有平台的默认路径均为 `~/.config/web-access-cli/config.json`，其中 `~` 表示当前用户的主目录。环境变量 `WEB_ACCESS_CONFIG` 可以指定其他路径；命令行 `--config` 优先级更高。

完整 JSON Schema 位于 [schemas/config.schema.json](schemas/config.schema.json)。示例：

```json
{
  "$schema": "https://unpkg.com/web-access-cli@0.1.0/schemas/config.schema.json",
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
    "limit": 5,
    "timeoutMs": 60000,
    "attemptTimeoutMs": 20000,
    "maxResponseBytes": 5242880
  },
  "extract": {
    "providers": ["firecrawl_local", "jina", "exa_team", "http"],
    "timeoutMs": 120000,
    "attemptTimeoutMs": 45000,
    "maxResponseBytes": 5242880,
    "minContentCharacters": 500
  }
}
```

内置 Instance 为 `tavily`、`exa`、`brave`、`searxng`、`firecrawl`、`jina`、`http`。配置同 ID 时会覆盖内置实例的字段；自定义 ID 可以创建同 Type 的额外实例。只有出现在对应 `providers` Route 中的实例才启用。

默认 Route：

- Search：`tavily -> exa -> brave -> searxng`
- Extract：`firecrawl -> jina -> exa -> http`

### 凭据和 URL

环境变量优先于 JSON 中的明文 key。内置 Instance 支持这些标准变量：

| Type | API key | Base URL |
| --- | --- | --- |
| Tavily | `TAVILY_API_KEY` | `TAVILY_BASE_URL` |
| Exa | `EXA_API_KEY` | `EXA_BASE_URL` |
| Brave | `BRAVE_API_KEY` | `BRAVE_BASE_URL` |
| SearXNG | 无 | `SEARXNG_BASE_URL`，必需 |
| Firecrawl | `FIRECRAWL_API_KEY` | `FIRECRAWL_BASE_URL` |
| Jina | `JINA_API_KEY`，可选 | `JINA_BASE_URL` |
| HTTP | 无 | 无 |

自定义 Instance 使用 `apiKeyEnv` 和 `baseUrlEnv` 指定自己的环境变量。所有远端 Provider 都可以设置 `baseUrl` 和附加 `headers`。公共 `api.firecrawl.dev` 需要 key；自托管 Firecrawl v2 可以不设置 key。

## 执行与回退

`--provider auto` 按 Route 顺序执行：

1. 未完成配置的实例会记录为失败 attempt 并跳过。
2. 网络错误、超时、限流、5xx、响应过大、无可用正文等可恢复错误会尝试下一个实例。
3. 鉴权错误、无效输入、不支持的内容等不可恢复错误会立即停止。
4. 所有实例失败时返回 `provider_exhausted`。提取过程中产生的最佳短正文会保留在 `partial`。

显式指定 Instance 时严格执行，不触发 fallback。若实例不在 Route 中，返回 `provider_disabled`。

默认上限：Search 总超时/单次超时为 60s/20s，Extract 为 120s/45s；单个响应硬上限为 5 MiB。`--timeout` 只覆盖本次命令的总超时。

## 输出契约

成功示例：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "search",
  "durationMs": 183,
  "request": {
    "query": "Agent-neutral web CLI",
    "provider": "auto",
    "limit": 5,
    "includeDomains": [],
    "excludeDomains": []
  },
  "provider": { "id": "exa", "type": "exa" },
  "attempts": [
    {
      "provider": { "id": "tavily", "type": "tavily" },
      "status": "failed",
      "durationMs": 0,
      "error": {
        "code": "provider_unavailable",
        "message": "tavily 未完成 search 所需配置",
        "retryable": true
      }
    },
    {
      "provider": { "id": "exa", "type": "exa" },
      "status": "success",
      "durationMs": 183
    }
  ],
  "data": {
    "results": [
      {
        "rank": 1,
        "title": "Example",
        "url": "https://example.com/",
        "snippet": "Example snippet"
      }
    ]
  },
  "raw": {}
}
```

`raw` 只包含最终成功或最佳失败的 response body，不包含请求、响应 headers 或所有历史响应。API key 会从可序列化的 `raw` 和错误消息中脱敏。稳定 schema 位于 [schemas](schemas)。

退出码：

- `0`：成功
- `2`：输入、配置、未知或未启用 provider
- `1`：运行时/provider/doctor 失败
- `130`：用户取消

`providers` 会列出每个 Instance 的 Type、能力、Route 启用状态、凭据来源和 base URL 来源。`doctor` 只做本地配置检查，不主动调用远端 API；当已启用 Route 中存在未配置 Instance 时，命令返回 `doctor_failed` 和退出码 `1`。

## HTTP 与安全边界

- 默认遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。
- 最多跟随 5 次重定向；跨 origin 重定向会移除鉴权、Cookie 和常见 token headers。
- 所有响应都执行流式字节上限，避免先完整缓冲超大响应。
- HTTP Extract 使用 LinkeDOM、Mozilla Readability、Turndown，并对 Next.js RSC payload 做后备解析。
- PDF、图片、音频、视频、zip 和通用二进制内容会返回 `unsupported_content`。
- 按项目设计，CLI 不阻止 localhost、私网地址或云元数据 URL。调用者必须在不可信输入场景中自行实施 URL allowlist、网络隔离或出站代理策略。

## 项目边界

本项目大量参考 `pi-web-access` 的 provider 和内容提取实现，但不包含 Pi-specific 注册、工具协议或 UI 代码。

许可证为 MIT，第三方与上游归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
