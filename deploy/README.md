# DeepSeek 兼容网关部署指南

本目录说明如何用 Docker Compose 运行 `web-access-cli` 的 DeepSeek Search/Fetch 兼容网关。网关复用本机已配置的 provider、路由和传输实现，只面向可信内网客户端。

## 目录约定

公开部署配置都在本目录：

```text
deploy/
├── compose.yaml          # Compose 定义（构建上下文为仓库根）
├── .env.example          # 非敏感部署变量模板
├── config.example.json   # provider 配置模板（占位 Key）
└── README.md             # 本文件
```

私有部署资料放在仓库根的 `personal/`（已被 `.gitignore` 忽略，且不在 Docker 构建白名单内），例如 `personal/secrets/gateway-api-key`、`personal/secrets/provider-config.json`、`personal/deploy.env`。不要把真实凭据放进 `deploy/`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/tools/search` | DeepSeek Search 兼容 |
| `POST` | `/v1/tools/fetch` | DeepSeek Fetch 兼容 |
| `GET` | `/healthz` | 进程存活，无需鉴权 |
| `GET` | `/readyz` | 配置/生命周期就绪，无需鉴权 |

除健康检查外，所有请求必须带且仅带一个 `Authorization: Bearer <gateway key>`，`Content-Type` 必须是 `application/json`（可带 UTF-8 charset）。

```json
{
  "query": "DeepSeek V4",
  "count": 10,
  "ori_question": "DeepSeek V4 有什么更新",
  "localization": "192.168.3.3",
  "need_content": false
}
```

成功响应只有 `results`，每个结果固定十个字段：

```json
{
  "results": [
    {
      "rerank_score": 0,
      "title": "...",
      "url": "https://example.com/a",
      "snippet": "...",
      "summary": "... 与 snippet 相同",
      "content": "",
      "site_name": null,
      "site_icon": null,
      "date": null,
      "authority": -1
    }
  ]
}
```

错误统一为 `{ "error": { "message": "...", "type": "...", "param": null, "code": "..." } }`。

## 已知兼容限制（务必阅读）

- `rerank_score` 恒为 `0`，`authority` 恒为 `-1`，`site_name`/`site_icon`/`date` 恒为 `null`。**这些占位值不是 DeepSeek 的质量评分**。依赖 `rerank_score >= 1.5` 或 `authority >= 3` 筛选的客户端必须调整策略，否则会过滤掉全部结果。
- `summary` 直接复制 `snippet`，不生成 600–800 字长摘要；`snippet` 长度取决于上游 provider。
- 不保证结果数量（可能少于 `count`）、排序或摘要质量与官方一致；不重新分页，也不跨 provider 凑数。
- `ori_question` 与 `localization` 会被接受并校验，但当前中立核心没有对应能力，**不会**影响 provider 请求，也不会拼进 `query`。
- `count` 接受 1–50；CLI 与配置文件的 limit 上限仍是 20。各 provider 还会按上游能力进一步限制出站数量（Tavily 20、Brave 20、AnySearch 10、XCrawl 带域名过滤时 `max(20, count)`）。
- 网关不写回 provider 顺序：服务运行期间使用启动时加载的配置快照，重启后才会读取磁盘上的新顺序。

## 正文补抓

仅当 `need_content=true` 时才补抓正文：

- 按结果排名顺序调度，最多两路并发，总预算 30 秒，单篇最多 10 秒。
- 补抓阶段每次 provider 尝试最多 3 秒，让失败后还有机会尝试其他 provider。这是尽力补抓的取舍。
- 失败、超时、未调度完成或超限的正文一律留空，结果本身保留。
- 单篇正文的 JSON 编码后 UTF-8 大小最多 256 KiB；完整响应最多 8 MiB，超限时从低排名起清空 `content`；仍超限则返回固定的小型 500，不截断正文也不丢结果。
- **补抓会消耗 extract 上游额度。** `need_content` 请只在确实需要正文时开启。

短正文：网关为 Fetch 和补抓派生了自己的配置，正文最短阈值降为 1 个字符，因此有效的短页面会成功。但源站 `.md` 猜测仍要求至少 500 字符（或原配置阈值，取较大者），避免短小的 `Not found` 页面误命中。

## 错误映射

| 情况 | HTTP | type / code |
| --- | --- | --- |
| JSON、请求头或字段不合法 | 400 | `invalid_request_error` / `invalid_request_error` |
| 网关 Bearer 缺失、无效或重复 | 401 | `authentication_error` / `invalid_api_key` |
| 云 provider 额度不足 | 402 | `insufficient_quota` / `insufficient_quota` |
| Fetch 无可用正文、类型不支持、直连目标不可用 | 404 | `not_found_error` / `no_usable_content` |
| 读取请求体超时 | 408 | `timeout_error` / `request_timeout` |
| 请求体超过限制 | 413 | `invalid_request_error` / `request_too_large` |
| 本地并发满或上游限流 | 429 | `rate_limit_error` / `rate_limit_exceeded`（带 `Retry-After`） |
| 下游超时 | 504 | `timeout_error` / `upstream_timeout` |
| 云 provider 凭据/配置错误、无可用 provider、最终输出超限等 | 500 | `server_error` / 细分 code |
| 未知路由 | 404 | `invalid_request_error` / `not_found` |
| 已知接口错误方法 | 405 | `invalid_request_error` / `method_not_allowed`（带 `Allow`） |

目标站点的 401/403/404 属于 Fetch 不可用，不会误报为网关认证错误；云 provider 的 401/403 返回 500。

## 快速开始

```sh
# 1. 准备私有配置与密钥（放在 personal/，不要提交）
mkdir -p personal/secrets
cp deploy/config.example.json personal/secrets/provider-config.json
openssl rand -hex 32 > personal/secrets/gateway-api-key
chmod 700 personal/secrets && chmod 600 personal/secrets/*

# 2. 准备非敏感部署变量
cp deploy/.env.example personal/deploy.env
# 按需设置 WEB_ACCESS_BIND / WEB_ACCESS_IMAGE；secret 默认指向 ../personal/secrets/

# 3. 校验、构建、启动（-f 指定 deploy/compose.yaml）
docker compose -f deploy/compose.yaml --env-file personal/deploy.env config --quiet
docker compose -f deploy/compose.yaml --env-file personal/deploy.env build gateway
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway
```

请求示例：

```sh
curl -sS -X POST http://192.168.3.3:18180/v1/tools/search \
  -H "Authorization: Bearer $(cat personal/secrets/gateway-api-key)" \
  -H "Content-Type: application/json" \
  -d '{"query":"example","count":3}'
```

`deploy/compose.yaml` 默认把端口发布到 `127.0.0.1:18180`，此时只能从宿主机访问。需要从局域网访问时，把 `WEB_ACCESS_BIND` 设为 `192.168.3.3:18180`（只写端口部分，容器内端口固定为 8080）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WEB_ACCESS_CONFIG` | provider 配置路径；容器内指向只读挂载的 secret |
| `WEB_ACCESS_GATEWAY_API_KEY_FILE` | 网关密钥文件路径；只从文件读取，拒绝空值、少于 12 字符、含空白或控制字符的值 |
| `WEB_ACCESS_GATEWAY_HOST` | 监听地址，独立运行默认 `127.0.0.1`，Compose 设为 `0.0.0.0` |
| `WEB_ACCESS_GATEWAY_PORT` | 监听端口，独立运行默认 `8080` |
| `WEB_ACCESS_IMAGE` | Compose 使用的本地镜像标签 |
| `WEB_ACCESS_BIND` | 宿主发布地址，默认 `127.0.0.1:18180` |
| `WEB_ACCESS_SECRET_PROVIDER_CONFIG` | provider 配置 secret 的宿主路径 |
| `WEB_ACCESS_SECRET_GATEWAY_KEY` | 网关密钥 secret 的宿主路径 |

网关容器只拿到这几个变量，不继承宿主上其他 provider 环境变量；所有凭据都通过运行时只读 secret 提供。

## 容器约束

- 非 root 运行（UID/GID 1000:1000），`read_only` 根文件系统，`cap_drop: ALL`，`no-new-privileges`。
- `/tmp` 为 64 MiB tmpfs，`pids_limit 128`，`mem_limit 768m`，`cpus 2`。
- `init: true`、`restart: unless-stopped`、`stop_grace_period: 15s`。
- 日志 `json-file`，每文件 10 MiB，最多 3 个；日志只包含方法、固定路由、状态、耗时、请求 ID 和错误码。
- 健康检查用镜像内已有的 Node 请求 `/readyz`，不额外安装 curl。
- 镜像不包含 `.env`、provider 配置、密钥或 `personal/` 目录；secret 只在运行时挂载。

## 诊断

```sh
# 存活与就绪
curl -fsS http://192.168.3.3:18180/healthz
curl -fsS http://192.168.3.3:18180/readyz

# 无 Key 必须返回 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://192.168.3.3:18180/v1/tools/search \
  -H 'Content-Type: application/json' -d '{"query":"x"}'

# 容器状态与日志中的错误码
docker compose -f deploy/compose.yaml --env-file personal/deploy.env ps gateway
docker compose -f deploy/compose.yaml --env-file personal/deploy.env logs --tail 50 gateway
```

`/readyz` 返回 503 表示对应能力的 primary+fallback 路由中没有任何已配置 adapter，通常是 provider 配置或 secret 挂载问题，不是上游实时故障。进程启动时同样要求两个能力各至少有一个已配置 adapter，否则直接退出码 1 并记录 `startup_failed`。健康检查不调用付费 API。

## 升级与回滚

```sh
# 记录当前版本
docker image inspect --format '{{.Id}}' web-access-cli:local

# 升级：重新构建并重启（配置快照会重新加载）
docker compose -f deploy/compose.yaml --env-file personal/deploy.env build gateway
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway

# 回滚：恢复记录的本地镜像标签后重新 up
docker tag <previous-image-id> web-access-cli:local
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway
```

首次部署回滚只需 `docker compose -f deploy/compose.yaml --env-file personal/deploy.env down`，保留配置和密钥文件。不要执行全局 `prune`、`down -v`、批量重启其他服务或递归修改权限。

## 测试

```sh
pnpm test:docker   # 离线 Compose 验收：fixture provider、假 Key、动态生成的临时配置
pnpm check         # lint + typecheck + 全量测试 + build
pnpm pack:check    # npm 打包检查
```

`test:docker` 使用独立项目名和临时目录，只清理本次明确命名的项目、镜像与临时文件，不访问真实 provider，也不使用真实凭据。
