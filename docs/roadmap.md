# AH Doc Renamer Analyzer — 状态与待办

## 已知状态
- v0.07：修复 Node 与 Cloudflare workerd 的 redirect API 差异；保持拒绝跳转、不转发凭据。15 组回归与原生 workerd 真实 Microsoft/OBO 验证通过；消费端仍为 v0.9.5，无 JSON contract 变化。
- v0.06：与 PWA v0.9.5 配套，Microsoft API token 验签、delegated OBO 准入、IP/用户限流和有界请求已实现；真实登录/OBO 与 14 组安全回归通过。匿名 self-test 不再允许；模型、文件夹和分类输出字段不变。
- v0.05：CF 名称改为 `ah-doc-renamer-worker-analyzer`，与 PWA v0.9.4 新地址配套；沿用现有 Worker ID、密钥、Gemini 模型与分类 contract。repo / 本地目录不改名。
- v0.04 content-first prompt 保持不变。

## 待办
- 在 2027-04-20 到期前更新 `ah-doc-renamer-analyzer-obo` 与 CF `ENTRA_CLIENT_SECRET`；凭据只在本机 secrets / CF，不进 repo。过期时失败关闭，不恢复匿名访问。
- 不启用正式文件写入、不改业务文件夹、不整合 AH Files；后续功能等待 Oskar 指示。
