# DeepSeek 兼容网关部署指南

本目录说明如何用 Docker 运行 `web-access-cli` 的 DeepSeek Search/Fetch 兼容网关。镜像由 `.github/workflows/image.yml` 在 GitHub Release 发布时构建并推送到 GHCR，也可在 Actions 里对该工作流手动 `Run workflow` 并填已发布的标签来补发或重建。部署只需要拉镜像，不必在宿主机上装 Node.js 或 pnpm。网关复用已配置的 provider、路由和传输实现，只面向可信内网客户端。

## 镜像

| 项目 | 值 |
| --- | --- |
| 镜像 | `ghcr.io/juexe/web-access-cli` |
| 标签 | `0.7.0` 等精确版本；正式 Release 另加 `latest`，prerelease 只有版本标签 |
| 架构 | `linux/amd64`、`linux/arm64` |
| 入口 | `node dist/server.js`，容器内监听 `0.0.0.0:8080` |
| 用户 | UID/GID `1000:1000`，只读根文件系统下运行 |

首次发布后需在 GitHub 的 package 设置里把可见性改为 public，在此之前下载需要 `docker login ghcr.io`。生产环境请固定精确版本标签，不要用 `latest`。

```sh
docker pull ghcr.io/juexe/web-access-cli:0.7.0
```

## 目录约定

公开部署配置都在本目录：

```text
deploy/
├── compose.yaml          # Compose 定义（直接拉取 GHCR 镜像）
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
| `GET` | `/`、`/panel` | 网关管理后台（HTML，无需鉴权，页面本身不含数据） |
| `GET` | `/admin/api/records` | 最近请求记录 JSON（支持 `limit/route/status/provider/q` 筛选，需 Bearer Key） |
| `DELETE` | `/admin/api/records` | 清空内存请求记录（需 Bearer Key） |
| `GET` | `/admin/api/overview` | 网关运行状态、Doctor 诊断、路由与 Provider 统计（需 Bearer Key） |
| `POST` | `/admin/api/stats/reset` | 重置 Provider 运行时累计统计（需 Bearer Key） |
| `PUT` | `/admin/api/config` | 在线更新路由、超时参数与 Provider 配置并热切换（需 Bearer Key） |
| `POST` | `/admin/api/config/reload` | 从磁盘重新加载配置文件并热切换（需 Bearer Key） |
| `GET` | `/healthz` | 进程存活，无需鉴权 |
| `GET` | `/readyz` | 配置/生命周期就绪，无需鉴权 |

除健康检查外，所有请求必须带且仅带一个 `Authorization: Bearer <gateway key>`，`Content-Type` 必须是 `application/json`（可带 UTF-8 charset）。

```json
{
  "query": "DeepSeek V4",
  "count": 10,
  "ori_question": "DeepSeek V4 有什么更新",
  "localization": "192.168.1.10",
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
- `count` 接受 1–50；CLI 与配置文件的 limit 上限仍是 20。各 provider 还会按上游能力进一步限制出站数量（Tavily 20、Brave 20、AnySearch 10、元宝搜索按 10 向上取整且上限 50、XCrawl 带域名过滤时 `max(20, count)`）。
- 工具请求不自动改写 provider 顺序：并发搜索/抓取不会触发配置写回；管理员可通过后台「配置管理」或 `/admin/api/config*` 手动调整路由、保存写回或从磁盘热重载。

## 正文补抓

仅当 `need_content=true` 时才补抓正文：

- 按结果排名顺序调度，最多两路并发，总预算 30 秒，单篇最多 10 秒。
- 补抓阶段每次 provider 尝试最多 3 秒，让失败后还有机会尝试其他 provider。这是尽力补抓的取舍。
- 失败、超时或未调度完成的正文一律留空，结果本身保留。
- 补抓正文与完整响应都**不设大小上限**，长页面原样返回。
- **补抓会消耗 extract 上游额度。** `need_content` 请只在确实需要正文时开启。

短正文：网关为 Fetch 和补抓派生了自己的配置，正文最短阈值降为 1 个字符，因此有效的短页面会成功。但源站 `.md` 猜测仍要求至少 500 字符（或原配置阈值，取较大者），避免短小的 `Not found` 页面误命中。

## 错误映射

| 情况 | HTTP | type / code |
| --- | --- | --- |
| JSON、请求头或字段不合法 | 400 | `invalid_request_error` / `invalid_request_error` |
| 网关 Bearer 缺失、无效或重复 | 401 | `authentication_error` / `invalid_api_key` |
| 云 provider 额度不足 | 402 | `insufficient_quota` / `insufficient_quota` |
| Fetch 无可用正文、类型不支持、直连目标不可用 | 404 | `not_found_error` / `no_usable_content` |
| 上游 provider 限流 | 429 | `rate_limit_error` / `rate_limit_exceeded`（带 `Retry-After`） |
| 下游超时 | 504 | `timeout_error` / `upstream_timeout` |
| 云 provider 凭据/配置错误、无可用 provider 等 | 500 | `server_error` / 细分 code |
| 未知路由 | 404 | `invalid_request_error` / `not_found` |
| 已知接口错误方法 | 405 | `invalid_request_error` / `method_not_allowed`（带 `Allow`） |

网关是私有单用户部署，**不设本地并发闸门、请求体大小上限或请求体读取超时**：并发只受上游 provider 与进程本身约束，入站请求不会再触发 413/408，也不会因网关自身并发返回 429（429 只来自上游 provider 限流）。

目标站点的 401/403/404 属于 Fetch 不可用，不会误报为网关认证错误；云 provider 的 401/403 返回 500。

## 快速开始

```sh
# 1. 准备私有配置与密钥（放在 personal/，不要提交）
mkdir -p personal/secrets
cp deploy/config.example.json personal/secrets/provider-config.json
openssl rand -hex 32 > personal/secrets/gateway-api-key
chmod 700 personal/secrets && chmod 600 personal/secrets/*

# 2. 准备非敏感部署变量；把 WEB_ACCESS_IMAGE 固定到要部署的版本
cp deploy/.env.example personal/deploy.env
# secret 默认指向 ../personal/secrets/，随 -f deploy/compose.yaml 的上下文解析

# 3. 拉取并启动
docker compose -f deploy/compose.yaml --env-file personal/deploy.env config --quiet
docker compose -f deploy/compose.yaml --env-file personal/deploy.env pull gateway
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway
```

请求示例：

```sh
curl -sS -X POST http://192.168.1.10:18180/v1/tools/search \
  -H "Authorization: Bearer $(cat personal/secrets/gateway-api-key)" \
  -H "Content-Type: application/json" \
  -d '{"query":"example","count":3}'
```

`deploy/compose.yaml` 默认把端口发布到 `127.0.0.1:18180`，此时只能从宿主机访问。需要从局域网访问时，把 `WEB_ACCESS_BIND` 设为 `192.168.1.10:18180`（只写端口部分，容器内端口固定为 8080）。

## 网关管理后台

浏览器打开 `http://192.168.1.10:18180/panel`（或直接打开 `/`），输入网关 API Key 即可使用管理后台。后台包含三个工作区：

1. **请求记录**：实时查看最近 500 条已鉴权工具请求，支持按能力、状态、Provider（含回退链路与补抓链路）及关键词筛选；展开可查看完整 Provider 尝试链（`attempts`）、`need_content` 补抓明细、搜索结果摘要（`snippet`）以及截断后的 Markdown 正文预览（`contentPreview`），支持一键复制、导出 JSON 与清空记录。
2. **路由与统计**：展示网关运行健康度、`doctor` 本地诊断、Search/Extract 主备路由拓扑，以及各 Provider 实例的配置来源与运行时累计调用次数、成功率、平均耗时和错误码分布（支持重置统计）。
3. **配置管理**：可视化编排 Search/Extract 主轮与 fallback 顺序、调整超时与阈值参数、新增/编辑/删除 Provider 实例（密码框留空保持原密钥不变，从不回传明文 Key）。点击「保存并应用」时先校验路由就绪，再尝试原子写入或原地覆写配置文件；若容器以只读 secret 挂载配置文件，修改仍会在当前进程内存中立即生效并给出只读提示，也支持随时「从磁盘重载」。

安全与存储说明：

- 请求记录与累计统计保存在内存中，进程或容器重启后清空；未鉴权探测（401）只写入 stderr 日志，不会冲刷面板记录。
- 面板 HTML 本身是公开静态页面，不含业务数据；所有 `/admin/api/*` 接口均复用网关 Bearer Key，且响应绝不包含任何 Provider API Key 明文。
- 可以直接用书签链接 `http://192.168.1.10:18180/panel#apikey=<key>` 打开：Key 放在 fragment 中，不会发送给服务器，也不出现在 `Referer`；脚本读到后会立刻从地址栏和历史记录中移除它，并写入 `sessionStorage`。**不要用 `?apikey=`**，查询串会进入服务器日志、代理日志和浏览器历史。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WEB_ACCESS_CONFIG` | provider 配置路径；容器内指向只读挂载的 secret |
| `WEB_ACCESS_GATEWAY_API_KEY_FILE` | 网关密钥文件路径；只从文件读取，拒绝空值、少于 12 字符、含空白或控制字符的值 |
| `WEB_ACCESS_GATEWAY_HOST` | 监听地址，独立运行默认 `127.0.0.1`，Compose 设为 `0.0.0.0` |
| `WEB_ACCESS_GATEWAY_PORT` | 监听端口，独立运行默认 `8080` |
| `WEB_ACCESS_IMAGE` | Compose 使用的镜像，默认 `ghcr.io/juexe/web-access-cli:latest`；生产固定到精确版本号 |
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
curl -fsS http://192.168.1.10:18180/healthz
curl -fsS http://192.168.1.10:18180/readyz

# 无 Key 必须返回 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://192.168.1.10:18180/v1/tools/search \
  -H 'Content-Type: application/json' -d '{"query":"x"}'

# 容器状态与日志中的错误码
docker compose -f deploy/compose.yaml --env-file personal/deploy.env ps gateway
docker compose -f deploy/compose.yaml --env-file personal/deploy.env logs --tail 50 gateway
```

`/readyz` 返回 503 表示对应能力的 primary+fallback 路由中没有任何已配置 adapter，通常是 provider 配置或 secret 挂载问题，不是上游实时故障。进程启动时同样要求两个能力各至少有一个已配置 adapter，否则直接退出码 1 并记录 `startup_failed`。健康检查不调用付费 API。

## 升级与回滚

```sh
# 记录当前部署的版本
docker compose -f deploy/compose.yaml --env-file personal/deploy.env images gateway

# 升级：改 personal/deploy.env 的 WEB_ACCESS_IMAGE 到新版本号后重拉重启
docker compose -f deploy/compose.yaml --env-file personal/deploy.env pull gateway
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway

# 回滚：把 WEB_ACCESS_IMAGE 改回旧版本号，重复上面两条命令
```

升级和回滚都不重建镜像，所以回滚到任意已发布版本都只需改一个环境变量。配置文件的挂载与密钥不受影响。

从仓库源码构建镜像（仅在开发或验证未发布改动时）：

```sh
docker build -t web-access-cli:dev .
WEB_ACCESS_IMAGE=web-access-cli:dev \
  docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway
```

`WEB_ACCESS_IMAGE` 只是 Compose 的镜像名覆盖，`pull` 对本地构建的标签无效，所以源码调试时直接 `up`，不要 `pull`。

首次部署回滚只需 `docker compose -f deploy/compose.yaml --env-file personal/deploy.env down`，保留配置和密钥文件。不要执行全局 `prune`、`down -v`、批量重启其他服务或递归修改权限。

## 测试

```sh
pnpm test:docker   # 离线 Compose 验收：fixture provider、假 Key、动态生成的临时配置
pnpm check         # lint + typecheck + 全量测试 + build
pnpm pack:check    # npm 打包检查
```

`test:docker` 使用独立项目名和临时目录，只清理本次明确命名的项目、镜像与临时文件，不访问真实 provider，也不使用真实凭据。
