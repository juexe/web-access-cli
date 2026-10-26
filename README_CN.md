# web-access-cli

[English](README.md) | 简体中文

[![CI](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

同一核心上的两个入口：面向直接调用的 **CLI**，以及面向常驻 Agent 运行时的 **DeepSeek 兼容 HTTP 网关**。两者都提供搜索与正文提取两项能力，把 Tavily、Exa、Bocha、元宝搜索、Brave、SearXNG、AnySearch、XCrawl、DeepSeek、Firecrawl、Jina 等差异收敛到同一 schema。

两个入口都不绑定 Pi、Claude Code、Codex、Cursor、OpenCode 或其他 Agent；Skill、MCP 和 Agent 插件只是上层 adapter，不进入核心。要求 Node.js 22.19+。

## 能力

| 能力 | Provider 类型 | 规范化输出 |
| --- | --- | --- |
| `search` | Tavily、Exa、Bocha、元宝搜索、Brave、SearXNG、AnySearch、XCrawl、DeepSeek、xAI x_search、xAI web_search | `rank`、`title`、`url`、`snippet` |
| `extract` | Firecrawl v2、Jina Reader、Exa Contents、AnySearch、XCrawl、DeepSeek Fetch、HTTP | Markdown `Document` |

Provider 类型是具体实现，Provider 实例是该类型的一份配置，因此 `exa_team` 与 `exa_personal` 可以共存。每项能力都有主 `providers` 路由和 `providers_fallback` 路由，两者共同决定启用的实例和 `auto` 顺序。

## 安装

```sh
npm install --global web-access-cli    # 或 pnpm add --global web-access-cli
web-access --help
```

源码方式：`pnpm install --frozen-lockfile && pnpm check`。网关在同一份源码中运行（`node --import tsx src/server.ts`），构建后为 `pnpm start:gateway`；生产部署用 GHCR 上的镜像，Compose 模板与密钥约定见 [deploy/README.md](deploy/README.md)。

目录：`src/cli.ts` 与 `src/server.ts` 是两个入口，`src/gateway/` 承载工具协议，`src/core/`、`src/providers/`、`src/transport/` 由两者共用。Adapter 只做协议映射，回退、超时、envelope 和退出码都在 `src/core`。

## CLI

```sh
web-access search "TypeScript release" --provider exa --limit 10 --freshness month
web-access search "browser automation" --include-domain example.com --exclude-domain blocked.example.com
web-access extract https://example.com/article --provider http --timeout 30000
web-access extract https://example.com/article --json

web-access providers          # 路由、能力、凭据与 URL 状态
web-access doctor             # 仅本地配置检查，不联网
web-access config init        # 按凭据环境变量生成配置
web-access config edit        # 用 $VISUAL/$EDITOR 打开
```

通用选项：`--config <path>`、`--json`、`--help`、`--version`。能力命令输出面向人的 Markdown，`config init` 输出创建的文件路径，所有失败输出单个 JSON envelope。退出码：`0` 成功，`2` 输入/配置无效或 Provider 未启用，`1` 运行时或 doctor 失败，`130` 取消。

不提供 batch/all、answer、PDF 专线、Node SDK 或通用 MCP。另有一个可选的 [Agent Skill](skills/web-access-cli/SKILL.md)，仅供源码仓库使用，不进入 npm 包。

## HTTP 网关

常驻进程，用 [DeepSeek Search 与 Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search) 提供同一套 Provider、路由和传输：端点、鉴权头、请求字段和错误 envelope 均与官方一致，客户端只需改写 base URL，不改变 CLI 契约。

以 Docker 镜像方式运行：`ghcr.io/juexe/web-access-cli`，多架构 `linux/amd64` 与 `linux/arm64`，每次 GitHub Release 自动发布精确版本标签，正式版另加 `latest`。部署只需要 Docker，不需要 Node.js 或 pnpm：

```sh
docker pull ghcr.io/juexe/web-access-cli:0.7.0
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway
```

也可直接跑源码；默认监听 `127.0.0.1:8080`：

```sh
# 源码运行
WEB_ACCESS_CONFIG=~/.config/web-access-cli/config.json \
WEB_ACCESS_GATEWAY_API_KEY_FILE=/path/to/gateway-api-key \
node --import tsx src/server.ts
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tools/search` | 兼容 DeepSeek Search |
| `POST` | `/v1/tools/fetch` | 兼容 DeepSeek Fetch |
| `GET` | `/healthz`、`/readyz` | 存活与配置就绪，无需鉴权 |
| `GET` | `/panel` | 管理后台页面骨架，无需鉴权也不含数据 |
| `GET`/`DELETE` | `/admin/api/records` | 请求记录，需要 Bearer Key |
| `GET` | `/admin/api/overview` | 运行统计、路由就绪情况与各实例计数 |
| `PUT` | `/admin/api/config` | 修改路由、预算与实例；热生效并写回文件 |
| `POST` | `/admin/api/config/reload` | 从磁盘重载配置文件 |

- Bearer Key 只从文件读取，按定长摘要比较，并拒绝重复 `Authorization`。网关是私有单用户部署，不额外设本地并发闸门、请求体大小上限和读取超时，也不会自行产生 413/408。响应带 `Cache-Control: no-store`。
- 搜索字段：`query`（1–128 字符）、`count`（1–50，默认 10）、`ori_question`（非空时 1–128 字符）、`localization`（非空时须为 IP）、`need_content`（布尔，默认 `false`）。Fetch 只接受一个不超过 8192 字符的绝对 HTTP(S) URL。未知字段被忽略，不能覆盖 Provider、凭据、超时或配置。
- 响应只保证协议兼容，不等同官方引擎：`summary` 复用 `snippet`，`rerank_score` 恒为 `0`，`authority` 恒为 `-1`，`site_name`/`site_icon`/`date` 为 `null`。按分数或权威度过滤的客户端必须改策略，结果数量、排序和质量都不作承诺。
- `ori_question` 与 `localization` 只做校验，核心无对应能力，不会传给 Provider。
- `need_content=true` 按排名补抓：并发 2、总窗口 30 秒、单项 10 秒、单次尝试 3 秒；失败时保留结果、内容留空。补抓与响应都不设大小上限，且**补抓会消耗提取配额**。Fetch 与补抓派生自己的配置，正文阈值降为 1 字符以放行短页面；源站 Markdown 探测仍需 500 字符。客户端断开会取消在途工作。
- 错误固定为 `{ "error": { "message", "type": "…", "param": null, "code" } }`：400 `invalid_request_error`、401 `invalid_api_key`、402 `insufficient_quota`、404 `no_usable_content` 或未知路径、405 方法不允许、503 正在停止、504 `upstream_timeout`，500 表示 Provider、凭据或配置失败。429 只表示上游限流。
- 工具请求从不改写 Provider 顺序，也不触发配置写回。唯一写入方是后台「配置管理」工作区与 `/admin/api/config*`：热生效并原子写回，配置文件只读挂载时退化为仅内存生效。
- 面板在内存中保留最近 500 条记录：状态、耗时、错误、Provider、query/URL、尝试链路、摘要与截断正文预览（搜索结果 2 000 字符、Fetch 4 000 字符），从不含完整正文、header 或凭据。`#apikey=<key>` 片段可直接登录，脚本读取后立即从地址栏移除并存入 `sessionStorage`。

### 在 DSH 中直接使用

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）自带 `@deepseek-ai/dsh-web-deepseek-api`，说的正是这套 API，因此把 `web_search` 与 `web_fetch` 指过来不需要额外插件，只要一个 base URL。`~/.dsh/cordis.patch.yml`：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- id: web-deepseek-api
  name: "@deepseek-ai/dsh-web-deepseek-api"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY       # 这里要放网关 Key，不是 DeepSeek Key
    baseURL: http://127.0.0.1:8080/v1/tools
```

`baseURL` 写完整 API 基址，含路径前缀但不含 `/search` 或 `/fetch`；插件的 `apiKeyEnv` 默认取 `DEEPSEEK_API_KEY`，需让它指向存网关 Key 的变量。此后 `web_search` 与 `web_fetch` 走本网关，除上文提到的占位分数字段外无需其他改动。网关是私有部署，应放在可信网络内而不是直接暴露公网。

部署、密钥、升级与回滚见 [deploy/README.md](deploy/README.md)；架构决策见 [ADR 0019](docs/adr/0019-deepseek-tool-gateway.md)。

## 配置

严格 JSON，未知字段报错。解析顺序为 `--config`、`WEB_ACCESS_CONFIG`、`~/.config/web-access-cli/config.json`；默认路径缺失时使用内置默认值，显式路径缺失时返回 `config_error`，不扫描父目录。

`config edit` 在文件缺失时创建完整默认配置并用 `VISUAL`（其次 `EDITOR`）打开，不经 shell 解释、不重排内容；`config init` 按标准凭据环境变量生成配置且不覆盖已有文件。环境变量优先于明文 key。完整 schema 见 [schemas/config.schema.json](schemas/config.schema.json)：

```json
{
  "$schema": "https://unpkg.com/web-access-cli@0.7.0/schemas/config.schema.json",
  "providers": [
    { "id": "exa_team", "type": "exa", "apiKeyEnv": "TEAM_EXA_API_KEY" },
    { "id": "firecrawl_local", "type": "firecrawl", "baseUrl": "http://127.0.0.1:3002" }
  ],
  "search": { "providers": ["exa_team"], "providers_fallback": ["brave"] },
  "extract": { "providers": ["firecrawl_local"], "providers_fallback": ["http"] }
}
```

内置实例：`tavily`、`exa`、`bocha`、`yuanbao`、`brave`、`searxng`、`anysearch`、`xcrawl`、`deepseek`、`firecrawl`、`jina`、`http`、`xai_x_search`、`xai_web_search`。复用内置 ID 表示覆盖该实例，新 ID 表示新增同类型实例；只有写入路由的实例才会启用。默认路由：

- Search：`tavily -> exa -> bocha -> yuanbao -> brave -> searxng -> anysearch -> xcrawl -> deepseek`，回退 `xai_x_search -> xai_web_search`
- Extract：`firecrawl -> jina -> exa -> anysearch -> xcrawl -> deepseek`，回退 `http`

Search 主路由显式置空非法；Extract 可用空主路由关闭。AnySearch 与 XCrawl 支持 `searchFilterMode`：`strict`（遇 freshness 跳过）或 `best_effort`（把 freshness 改写成查询片段）。元宝向 `/SearchPro` 发送 `Query`/`Site`/`Freshness`，响应体内的错误仍可回退。DeepSeek 走 `/v1/tools/search` 与 `/v1/tools/fetch`，把 freshness 和域名改写为 `after:`/`site:` 提示并在本地再次过滤。xAI 每次调用读取 `XAI_AUTH_JSON` 中的 OAuth JSON 且不刷新，作主 Provider 时需调高 `attemptTimeoutMs`。

| 类型 | API key | Base URL |
| --- | --- | --- |
| Tavily / Exa / Brave / Firecrawl / XCrawl | `<NAME>_API_KEY` | `<NAME>_BASE_URL` |
| Bocha | `BOCHA_API_KEY` | `BOCHA_BASE_URL`，默认 `https://api.bocha.cn` |
| SearXNG | 无 | `SEARXNG_BASE_URL`，必填 |
| Jina / AnySearch | `JINA_API_KEY` / `ANYSEARCH_API_KEY`，可选 | `<NAME>_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | 固定 `https://api.deepseek.com` |
| xAI Search | `XAI_AUTH_JSON`（OAuth 文件） | 默认 `https://cli-chat-proxy.grok.com/v1`，`grok-4.6` |

自定义实例用 `apiKeyEnv`/`baseUrlEnv` 指定变量名，可设置 `baseUrl` 与 `headers`。公共 Firecrawl Cloud 需要 key，自托管 Firecrawl v2 不需要。

## 路由与限制

两个入口共用同一 Router，差异只在输出形态、单次命令选项，以及网关固定的 Fetch/补抓阈值。

`auto` 先走主路由，主组出现可回退失败后才进入回退路由。未完成配置的实例记录为失败并跳过；Provider 非 2xx 响应和可恢复错误（网络、超时、响应过大、无可用正文）继续下一个实例；无效输入和不支持内容立即停止；全部失败返回 `provider_exhausted`，最佳短正文保留在 `partial`。显式 `--provider` 只执行一次且不回退，不在路由中时返回 `provider_disabled`。`retryable` 描述同一 Provider 能否重试，不是切换条件。

`extract --provider auto` 在启用 HTTP 时先探测一个 Markdown 变体：文件型路径用 `.md`，目录用 `index.md`，只接受足够长的非 HTML 文本。未命中透明回退，命中记在 HTTP 实例名下且不改变顺序。

CLI 每次 `auto` 后，成功实例移到所在组队头，可回退失败的移到队尾，不跨组移动。Search 与 Extract 独立学习；显式实例、不可回退失败和取消都不改变顺序，写入原子且后者覆盖前者。网关从不改写路由。

默认限制：Search 总 120 秒、单次 60 秒；Extract 总 120 秒、单次 45 秒；单响应 5 MiB。`--timeout` 只覆盖本次总超时。

## 输出

能力命令输出 schema version 2。`--json` 时包含 `schemaVersion`、`ok`、最终实例和 `data`；失败附加紧凑 `error`、`attempts`（实例、错误码、可选状态码），可能有 `partial`。顺序写回失败时追加 `warnings`，不替换结果。面向人的输出为 Markdown：`provider` front matter 加编号结果列表或提取正文；诊断命令输出标题加 JSON。脚本应显式传 `--json`。

```json
{ "schemaVersion": 2, "ok": true, "provider": "exa",
  "data": { "results": [{ "rank": 1, "title": "Example", "url": "https://example.com/", "snippet": "..." }] } }
```

`providers` 报告每个实例的类型、能力、路由状态、凭据与 URL 来源，以及下次调用的有效顺序；启用路由中存在未配置实例时 `doctor` 返回 `1`。

## 安全边界

- 默认遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`；最多跟随五次重定向，跨 origin 时移除鉴权、Cookie 和 token 类 header。
- 响应按流限制 5 MiB，不先无界缓冲。HTTP 提取使用 LinkeDOM、Readability、Turndown，并带 RSC 后备；二进制与媒体返回 `unsupported_content`。
- 按设计两个入口都不阻止 localhost、私网地址或云元数据 URL。不可信场景需自行加 allowlist、网络隔离或出站策略；网关定位为 Bearer Key 之后的私有单用户部署。

## 范围

Provider 与提取实现大量取自 `pi-web-access`，不含 Pi 专用注册、工具协议和 UI。参见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)，MIT 许可，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
