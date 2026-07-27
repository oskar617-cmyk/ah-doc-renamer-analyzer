# AH Doc Renamer Analyzer(Cloudflare Worker)
> 本文件与 docs/ 由 claude.ai 的 Claude 于 2026-06-11 交接,是本项目的 context 来源。工作中保持更新:每完成阶段性改动,更新 docs/roadmap.md。

- 是什么:代理 Gemini 的 Worker,AH Doc Renamer 的 AI 大脑。输入候选 docType 列表 + 文本 + 首页图,输出分类 + note + detectedAddress / detectedJobCode;支持 few-shot `examples`
- URL:https://ah-doc-renamer-analyzer.oskar617.workers.dev;模型 `gemini-3.1-flash-lite`(免费 tier)
- `worker.js` 有 `VERSION`(现 v0.04);`?selftest=1` 诊断端点
- Prompt 原则(v0.04):content-first,优先读 title block,图优先于稀疏文本,文件名只是常错的弱提示
- ⚠️ push 到 main 即自动部署;push 前必须单独确认;根目录 `wrangler.toml` = Worker 标记,绝不跑 Pages 转换
- Contract 锁定于 PWA 的 `js/classify.js`,两边同步改


## 分类规则摘要(Claude 自动同步,勿手改)
> 本段由 Claude 从分类母版(上层 `AH Apps/CLAUDE.md`)提炼,最后更新 2026-07-27。看不到母版的工具(如 Codex)以本段为准;本文件其余部分的项目专属规则优先于本段;细则以母版为准。

- **部署**:GitHub 只存代码,push 不触发部署;改完自验通过即「`commit + push` + 本机 wrangler deploy」一起做(工作区根 `deploy-pages.ps1 -Repo "AH Apps\<repo>"`),无需 Oskar 逐次说 deploy。repo 内 deploy.yml 只留手动触发;不开 Cloudflare Git Integration。
- **部署走白名单,不是黑名单**(2026-07-27):只上传已知公开的文件/目录;**遇到没见过的东西一律停下来问**,不静默发布也不静默丢弃;上传前扫 token / key / 私钥 / 本机绝对路径,命中即中止。例外用 repo 根的 `.deploy-include`(必须发布,如 app 运行时要 fetch 的数据文件)与 `.deploy-ignore`(确认私密)声明。
- **纯 Worker repo 例外**(wrangler.toml 定义 Worker 入口、无 `pages_build_output_dir`):push 即上线、无 staging——push / deploy 逐次先问 Oskar。
- **栈**:PWA,vanilla HTML/CSS/JS,native ES modules,**no framework、无不必要的 build、前端无 runtime 依赖**;MSAL.js + Graph → SharePoint;`ah-jobs-rego` 是全套件 job 数据唯一 source of truth,任何 app 不得自建 job list。
- **npm 不是禁品**:禁的是 framework 与无谓 build。wrangler / 测试 / 本地服务器都可以用 npm,前端保持 native ES modules 即可。
- **MSAL**:母版有 8 条铁律,漏一条必挂;新 app 复制 ah-files 骨架,绝不从零写;`loginRedirect` 永不 popup;`redirectUri` 从 window.location 派生,绝不硬编码。
- **数据与缓存**:Service Worker 绝不缓存 `/api/*`、用户数据、草稿/导出;静态外壳 cache-first,HTML 与 `version.json` network-first;数据服务连不上要明确显示"连不上",不能拿缓存假装正常。用户有未保存输入时,更新提示不得自动刷新。
- **备份**:push 到 GitHub 不是备份,deploy 到 CF 也不是备份;有用户数据的 app 在 docs/spec.md 写清哪些数据绝不进 git、绝不上线、备份放哪。
- **版本纪律**:版本号三处同步(config.js / service-worker.js / index.html);release 前全部 .js 过 ES module parse 检查;新部署用 incognito 窗口验证(SW 缓存陷阱)。
- **品牌**:绿 `#0f6334`,dark 默认,Inter;update banner:load + visibilitychange + 10 秒轮询。
- **交付**:结尾附 Test This Build 清单,第一条固定 = 版本号 + 可点 markdown 链接到 CF 网址(如 `vX.Y.Z — [xxx.pages.dev](https://xxx.pages.dev)`)。
- **踩坑库**:动工前读 `ah-files/docs/LESSONS.md`;踩到 >30 分钟的架构坑,加一条 L 记录。
- **Git**:永不 `git add -A`,只 add 点名文件;小步 commit(英文 message);回退一律 `git revert`,禁 force push / reset --hard / 改历史。
