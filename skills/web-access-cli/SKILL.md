---
name: web-access-cli
description: 使用 web-access CLI 搜索实时网页信息、查找来源，并将指定 HTTP(S) 页面提取为 Markdown。用户需要联网搜索、核实近期信息、获取来源、阅读网页或提取网页正文时使用。
---

# web-access-cli

直接调用 `web-access` CLI，并解析 stdout 的 JSON envelope。

```sh
web-access search "query"
web-access extract "https://example.com"
```

默认省略 `--provider`，由 CLI 使用 `auto` 路由和回退。只有用户明确指定 Instance，或自动调用失败后确认其他 Instance 可用时，才使用 `--provider <id>`。

调用失败后，可按需检查本地配置：

```sh
web-access providers
web-access doctor
```

确认替代 Instance 已启用且适合当前能力后，可显式重试一次：

```sh
web-access search "query" --provider <id>
web-access extract "https://example.com" --provider <id>
```

`auto` 通常已经尝试可回退的 Instance，并会在 Provider 返回最终非 2xx HTTP 响应时继续 Route，不要盲目重复请求。需要搜索过滤、数量或超时等选项时，运行 `web-access search --help` 或 `web-access extract --help`。

能力命令默认返回精简的 schema v2 envelope：成功读取 `data` 和 `provider`，失败读取 `error`，必要时读取精简 `attempts` 或 `partial`。不要在常规调用中使用 `--debug`；它只用于协议排障，会把 request、完整回退记录和脱敏 raw 放入嵌套 `debug` 对象。`providers`、`doctor` 和 `config edit` 仍返回详细诊断数据。

若 `web-access` 命令不存在，直接说明工具不可用；不要自动安装、构建或改用源码入口。
