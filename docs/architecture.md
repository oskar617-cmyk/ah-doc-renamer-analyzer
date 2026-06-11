# AH Doc Renamer Analyzer — 架构与升级规程

## 部署机制(红线)
- Cloudflare 原生 Git 集成:push 到 main 即自动部署上线
- URL:https://ah-doc-renamer-analyzer.oskar617.workers.dev
- 根目录 `wrangler.toml` = Worker 标记;绝不转 Pages、绝不改部署方式
- Secrets 存 Cloudflare 端,不进代码、不进 git

## Contract 概要(以代码为准)
- 服务对象:`ah-doc-renamer` PWA(contract 锁定于其 `js/classify.js`);模型 `gemini-3.1-flash-lite`(免费 tier)
- 输入:候选 docType 列表 + extracted text + 首页渲染图;支持 few-shot `examples`
- 输出:docType(限候选列表内)+ note + detectedAddress + detectedJobCode
- `?selftest=1` 诊断端点;`VERSION` 常量现为 v0.04
- Prompt 原则(v0.04):content-first,优先读 title block,图优先于稀疏文本,文件名只是常错的弱提示

## 升级规程(每次改动必须走完,顺序不可乱)
1. 先读对面 PWA 端的 contract 代码,确认当前真实 request / response 形状,再设计改动
2. 改动尽量向后兼容(新增字段而非改名/删除);确实不兼容时,部署顺序锁定:Worker 先上(兼容新旧两种请求)→ PWA 后上 → 下个版本再清理兼容层
3. bump `worker.js` 的 `VERSION` 常量 + 顶部版本史注释
4. push 前本地验证(`wrangler dev` 或诊断端点 / curl 模拟请求),把验证结果给 Oskar 看
5. **push = 部署上线**。必须 Oskar 明确同意本次 push 才执行,每次单独问
6. Contract 变更同步更新本文档和 PWA repo 的对应文档

## 首次动工任务
本文档的 contract 细节是概要。第一次接手本 repo 时:通读 `worker.js` 与 PWA 端调用代码,把完整 request / response schema、错误格式、CORS 行为补全进本文档(读代码提取,不编造),然后 commit。
