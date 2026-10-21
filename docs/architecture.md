# AH Doc Renamer Analyzer — 架构与升级规程

## 部署机制(红线)
- Cloudflare 原生 Git 集成:push 到 main 即自动部署上线
- CF 名:`ah-doc-renamer-worker-analyzer`;URL:https://ah-doc-renamer-worker-analyzer.oskar617.workers.dev
- 2026-10-22 原地改名，Worker ID `44e4c2f42d8244098cfbf44677660659` 不变；GitHub repo / 本地目录保留 `ah-doc-renamer-analyzer`。先按固定 ID 改 CF 名，再 push 新 wrangler name，防止误建第二个 Worker；PWA 同批发布新地址，旧页面需刷新。
- 根目录 `wrangler.toml` = Worker 标记;绝不转 Pages、绝不改部署方式
- Secrets 存 Cloudflare 端,不进代码、不进 git

## Contract 概要(以代码为准)
- 服务对象:`ah-doc-renamer` PWA(contract 锁定于其 `js/classify.js`);模型 `gemini-3.1-flash-lite`(免费 tier)
- 输入:候选 docType 列表 + extracted text + 首页渲染图;支持 few-shot `examples`
- 输出:docType(限候选列表内)+ note + detectedAddress + detectedJobCode
- `?selftest=1` 诊断端点须通过与分类相同的鉴权/准入/限流;公共 GET 仅做无 AI 的 liveness。
- 完整 HTTP contract、配置、错误码与限额见 README.md；JSON 分类字段保持不变，新增必要的 API Authorization header。
- Prompt 原则(v0.04):content-first,优先读 title block,图优先于稀疏文本,文件名只是常错的弱提示

## 升级规程(每次改动必须走完,顺序不可乱)
1. 先读对面 PWA 端的 contract 代码,确认当前真实 request / response 形状,再设计改动
2. 普通 contract 变更尽量向后兼容；安全门禁例外:先配置 Entra/Secret，再上受保护 Worker → PWA 随即更新。旧页面须刷新/重新登录，绝不保留匿名兼容路径；回退也不得撤销安全门禁。
3. bump `worker.js` 的 `VERSION` 常量 + 顶部版本史注释
4. push 前本地验证(`wrangler dev` 或诊断端点 / curl 模拟请求),把验证结果给 Oskar 看
5. **push = 部署上线**。必须 Oskar 明确同意本次 push 才执行,每次单独问
6. Contract 变更同步更新本文档和 PWA repo 的对应文档

## 模块与边界
- `worker.js` 路由/契约校验;`auth.js` JWT/OBO/准入/限流;`analyzer.js` 原 Gemini 提示词与结果转换;`security-http.js` 有界读取与 deadline。
- 无 DB、无权限缓存、无持久文档；只读原 allowed-users.json，不创建文件夹，不实施真实重命名/归档，不整合 AH Files。
- 只有固定 Microsoft / Graph / SharePoint / Gemini 出站目标；OBO 与 AI secret 分离，任何依赖出错均 fail closed，日志不打印业务数据与上游原始错误。
