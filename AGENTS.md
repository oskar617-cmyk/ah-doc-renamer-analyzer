# ah-doc-renamer-analyzer Agent Rules(纯 Cloudflare Worker)

## 1. Identity
- 代理 Gemini 的 Worker,AH Doc Renamer 的 AI 大脑:输入候选 docType 列表 + 文本 + 首页图,输出分类 + note + detectedAddress / detectedJobCode;支持 few-shot `examples`。
- 技术特征:Uses MSAL: no · Deploy target: Cloudflare Worker(**纯 Worker:push 即上线、无 staging——push/deploy 逐次先问 Oskar**)· PWA: no。

## 2. Read First
1. `docs/`(如有)与 `worker.js` 头部注释
2. 消费端 contract:ah-doc-renamer repo 的 `js/classify.js`

## 3. Current Snapshot
`worker.js` 内 VERSION(交接时 v0.04;以实际值为准)。模型 `gemini-3.1-flash-lite`(免费 tier)。(替换制。)

## 4. Hard Rules
- **Contract 锁定于 PWA 的 `js/classify.js`:两边同步改**,单边改 = 破坏。
- 根目录 `wrangler.toml` = Worker 标记,绝不跑 Pages 转换。
- Prompt 原则(v0.04):content-first,优先读 title block,图优先于稀疏文本,文件名只是常错的弱提示。

## 5. Architecture And Data Boundaries
单 worker.js;secrets 在 Cloudflare 端(GEMINI_API_KEY 等);无持久数据。

## 6. Commands
- URL:https://ah-doc-renamer-analyzer.oskar617.workers.dev;诊断端点 `?selftest=1`。
- 部署:Cloudflare 原生 Git 集成——**push 到 main 即自动部署上线**(所以 push 前逐次问)。
- GitHub repo:github.com/oskar617-cmyk/ah-doc-renamer-analyzer(private)。

## 7. Verification And Release
改完先问 Oskar → push(即上线)→ `?selftest=1` 验证 → 通知消费端 repo 核对 contract。

## 8. Multi-Agent Conflict Hotspots
- contract(输入/输出 shape)与 ah-doc-renamer 联动:跨 repo 先协调。

## 9. Shared Rulesets
(AH-PWA-MSAL 不适用:本 repo 非 PWA、无 MSAL。)

<!-- SHARED-RULESET:AH-SUITE VERSION:2 UPDATED:2026-07-28 -->
- 套件:Auzzie Homes Pty Ltd(墨尔本建筑公司)内部工作 app 套件;各 app 经 jobCode 互联;**`ah-jobs-rego` 是全套件 job 数据唯一 source of truth,任何 app 不得自建 job list**。
- SharePoint 拓扑(锁定):所有 Lists 在 AH Site(`auzziehomes.sharepoint.com/sites/AHSite`);文件/文件夹留各自原站(默认 AHOffice)。List 命名 `[App Name] [Purpose] List`(空格分隔、无连字符);config 存确切字符串,读其他 app 的 List 必须逐字一致。
- 单一 Entra tenant `ff968505-cca0-4cd1-9f6d-68ce6eaf06c7`;one app one registration;admin `oskar@auhs.com.au`。
- 本地测试连的是**真 SharePoint 数据**:测试 job 用明显 TEST 名,测完删除。
- AI 功能默认经 Cloudflare Worker 代理调用(模型 key 不写进前端代码;用户在设置里自带 key 的 Direct 模式除外)。
- 套件踩坑库 = ah-files repo 的 `docs/LESSONS.md`(L 编号);动工前读一遍,踩到 >30 分钟的架构坑必须加一条(在只见本 repo 的环境读不到时,请 Oskar 提供)。

## 10. Known Hazards
- push 即上线:半成品绝不 push;想存代码先本地 commit 不 push。

## 11. Documentation Map
`worker.js`(自文档)· 消费端 ah-doc-renamer `js/classify.js` · `README.md`。
