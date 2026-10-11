# HW1 AI Research Assistant — 方案文档 (v2.1, 2026-10-11)

> 方向锁死: **Pi 当底座**，重点只干两件事 — **PDF 数据管线优化 + Web UI 优化**。
> C 做热路径，bun 打包。前端照抄 buxx.me。v2.1 = MVP 实测同步版。

## 1. 作业要求对照 (hw1.pdf)

- [x] 1. Search: 关键词/topic -> Exa(keyless MCP) + SS + OpenAlex + arXiv,渲染 title/authors/year/abstract/link
- [x] 2. Save: SQLite 本地 DB,重启/刷新不丢,可浏览 (`lib/papers.db` + FTS5)
- [x] 3. Upload PDF: 上传入库,Pi native 提 title/abstract/pageCount,同搜索结果渲染
- [x] 4. Summarize: 基于正文(SSE,无 key 时 mock)生成 summary
- [x] 5. Ask: 自然语言问论文,同上
- 必须: GUI + 前后端 + >=1 外部 API + 本地 DB + PDF 处理 + LLM API — 全齐
- 提交: GitHub repo + demo 视频(5 步) + reflection(含 agent 截图)
- 红线: **Do not commit API keys** — `EXA_API_KEY` 可空(keyless 默认),`LLM_*` 可空(mock 降级)

## 2. 底座: Pi (已接入)

- `@oh-my-pi/pi-natives@18.8.9`: `pdfToMarkdown(buf)` 实测 hw1.pdf 19ms,真字全对,
  返回 `{markdown, title?, pageCount, pagesNeedingOcr, hasEncodingIssues}`。
  TS probe (`lib/pdf.ts`, inflate + Tj/TJ) 降级为 fallback。
- skill 3 件套在 `.claude/skills/`: `paper-read / paper-qa / citation-check`。

## 3. 前端现状: 单文件 `index.html` (左 Agent 右 PDF)

下一步做状态机重构(§8),目标 Astro islands 之前先不卡不崩。

## 4. PDF 数据管线 (已落地,全 TS + C,无 Python)

```
4源并行(8s熔断) --> title去重 --> SQLite+FTS5
上传 --> 写盘 --> runUpload(并发2) --> pdfToMarkdown(C)/TS回退 --> savePaper --> /api/read cursor --> SSE
```

- 搜索: `lib/search.ts` `searchPapers()` — Exa(有 key 走 /search,无 key 走 `mcp.exa.ai/mcp` 的 `web_search_exa`,解析 `Title:/URL:/Published:/Author:/Highlights:` 块)
  + SS + OpenAlex(`abstract_inverted_index` 解码) + arXiv;`mergePapers` title 归一;7 天内存缓存(100 条 LRU);单源 8s 超时转 `limited`。
  实测: 冷 ~8s(SS 429),热 36ms;`retrieval benchmark` 26 篇(Exa 10 + OA 8 + arXiv 8)。
- 上传: `runUpload` 并发 2 + 排队,`/api/queue` 可见 `{active,queued,concurrency}`;`extractUpload` native 优先回退 TS;
  字段 `extractionStatus/partial/no_text + pagesWithoutText + pageCount` 入库(带 ALTER 迁移)。
- 安全: `lib/safety.ts` (`isPublicHttpUrl` + `safePdfPath` + 75MB cap) — paper-pilot net.py 思想,TS 原创实现。

## 5. 文献理解 (skill,见 §2)

## 6. API 契约 (已实现)

- `GET /api/search?q=` -> `{papers, warnings, sourceStatus[]}` (source: ok/limited/error/skipped + retryable)
- `GET/POST /api/library`, `DELETE /api/library/:id`
- `POST /api/upload` -> `{paper, queue}`; `GET /api/queue`
- `GET /api/pdf/:id` — PDF 字节
- `GET /api/read?id=&offset=&limit=` -> `{text, nextOffset, endOfDocument, extractionStatus}`
- `GET /api/summarize?id=`, `GET /api/ask?id=&q=` (SSE,无 key mock)
- DB: `papers(...+extraction_status,pages_without_text,page_count)` + `papers_fts(id UNINDEXED,title,abstract)`

## 7. 打包 (bun)

`bun install && bun run server.ts` → `:4321`。`UPLOAD_CONCURRENCY` 可调。TA 零 setup。

## 8. UI 状态机设计 (下一步,防卡顿/崩溃)

状态分 5 机,全局单 store + rAF 批量渲染:

- search: idle|loading|done|error (+ AbortController 取消过期请求,debounce 300ms)
- library: idle|loading|done|error
- upload: idle|uploading|done|error (+ queue 显示)
- reader: none|loading|ready|gap (PDF iframe load/error 事件, gap 提示看渲染图)
- stream: idle|streaming|done|error (SSE 队列 + rAF flush,不逐帧写 DOM)

大文字策略:
1. 列表分片挂载: DocumentFragment + 每帧 20 卡,超 100 卡虚拟化(只渲染视口)。
2. 流式输出节流: 入队按 rAF 刷,Text 节点追加(不 `+=` 全量),200k 截断 + 提示;仅近底部才自动滚。
3. 摘要 3 行 clamp,全文走 `/api/read` cursor 分页,不一次倒 4000 字。
4. iframe 切换先 `about:blank`,loading 位,error 回退外链。
5. 所有 fetch 8s 超时 + 错误条,不静默吞;`?paperId=` 保持 URL 真理源。

## 9. 待定

1. Vision: GPT-4o 还是 Gemini?
2. LLM 文本 key: OpenAI / Gemini / Claude / Purdue 内网?

## 10. 风险

- SS 429 频繁:熔断已兜,缓存 7 天。
- CID/CMap 靠 native;无 native 环境回退 TS 状态机(诚实报 gap)。
- Exa keyless MCP 限流:降级三免费源。

## 11. E2E 实测 (2026-10-11, computer-use 真机)

- E2E-1 search→open→ask→save→library: 25 卡,真 LLM 回 fragmentation 三问题,无全文时诚实拒编 [p.X],library 12 篇 ✅
- E2E-2 upload→preview→ask: hw1 本地 PDF 右屏真渲染(4p),有全文后 LLM 带 [p.1]/[p.1–p.2] 真引用 ✅
- E2E-3 fetch→Keys→queue: arXiv Attention 15p 入库渲染,Keys 面板四输入 + .env 预览(不 POST 钥匙) ✅
- UI 改→录→看闭环 v1-v6 (真机截图逐帧):
  - v1: 揪出 title `?`/markdown 泄漏/去重失效(同文件 x3)/`...` 空气泡/破图
  - v2: sha256 内容 id + H1 标题回退 + 引用 pill + 卡片 Saved/Delete + 右栏对齐 ✅
  - v3: prompt 约束(3 点编号 + 句句引用),顶栏 library 计数分离 ✅
  - v4: excerpt 带 `<!-- Page N -->` 边界,引用打散 [p.1]/[p.2]/[p.2-3],标题 ellipsis ✅
  - v5: ask 收敛(≤5 句×40 词,一句一引用),pill `nowrap` 防孤立换行 ✅
  - v6: 近似去重(12-token 截断 + 前 8-token 近似判重),sysMsg `ellipse(60)` ✅
  - v7: arXiv 回填真实 title/authors/year (`lookupArxiv`),H1 跳水印行,sysMsg 全标题;右屏新 chrome (标题栏 + 1/N + ↗‹› + 渐变空态) ✅
  - v9: H1 兜底限前 3 个(正文节标题不再冒充),excerpt 跳过标题/作者/邮箱块直达 Abstract,`metaMiss` 诚实标记 + badge 提示;arXiv 限流中 BERT 回填待恢复 ✅
  - v10: OpenAlex 模糊回填认错论文(反犹检测贴到 BERT)后回滚 — 教训:宁可文件名占位 + metaMiss,不做模糊回填;arXiv 限流持续,Attention 全对保留 ✅
