# AH Doc Renamer Analyzer(Cloudflare Worker)
> 本文件与 docs/ 由 claude.ai 的 Claude 于 2026-06-11 交接,是本项目的 context 来源。工作中保持更新:每完成阶段性改动,更新 docs/roadmap.md。

- 是什么:代理 Gemini 的 Worker,AH Doc Renamer 的 AI 大脑。输入候选 docType 列表 + 文本 + 首页图,输出分类 + note + detectedAddress / detectedJobCode;支持 few-shot `examples`
- URL:https://ah-doc-renamer-analyzer.oskar617.workers.dev;模型 `gemini-3.1-flash-lite`(免费 tier)
- `worker.js` 有 `VERSION`(现 v0.04);`?selftest=1` 诊断端点
- Prompt 原则(v0.04):content-first,优先读 title block,图优先于稀疏文本,文件名只是常错的弱提示
- ⚠️ push 到 main 即自动部署;push 前必须单独确认;根目录 `wrangler.toml` = Worker 标记,绝不跑 Pages 转换
- Contract 锁定于 PWA 的 `js/classify.js`,两边同步改
