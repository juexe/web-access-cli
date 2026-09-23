---
name: web-access-cli
description: 使用 web-access CLI 搜索实时网页信息、查找来源，并将指定 HTTP(S) 页面提取为 Markdown。用户需要联网搜索、核实近期信息、获取来源、阅读网页或提取网页正文时使用。
---

# web-access-cli

直接调用 `web-access` CLI。成功命令默认输出面向人的 Markdown；`search` 输出 YAML front matter 和编号结果列表，`extract` 输出 YAML front matter 和 Markdown 正文，诊断命令和 `config edit` 输出标题和格式化 JSON 数据，`config init` 输出新配置路径。所有失败始终输出 JSON。机器消费者必须显式追加 `--json` 以获取 schema v2 JSON envelope。

```sh
web-access search "query"
web-access extract "https://example.com"
web-access extract "https://example.com" --json
```

默认省略 `--provider`，由 CLI 先执行 `providers` 主 Route，只有主 Route 全部可回退失败后才执行 `providers_fallback`。只有用户明确指定 Instance，或自动调用失败后确认其他 Instance 可用时，才使用 `--provider <id>`。

调用失败后，可按需检查本地配置：

```sh
web-access providers
web-access doctor
web-access providers --json
web-access doctor --json
```

确认替代 Instance 已启用且适合当前能力后，可显式重试一次：

```sh
web-access search "query" --provider <id>
web-access extract "https://example.com" --provider <id>
web-access extract "https://example.com" --provider <id> --json
```

`auto` 通常已经尝试可回退的 Instance，并会在 Provider 返回最终非 2xx HTTP 响应时继续当前 Route；成功 Instance 会成为下次同组调用的首选，不会跨主轮和 fallback 移动。需要搜索过滤、数量或超时等选项时，运行 `web-access search --help` 或 `web-access extract --help`。

当 Extract Route 任一组启用了 HTTP Instance 时，`auto` 会先探测源站 Markdown 变体（文件路径追加 `.md`，目录路径使用 `index.md`）。只有返回足够长、非 HTML 的 Markdown/plain-text 正文时才直接使用；否则透明地继续原 Route。显式非 HTTP provider 不受影响，显式 HTTP 未命中后会照常提取原 URL。

配置了外部 xAI OAuth JSON 后，可使用默认 Search fallback 中的 `xai_web_search`/`xai_x_search`，或通过配置 Route 显式调整；两者读取 `XAI_AUTH_JSON`，不由 Skill 直接刷新凭据。

面向人的阅读直接运行 `extract <url>`；输出前置 YAML front matter，随后是 Markdown 正文。AnySearch Extract 使用 REST 响应的 `data.content` 字段作为正文，并使用 `data.title`/`data.url` 作为可用元数据，不输出完整 JSON 响应。

使用 `--json` 时，所有命令返回 schema v2 envelope：成功读取 `data` 和 `provider`（诊断命令为 `data` 与 `command`），失败读取 `error`，必要时读取精简 `attempts` 或 `partial`。任何失败始终返回 JSON failure envelope。若出现 `warnings[].code == "provider_order_update_failed"`，主要结果仍有效，但下次调用可能继续使用旧顺序。`providers`、`doctor` 和 `config edit` 的 Markdown 输出仅面向人类阅读，不应被解析。`config init` 已存在配置文件时不会覆盖；默认输出路径，追加 `--json` 获取 `config.init` envelope。`config edit` 使用非空 `VISUAL`，否则使用 `EDITOR`；值可包含带引号的命令路径和参数，不经 shell 解释，配置路径作为独立参数追加。两个变量都未设置或编辑器无法启动时返回 `open_failed`，命令只等待进程启动，不等待退出。

若 `web-access` 命令不存在，直接说明工具不可用；不要自动安装、构建或改用源码入口。
