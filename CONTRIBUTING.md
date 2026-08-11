# 贡献指南

感谢你考虑为 `web-access-cli` 做贡献。项目接受 Bug 报告、功能建议和 Pull Request；请保持改动聚焦、可验证，并避免把特定 Agent 的生命周期或协议耦合到 CLI 核心。

## 开发环境

- Node.js 22.19 或更高版本
- pnpm 11.16

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

源码调试使用 `node --import tsx src/cli.ts <command>`。Provider 测试应使用 mock transport 或本地 HTTP server，不依赖真实 API key 和外网稳定性。

## 提交改动

1. 先创建 Issue 说明较大的功能、公共契约或行为变更；小型修复可以直接提交 Pull Request。
2. 新增或修改的项目说明、注释和文档默认使用简体中文；已有明确语言风格的文件保持原有风格。
3. 修改公共请求、响应、Schema 或 CLI 行为时，同步 TypeScript 类型、TypeBox Schema、生成的 `schemas/`、中英文 README 和相应测试。
4. 修改 Provider 协议时使用 mock transport 断言请求和规范化结果；修改 transport 或 CLI 进程行为时使用本地服务或子进程测试。
5. 不要提交真实凭据、本地配置、调试日志、构建产物或上游参考快照。

## Pull Request 检查清单

- `pnpm check` 和相关测试通过。
- `pnpm pack:check` 的发布清单不包含 `skills/`、`temp/`、本地说明或配置。
- 生成的 JSON Schema 与源码一致，没有遗漏预期差异。
- stdout 单 JSON、退出码、fallback、`attempts`、`partial`、`raw` 和脱敏行为未被意外破坏。
- Pull Request 描述说明了改动目的、验证方式和任何兼容性影响。

安全问题不要提交公开 Issue，请遵循 [SECURITY.md](SECURITY.md)。
