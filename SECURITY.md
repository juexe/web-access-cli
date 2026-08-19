# 安全策略

## 支持范围

| 版本 | 支持状态 |
| --- | --- |
| `0.2.x` | 支持 |
| `0.1.x` | 不再支持 |

## 私下报告漏洞

请通过 GitHub 的 [Private Vulnerability Reporting](https://github.com/Juexe/web-access-cli/security/advisories/new) 提交安全报告，不要创建公开 Issue。

报告应包含受影响版本或提交、复现步骤、实际影响和建议修复方式。请删除 API key、Cookie、Authorization header、私有 URL、响应正文中的个人信息以及其他敏感数据。

维护者会先确认报告和影响范围，再协调修复与披露；在修复公开前，请避免对外披露可利用细节。

## 已知安全边界

CLI 按设计允许访问 localhost、私网地址和云元数据 URL，以支持自托管 Provider。调用者必须对不可信 URL 实施 allowlist、网络隔离、防火墙或出站代理策略。仅重复这一已记录边界、且没有展示绕过其他安全保证的报告，不视为产品漏洞。

项目保证的安全边界包括响应大小限制、有限重定向、跨 origin 敏感 header 清理，以及可序列化输出中的 API key、自动注册凭据和 token 脱敏。相关绕过或敏感信息泄漏应按上述方式私下报告。
