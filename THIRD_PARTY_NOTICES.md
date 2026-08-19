# 第三方与上游声明

## pi-web-access

本项目的 provider 映射、HTTP 正文提取和 Next.js RSC 后备解析大量参考并部分改写自：

- 项目：`pi-web-access`
- 仓库：`https://github.com/nicobailon/pi-web-access.git`
- 参考提交：`00b2271d0f1603ac780df3f324aed0fc92f3e849`
- 参考版本：`0.20.0`
- Copyright 2025 Nico Bailon
- 许可证：MIT

上游 MIT 许可文本：

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Pi-specific 的工具注册、UI、Agent 生命周期与协议代码没有进入本项目。

## DeepSeek Harness web-search-deepseek

DeepSeek Search Provider 的 Anthropic-compatible Messages wire shape、结构化结果解析与 citation 映射参考并改写自：

- 项目：`deepseek-harness`
- 仓库：`https://github.com/deepseek-ai/deepseek-harness.git`
- 上游路径：`packages/web/web-search-deepseek`
- 参考提交：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Copyright 2026 DeepSeek
- 许可证：MIT（适用的许可文本与上文所列 MIT 文本相同）

动态 Settings、Credential Service、Session event、LLM seam 和 Agent 集成代码没有进入本项目。

## npm 依赖

发行包直接使用以下开源组件：

- `@mozilla/readability`：Apache-2.0
- `commander`：MIT
- `jsonc-parser`：MIT
- `linkedom`：ISC
- `open`：MIT
- `turndown`：MIT
- `typebox`：MIT
- `undici`：MIT
- `write-file-atomic`：ISC

开发依赖包括 Biome、tsx、TypeScript 及对应类型包。各组件的完整许可证和版权声明以随 npm 包发布的许可证文件及其上游仓库为准。本文件不替代任何第三方许可证。
