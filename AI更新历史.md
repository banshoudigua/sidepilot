# AI 更新历史

> 记录本项目每一次由 AI 参与的内容调整与技术变更。

---

## 2026-11-12

### 新增：项目方案文档（v0.1 方案稿，未落地）

**文件**：`项目方案-SidePilot.md`

**内容摘要**

为一个「可嵌入网站的 AI 侧栏助手平台」出具完整方案，核心结论与设计要点：

1. **可行性判断**：技术可行，但本质是「能力注册表 + Agent 运行时 + 嵌入式交付」三件事叠加，重心在接口语义化，聊天框是最简单的一环。
2. **事实核查（2026-11 已验证）**：DeepSeek 的 `deepseek-flash`（V4.1 Flash）已原生支持视觉理解，走 OpenAI 兼容 `/chat/completions`，图片支持 base64 / 公网 URL / Files API 三种传入，单图计费封顶 384 token。原文「设置 DeepSeek API 即可多模态」的设想现已成立。
3. **核心架构**：能力卡（Capability Card）把每个接口加工成「能干什么 + 参数 Schema + 风险等级 + 执行模式」，用 BM25 检索 top-8 进 prompt，而非全量塞入。
4. **三种执行模式**解决跨站鉴权难题：服务端直连（AI 专用账号）、浏览器代理（父页面 fetch 复用用户登录态）、数据库直查（只读护栏）。第二项是本方案与市面「聊天框套壳」的主要区别。
5. **四层 SQL 护栏**：语法白名单 → 只读账号 → 表列白名单与脱敏 → 资源限制。写操作默认全关，开启后强制人工确认 + before 快照 + 审计。
6. **接口文档三阶段流水线**：解析（零 LLM）→ 归一（规则推断分组/能力类型/权限）→ 语义增强（LLM 只写描述，禁止改事实字段）。产出文档站 + OpenAPI 导出 + 版本 diff + 待补清单。
7. **图片录入五步流水线**：上传 → 视觉模型输出严格 JSON（function calling 约束）→ 录入方案字段映射 → **强制人工预览确认** → 分批写入。第四步不可省，否则生产环境等于埋雷。
8. **双版本策略**：Node 版核心链路零第三方依赖（`node:sqlite` + 内置 fetch + 手写 SSE，不用 npm install）；Python 版 FastAPI + 标准库 sqlite3。用同一份 OpenAPI 契约 + 一致性测试用例锁行为。建议 Node 先行，Python 版 M6 补齐。
9. **SQLite 数据模型**：16 张表（admin_users / admin_sessions / projects / llm_configs / datasources / api_sources / endpoints / endpoint_params / capabilities / doc_versions / conversations / messages / tool_calls / uploads / ingest_templates / audit_logs）。
10. **里程碑**：M0 骨架 → M1 单项目可用 → M2 接口导入分析 → M3 嵌入鉴权 → M4 文档引擎 → M5 多模态录入 → M6 Python 对齐与开源发布，合计约 30 人日。
11. **PoC 清单**：6 条必须提前验证的技术假设（含 DeepSeek 图片 + tool calls 能否同时用、BM25 命中率、`node:sqlite` 版本、iframe 内 SSE、跨站 Cookie、LLM 是否篡改参数）。
12. **待决策 6 项**：前端技术栈、数据库支持范围、Python 版是否本轮做、是否上向量检索、项目命名、以及「接口权限」的准确定义。

**状态**：仅方案，未写任何代码，未创建项目骨架。

---

### 第二轮补充：外部 Coding Agent 交接协议（4.8 + 附录 A/B）

**起因**：五阿哥提出——既然能把 Postman 集合变成文档，能否再生成一份提示词显示在页面上，让人复制到自己的 Agent 里，针对老旧项目直接产出接口规范文件，再把文件路径发回系统导入。

**结论**：方向成立，且比原设计更优（把"读旧代码"这件最难的活外包给有文件系统权限的 Coding Agent，平台只需维护一个 JSON Schema 校验器，不用写 PHP/Java/Python/Node 四套路由解析器）。但"发文件路径"这一步有物理限制，已重新设计。

**新增内容**

1. **4.8 交接协议**：三阶段两次交接 + 失败回流闭环。协议核心是 `manifest.json` 规范，四个字段决定成败：`evidence[]`（无证据直接拒收）、`confidence`（low 自动禁用 AI 调用）、`missing[]`（给 Agent 合规出口，避免硬编）、`source.routesFound`（覆盖率自检，< 0.8 红字警告 Agent 没扫全）。
2. **回传四通道**：上传（默认）/ 粘贴 JSON / 本地路径（**仅同机可用**，Docker 或远程服务器读不到本机绝对路径，报错必须写清原因并引导改用上传或 CLI）/ CLI 推送 `sidepilot-cli push`（终局形态，校验失败直接打印修复提示词）。
3. **修复提示词**：校验失败时自动拼装针对性指令，用户整段复制回 Agent 即可，不需要看懂错误。这是把"格式问题"和"业务问题"分开兜住的关键。
4. **增量更新规则**：按 `method+path` 指纹 diff，新增/变更/下线分别处理；**人工改过的 title、示例、启用状态绝不覆盖**（多数导入工具的通病）。
5. **提示词编译器**：页面上三档（极简 300 字 / 标准 1200 字 / 完整 3000 字含 Schema 正反例），可填技术栈、范围、目标路径，一键复制或下载 .md。
6. **附录 A**：标准版提示词全文（可直接贴给 Claude Code / Cursor / Codex）+ 极简版 + 修复提示词模板。
7. **附录 B**：manifest 的 JSON Schema 骨架。三个保守默认值：`risk` 缺省 write、`confidence` 缺省 low、`required` 缺省 false。

**连锁改动**

| 位置 | 改动 |
|---|---|
| 第一章 | 认知表新增第 4 条（文件路径的物理限制），"三个"改"四个"；修正 5.2 → 4.2 的错误引用 |
| 第二章 | 第 ⑥ 步拆成三条路（有文档 / 老代码 / 手工），b 分支指向 4.8 |
| 4.1 | 能力卡来源表新增「外部 Agent 交接」，原「代码扫描」降为「内置轻量扫描」 |
| 第五章 | `endpoints` 表加 `batch_id`、`source_kind`、`evidence_json`、`confidence`、`fingerprint`；新增 `import_batches` 表（16 → 17 张）；`api_sources.kind` 加 `agent_handoff` |
| 第六章 | 新增 4 个 handoff 端点 + 一节 CLI 推送接口 |
| 第八章 | `server-node/handoff/` 目录、`cli/` 目录、`shared/manifest-schema.json`、`examples/legacy-demo/` |
| 第九章 | 新增 M2.5（4 人日），总工期 30 → 32 人日（M2 省 2 人日、M2.5 加 4 人日）；验收节点改为 M2.5 |
| 第十章 | PoC 从 6 条加到 7 条，新增「三个 Agent 跑同一老项目，看首次通过率与修复后通过率」 |
| 第十一章 | 新增 3 条风险（Agent 少干活 / Agent 编造 / 格式反复不通过） |
| 第十二章 | v0.1.0 含 M2.5；新增 v2.0 做 MCP Server 的远期规划 |
| 第十三章 | 拍板项 6 → 7，新增「manifest 是否同时导出 OpenAPI」（建议做） |

**验证思路（未实测，属方案态）**：M2.5 的验收标准是拿 `examples/legacy-demo` 跑完整闭环，包括故意改坏 2 处后走修复提示词二次提交。真正的未知量是 Agent 首次通过率，已列入 PoC 第 7 条。

---

### 第三轮：v0.2 定位重构（平台 → 框架），新增第十五章

**起因**：五阿哥提出釜底抽薪的质疑——「Agent 都能读出老项目接口了，干脆让它直接改老项目把 AI 助手加进去不就行了？那这个项目是不是多余？」

**判断**：前半句不成立，后半句完全正确。

1. **「Agent 能做」不等于「该做」**：改 1 个项目可行，改 10 个就是 10 套不同质量的实现；护栏（SQL 只读/写确认/注入防护/限流/审计）每次都会写得不一样且大概率有漏；老项目塞几千行 diff 没人审得动；半年后换模型要回去改 10 处。类比：不会让 Agent 在 10 个项目里各写一套登录。
2. **提炼出一条贯穿全产品的原则**：**让 Agent 生成「声明」，而不是生成「实现」**。声明几十行 JSON 可校验可 diff 可回滚；实现几千行只能人肉 review。这也是 4.8 交接协议为什么产出 `manifest.json` 而不是直接改代码。
3. **后半句的直觉抓到了真问题**：v0.1 同时扮演五个角色（文档引擎/交接协议/运行时/嵌入SDK/多项目后台），定位说不清；更严重的是「三种执行模式 + postMessage 代理 + origin 白名单」占了方案近 1/5 篇幅，**全是平台形态自造的复杂度**——框架态同进程同域，一个 `auth` 回调就解决了。

**新形态（v0.2）**

```js
const pilot = createPilot({
  manifest: './sidepilot.manifest.json',
  llm: { baseUrl, model, apiKey },
  db: { client: 'mysql', connection: pool, readonly: true },
  auth: (req) => req.session.user          // 一行复用现有登录态
});
pilot.mount(app, '/pilot');                // API + 侧栏 UI + 文档站
```

**连锁改动**

| 位置 | 改动 |
|---|---|
| 文档标题与开头 | 改为「给存量系统加 AI 助手的开发框架」，加 v0.2 修订说明，提示 4.2 与 4.7 已失效、建议先读十五章 |
| 第十五章（新增） | 15.1 Agent 能做≠该做（五维对比表）· 15.2 原方案过重的实证 · 15.3 框架形态与代码 · 15.4 模块归位表 · 15.5 保留独立服务作兜底 · 15.6 三种使用姿势 · 15.7 工期影响 · 15.8 新风险 |
| 4.2 三种执行模式 | 框架态**删除**，仅独立服务形态保留 |
| 4.7 嵌入 SDK | **降级**为独立服务形态专用 |
| 4.6 文档引擎 | **降为可选模块**，新增 `npx sidepilot docs ./postman.json` 纯文档姿势（最低门槛入口） |
| 多项目后台 | 降为可选控制台，推迟到 v1.0 |
| 工期 | 32 → **约 30 人日**（删跨域相关 −5.5，加框架封装 +2、文档 CLI 化 +1） |
| 里程碑 | M3 从"跨域鉴权（最难）"变为"框架封装（常规）"，**M1 结束就能拿真实老项目试** |

**新风险**：从「部署门槛高没人用」变成「库竞争激烈，大模型厂商可能出自带 SDK」。护城河收敛为三条：manifest 规范成为事实标准、护栏实现质量、双语言零依赖。

---

### 第四轮：部署形态与多项目管理，新增第十六章

**起因**：五阿哥问「不走 Docker，直接在项目外面部署，或者做成一个能管理所有项目的 Node 项目，行不行？」

**两个纠正**

1. **Docker 从来不是必需的**。上一轮提 Docker 时没说清，容易让人误以为是运行前提。实际三种启动方式：`node server.mjs`（首选，零依赖）、双击 `启动.bat`、Docker（只有部署到 Linux 服务器要环境隔离才用）。
2. **「在项目外面」要分清目录还是进程**。目录完全可以在外面（`npm i ../sidepilot` 即可，包装在哪不重要）；但框架形态要求**跑在同一个 Node 进程里**——这是"能否零跨域"的分水岭。如果连入口文件都不想改，可用 `node -r ./sidepilot/attach.js app.js` 预加载钩子，零侵入但属 hack，仅对标准 http/Express 有效。

**新增三种形态**

| 形态 | 做法 | 跨域 | 适用 |
|---|---|---|---|
| **A 嵌入** | `createPilot` + `mount`，5 行 | 无 | 自有项目，主推 |
| **B 独立服务** | `node sidepilot.mjs --port 3000`，管所有项目 | 有（保留三种执行模式） | 完全不能改代码的第三方系统 |
| **C 联邦** | 各项目装库（A），向轻量 Console 异步上报 | 无 | 多项目想统一看，推荐 |

**核心洞察（写进 16.4）**：**管理集中 ≠ 请求集中**。统一管理只需要三类低频异步数据——观测统计、配置下发、聚合展示，没有一类需要待在请求链路上。所以管理面可以独立出来做成 Console，数据面各自跑：无单点、无中转、无跨域。B 形态的所有痛点（单点故障/多一跳/跨域复杂度/数据主权）都源于把管理面塞进了请求链路。

**B 形态的降复杂度技巧（16.6）**：同机反向代理。nginx 加 3 行 `location /pilot/ { proxy_pass http://127.0.0.1:3000/; }`，让 SidePilot 跑在老系统同域名下 → iframe 同域、Cookie 天然可用、不需要 CORS、相对路径引用。比改 Node 代码容易，运维基本都会。

**工期分层**：只做 A 约 30 人日；A + C 约 33；A + B + C 约 38。路线建议 A（v0.1~v0.4）→ C（v1.0）→ B（有客户明确要求时）。

---

### 第五轮：最终形态「一句话安装」，新增第十七章（补记）

> 说明：本轮变更当时遗漏了记录，第六轮时补上。内容依据方案第十七章还原。

**起因**：五阿哥明确终极形态——「在 Agent 里打开项目，粘贴一段话，它就能装一个库，这个库帮我 ① 读取所有接口生成文档 ② 植入 AI 助手的多模态对话 ③ 让 AI 通过对话调用这些接口」。

**三段式结构**：安装提示词（易变层，改文案不用发版）+ `npx sidepilot init`（干活）+ `createPilot` 运行时（挂载）。

**关键设计**

1. **硬指标**：从粘贴到第一句回答 ≤ 5 分钟，不需要读任何配置文档。这是它跟"让 Agent 手写一套"的本质区别——5 分钟且每次一致，而非半天且每次不同。
2. **交接协议在此场景下自动简化**：Agent 就在项目里，补全接口直接改 `.sidepilot/manifest.json`，4.8 的四条回传通道退化成"读写同一个文件"。
3. **接口扫描三层**：内置扫描器覆盖 10 框架约 90% / Agent 补 10% / 手工兜底。建议 v0.1 只做 3 个框架（Express、FastAPI、ThinkPHP），其余靠 Agent 兜底，工期不涨。
4. **自动调接口的实现**：默认本机回环 HTTP（`127.0.0.1:自己端口`），一套代码通吃所有框架；Fastify/Next 用原生 `inject` 优化。核心是 **HMAC 短期内部令牌**：注入 `X-SidePilot-User` 头 → 库中间件还原 userId → 走用户自己的权限中间件。**AI 不绕开权限，而是以真实用户身份走真实权限链路**，用户原有的 `@PreAuthorize`/装饰器全部照常生效。
5. **幂等与回滚**：重复 `init` 保留人工改过的字段；`npx sidepilot uninstall` 删目录并还原入口文件；提示词铁律要求先确认 Git 工作区干净（这是自动改代码最易忽略、后果最重的一步）。
6. **五项可测验收**：识别率 ≥9/10、扫描覆盖率、首次成功率 ≥70%、幂等性、回滚后 diff 为空。

**用工时影响**：内置 10 框架扫描器比上轮估的 30 人日多 +8~10；建议 v0.1 先做 3 框架以保住工期。

---

### 第六轮：项目探测与能力域，新增第十八章

**起因**：五阿哥补充——装完之后助手应先问清项目特征再开工；并举例「纯 HTML 项目没有接口，那就应该反过来，让 AI 通过服务端直接编辑 HTML 文件」。

**点破的前提问题**：同一句「帮我改首页价格」在有接口的电商系统里是「调 `POST /api/product/update`」，在纯静态站里是「改 `index.html` 第 47 行」。**助手不先搞清楚自己在哪种项目里，会做错事而且很自信。**

**新增设计**

1. **三类项目三种本分**：api_app（查数写数）、static_site（改文件）、hybrid（两者都要，**老项目最常见的其实是这一类**）。
2. **能力域抽象（Provider）**：`api` / `db` / `file` 三个 provider，按画像组合开启。`file` 默认关闭——它是唯一能造成不可逆破坏的（数据库还能回滚，静态站改错立刻对外可见）。
3. **探测 vs 访谈的严格分工**：7 项自动探测绝不问人（含「有无构建步骤」，漏了会导致改 `dist/` 被覆盖）；只问 3 个问题，且必须是**确认式**（先给判断让用户点头）而非开放式，效率差十倍。
4. **项目画像 profile**：写进 `config.json`，干四件事——决定加载哪些 provider、决定 system prompt 的业务背景、决定哪些操作拦截、决定 UI 首屏快捷指令。必须可随时"重新认识这个项目"。
5. **文件编辑六道闸**：路径白名单 / 写前快照 / 语法校验 / diff 确认 / 原子写入 / 一键回滚。第 4 道是灵魂——没有 diff 确认的文件编辑等于把生产环境交给概率。
6. **编辑指令格式**：AI 只输出 search/replace 块（原文片段 → 新片段），**不给行号**（行号会漂移）。库负责唯一性校验：0 次报找不到、>1 次报不唯一。多个块全部校验通过才一起落盘。
7. **纯静态站的鉴权难题**：站点根本没有"管理员"概念，谁能开助手谁就能改线上页面。三层控制（管理口令 / IP 白名单 / 只读），**默认只读**——这个默认值比任何文档都管用。
8. **价值判断（诚实版）**：接口型是主战场（价值高、每天都用），静态站是延伸（价值中、粘性低、技术难度反而更高）。资源分配 7:3，不能因为覆盖面大就颠倒主次。

**连锁改动**：第十七章提示词追加「第七步：认识这个项目」；17.8 验收标准按项目类型拆成两条，静态站额外加一条安全验收（故意改白名单外文件必须被拒）。

---

### 第七轮：实际落地开发（从方案到可运行代码）

**产出**：`sidepilot/` 完整可运行代码 + 两个示例站，局部验证通过。

**实现了什么**

| 模块 | 文件 | 说明 |
|---|---|---|
| 入口 | `src/index.mjs` | `createPilot({config})`，支持 `attach(server)` / `mount(app)` / `handler()` |
| 运行时 | `src/runtime.mjs` | 零框架 HTTP 路由 + SSE 流 + 静态资源 |
| Agent | `src/agent.mjs` | 6 轮工具循环、写操作确认闸门、system prompt 按画像生成 |
| 模型网关 | `src/llm.mjs` | OpenAI 兼容流式 + tool_calls 分片累积 |
| 存储 | `src/store.mjs` | `node:sqlite`，5 张表（messages / tool_logs / edits / audit） |
| 能力域 | `providers/api.mjs` `db.mjs` `file.mjs` | 调接口 / 只读 SQL 护栏 / 文件编辑六道闸 |
| 扫描器 | `src/scanner.mjs` | Express、Koa、FastAPI、Flask、原生 http 五种写法 |
| CLI | `cli/index.mjs` | `init` / `scan` / `uninstall` |
| 界面 | `ui/` | 对话面板、文档站、嵌入 SDK，原生 JS 无构建 |

**实测通过的链路**

1. 动态站：提问「这个月卖得最好的商品」→ 模型选工具 → 调接口/查库 → 出表格（营收 ¥7943、20 笔，与库一致）
2. 静态站：说「把耶加雪菲改成 138」→ file_list → file_read → file_edit 生成 diff → 确认 → 落盘（只改第 116 行）→ 回滚恢复 128
3. 文档站：4 接口分组渲染、参数表、来源标注（server.mjs:62）
4. 嵌入：悬浮球 → 右侧 420px 抽屉 → 对话（截图确认）

**踩到的 5 个真实 bug（都修了）**

1. **`/pilot` 无尾斜杠导致 CSS/JS 全 404**：页面内相对路径被解析到根目录。修法：`/pilot` → 302 到 `/pilot/`。
2. **流式渲染死循环**：表格半截时（含 `|` 但下一行不是分隔行），Markdown 渲染器的段落分支一行都不吃，`i` 不前进 → 数组爆炸 → `Invalid array length`。修法：段落分支加「一行没吃进就强行前进」兜底。
3. **回滚会把文件写成空**：`recordEdit` 只存了 diff 没存编辑前全文。修法：`file_edit` 返回值带 `before`/`after`，回滚前校验非空。
4. **WAL 模式下删库不删 wal 会「数据复活」**：`rm pilot.db` 后旧记录仍在。修法：清理时 `rm pilot.db*`。
5. **SDK 悬浮球「看不见」**：排查半天发现是**截图范围小于实际视口**（约 1950×1100），不是代码问题；期间把 Shadow DOM 换成普通元素 + 内联样式（更稳，也解决了 `:host{all:initial}` 导致宿主尺寸为 0 的隐患）。

**顺手加的护栏**

- 静态资源 `Cache-Control: no-cache`，避免改了样式浏览器还用旧的
- 文件编辑预演失败（找不到原文/不唯一）时不中断对话，把原因回灌给模型让它自己修
- 工具结果截断到 3500 字符，防止撑爆上下文

**未实现（诚实列出）**

- Python 版
- 多项目联邦 Console
- 图片上传的前端联调（后端已支持 base64 传入）
- `init` 只能扫骨架，参数需 Agent 补全

---

### 第八轮：对话记录与会话管理

**起因**：五阿哥指出——嵌入的助手聊完看不到对话记录，改动也没法回看；而且刷新页面应该延续上次的对话，除非主动新建会话。

**病因**：`sessionId` 其实一直存在 localStorage 里，模型那边也一直记着上文（`store.listMessages` 会喂历史），**但界面从来不加载历史**，所以刷新后看到的是空白欢迎页——等于白存。

**改动**

| 层 | 改动 |
|---|---|
| 存储 | 新增 `sessions` 表（id / title / created_at / updated_at / message_count）；`addMessage` 时自动 upsert，标题取首条用户提问前 24 字；新增 `listSessions` / `hasSession` / `deleteSession` / `listDisplayMessages` |
| 升级兼容 | 启动时从 `messages` 表回填 `sessions`，否则老库的会话在列表里看不到 |
| 接口 | 新增 `GET /api/sessions`、`GET /api/history?sessionId=`、`POST /api/session/delete` |
| 界面 | 顶栏加「历史」「＋」两个图标按钮；新增历史覆盖层（标题 + 相对时间 + 条数 + 当前会话高亮 + hover 删除）；历史消息按天插时间分隔线；打开页面自动加载当前会话 |

**顺手修的两个样式问题**

1. **flex 子项 `min-width:auto` 导致内容撑破容器**：420px 抽屉里表格和长段落被撑到容器外、文字不换行。修法：`.pilot-app` 与 `.stream` 加 `min-width:0` + `overflow-x:hidden`。
2. **CSS 改了但浏览器用旧缓存**：`no-cache` 不够，改 `no-store, no-cache, must-revalidate` + `Pragma` / `Expires`。

**验证方式**：做了个固定 420px 宽的 iframe 测试页，直接看真实抽屉宽度下的渲染（比反复点悬浮球可靠，测完已删）。实测：刷新后历史完整回显、列表三条会话正确、切换会话正常、点「＋」回到欢迎页。

---

### 第九轮：独立管理端 `/pilot/admin`

**起因**：五阿哥要求——助手要有独立管理端，能管聊天记录、管接口文档数据、设定提示词与模型，以及其他设置。

**新增页面**（`ui/admin.html` / `admin.css` / `admin.js`）

| 视图 | 内容 |
|---|---|
| 概览 | 4 个统计卡（会话/消息/接口/今日）+ 近 7 天对话量柱状图 + 运行状态 |
| 对话记录 | 会话表格（标题/条数/最后活跃），可查看详情弹层、删除 |
| 接口清单 | 表格内直接开关启停；编辑弹层改名称/分组/风险；删除；重新扫描；新增 |
| 模型与提示词 | 模型地址/名称/温度/Key（掩码）；项目画像（业务说明、高频任务、禁止项）；附加提示词；完整提示词预览 |
| 设置 | 护栏现状说明、数据文件位置、密钥存放提醒 |

**新增后端**（`src/admin.mjs` + `src/config.mjs`）

```
GET  /api/admin/overview        统计聚合（含 7 天趋势）
GET  /api/admin/config          读配置（密钥只返回掩码）
POST /api/admin/config          存配置（白名单字段，写回 config.json）
GET  /api/admin/prompt          预览最终系统提示词
GET  /api/admin/endpoints       接口清单
POST /api/admin/endpoints       单条新增/修改（method+path 为主键）
POST /api/admin/endpoints/delete
POST /api/admin/scan            重新扫描（已存在的保留，只补新增）
GET  /api/admin/logs            工具调用流水
```

**两个关键设计**

1. **配置热生效**：原来 `createLLM` 是值拷贝，改配置必须重启。改成保留 config 对象引用、每次 `chat()` 现读；`agent.getSystemPrompt()` 也从常量改成函数。现在改模型或提示词**保存即生效**。
2. **密钥不出页面**：`/api/admin/config` 只返回 `sk-****9AH1`；提交时若仍是掩码就保持原值，不会把 `****` 写进配置。

**实测证据**：把附加提示词设为「金额一律用元为单位，保留两位小数」，再问「近 30 天营收多少」，模型输出 `7943.00 元`——证明改动确实传到了模型且生效，不用重启。

**这次踩的坑**

- `agent` 构造时若 `config.prompt` 是 `undefined`，传入的是新对象，后续管理端赋值不会同步。修法：`index.mjs` 里先保证 `config.prompt = config.prompt || {}` 再传引用。
- 表格操作列宽度不够，按钮换行难看；「查看/删除」列从 110px 调到 140px。

---

### 第十轮：独立进程模式，打通 PHP / Java / .NET / 纯 HTML

**起因**：五阿哥问「为什么只支持 Node 项目？老网站有 PHP 的、纯 HTML 的、.NET 的、Java 的，能不能支持」。

**先纠正一个说法**：之前讲「只支持 Node」是不准确的。拆开看，SidePilot 四层里只有**挂载方式**绑 Node：

| 层 | 绑定情况 |
|---|---|
| 前端界面 | 不绑，纯静态 |
| 能力域 · 调接口 | 不绑，就是 HTTP 请求 |
| 能力域 · 改文件 | 不绑，纯文件读写 |
| 能力域 · 查库 | 部分绑（内置只有 SQLite） |
| **挂载方式** | **绑** |

所以真正缺的不是"支持"，而是"只提供了嵌入式这一种接法"。

**改动**

| 文件 | 内容 |
|---|---|
| `cli/serve.mjs`（新增） | 独立模式启动器：`node cli/serve.mjs --config ... --port 7788`，内部就 40 行——用 `pilot.handler()` 接一个原生 http server |
| `examples/demo-static/server.mjs` | 改造成「业务站 + 20 行反代」，模拟 nginx 干的事，业务代码里不再出现 `createPilot` |
| `README.md` | 新增「两种接入方式」章节：嵌入模式 / 独立模式、各语言对照表、nginx 配置、两个真实限制 |

**实测证据**

1. 独立进程 `7788` 起来后：`/pilot`、`/pilot/docs`、`/pilot/admin`、`/pilot/api/bootstrap` 全 200；根路径 404（不归它管，符合设计）。
2. 在独立进程里跑完整改文件流程：对话 → 3 次工具调用 → diff 确认 → 落盘 ¥138。
3. 经 `8081` 反代访问助手，四个入口全 200；SSE 流式正常（`proxy_buffering` 关掉即可）。
4. 纯静态首页上，悬浮球「改页面」正常出现——说明 `sdk.js` 是经反代加载的，业务站本身没有它。

**遗留（诚实列出）**

- **数据库只内置 SQLite**：MySQL / PG / SQL Server 要直连得加驱动（本机 npm 装包会卡死），建议走 `api` 能力域让系统暴露只读接口。
- **扫描器只认 5 种写法**：Express / Koa / FastAPI / Flask / 原生 http。PHP 的 `Route::get()`、Java 的 `@GetMapping`、.NET 的 `[HttpGet]` 还没写规则，`init` 扫不出来；但不影响使用——管理端「新增接口」可以手工录入。

---

### 新增：项目首页 `index.html`（落地页，离线可看）

**做了什么**

在项目根目录新建单文件首页 `index.html`，把 SidePilot 是什么、解决什么问题、怎么接、安全边界、三个入口一次讲清。没有外部依赖，双击就能看（只有字体走 Google Fonts，拉不到会自动退回系统字体）。

页面结构（五个章节，各有编号）：

| 章节 | 内容 |
|---|---|
| Hero | 「让跑了多年的系统开口说话」+ 右侧自动播放的对话演示卡（提问 → 工具调用 → 表格 → 结论 → 评价按钮） |
| 01 为什么 | 三个真问题：模型不认识你的接口 / 没人敢让它动手 / 答错了查不出原因 |
| 02 能做什么 | 四种能力域：扫接口、调接口、查数据库、改页面，每张卡带一句真实命令 |
| 数据条 | 0 第三方依赖 / 2 行业务改动 / 5 种框架 / 6 道安全闸 |
| 03 怎么接 | 嵌入模式 vs 独立模式（含 nginx 三段配置）+ 五种语言对照表 |
| 04 安全 | 六道闸逐条说明 + 审计流水样例 |
| 05 入口 | 三个 URL 卡片，直接可点 |

**视觉方向**：纸墨质感 + 工程图纸。暖纸底（#F4F1E8）、墨黑字、赭橙（#C2410C）作为唯一强调色；极细网格背景 + SVG 噪点做纸纹；标题用衬线（Noto Serif SC），技术标签用等宽；章节用 01/02 编号和细横线分隔，卡片加图纸角标。**全程没有紫色/紫蓝**。

**四个必须记下的坑（都是实测踩出来的）**

1. **`grid-template-columns: .9fr 1.1fr` 会把左列压扁** —— 裸 `fr` 的下限是 `min-content`，右侧审计卡内容一宽，左列被挤到 45px。改成 `minmax(0, 1fr) minmax(0, 1.15fr)`。全站五处 grid 一并改了。
2. **`li` 里的伪元素也占一个 grid 项** —— 六道闸的 `li` 是「序号伪元素 + b + span」，只定义两列时，span 被自动放进 34px 那一列，中文逐字换行成一竖条。必须给 `::before / b / span` 各自显式指定 `grid-column` 和 `grid-row`。
3. **不要用 `document.hidden` 判断动画要不要推进** —— 内置浏览器/后台态里它可能恒为 `true`，一判断演示卡就永远空白。改成只靠 `visibilitychange` 事件驱动，JS 不报错就照常播。
4. **滚动显现要做成渐进增强** —— 原来是「默认 `opacity:0`，JS 加 `.in` 才显示」，JS 一旦出错整页隐形。改成：head 里先给 `<html>` 打 `.anim` 标记，只有这个标记存在时元素才隐藏，脚本不跑就全部可见。

**其它细节修正**

- h1 从 68px 降到 62px、容器 1180 → 1280，解决「让跑了几年的系统」在 7 字时被拆成两行（文案同时改成「让跑了多年的系统」）。
- 中文引号全部用「」，不用 ASCII 直引号。
- 正文段落加 `text-wrap: pretty`，避免末行只剩「件。」这种孤字。
- 演示卡切到后台不再空转，回来从当前进度续播（定时器单一持有，不叠加）。

**文件**

- `index.html`（新增，单文件约 1070 行，内联 CSS/JS，无构建）

**验证**：临时起了 8090 静态服务，逐块截图确认——Hero + 演示卡完整播放、01 三卡、02 四卡 + 数据条、03 双模式 + 语言表、04 六道闸 + 审计卡、05 三入口全部排版正确，无横向溢出。检查完成后已删除临时检查页并停掉 8090。

**遗留**

- 页面里的「打开示例 / 三个入口」链接指向 `localhost:8080`，示例服务没起时会 404，这是预期（本地演示入口）。
- 字体依赖 Google Fonts，国内网络可能拉不到，已做系统字体回退（标题会退到宋体，观感略降但仍可读）。

---

### 上传 GitHub + 修复原生 http 扫描漏识别

**一、仓库上线**

仓库：https://github.com/banshoudigua/sidepilot （public）

为了让别人「复制一段话就能装」，做了三件事：

1. **仓库根 README 顶部放了一整段可直接粘给 AI Agent 的安装指令**（`text` 代码块，GitHub 上有复制按钮）。指令覆盖 8 步：判断项目类型 → 拉代码 → init → 补参数 → 填模型配置 → 挂载 → **真发一句话验证** → 交付说明。每步都写了失败时该停下问、不许编造参数。
2. **仓库简介（description）**写清它是什么 + 指向 README 里的指令段。
3. **两份 README 的安装说明统一了**。原来 `sidepilot/README.md` 里还残留 `npm i sidepilot` 和「目标项目必须是 Node.js」的说法，跟独立模式自相矛盾，改成指向根 README、只保留三条要点。

**二、安全：先挡密钥再上传**

- 新增 `.gitignore`：`**/.sidepilot/config.json`（含真实 Key）、`**/.sidepilot/*.db*`（对话记录）、`**/data/*.db*`（示例库）、`项目规则.md`（本机笔记含 Key）、`.workbuddy/`。
- 新增两份 `config.example.json`（demo-shop / demo-static），Key 位置写「在这里填你的 Key」，别人复制过去填自己的。
- 提交前做了两道检查：`git diff --cached --name-only` 过滤敏感路径、`git grep -E "sk-[A-Za-z0-9]{20,}" --cached` 扫内容。两道都过才提交。
- 推上去之后又用 API 把线上文件拉回来扫了一遍，确认 0 命中。

**三、修扫描器：`req.url === '/api/x'` 认不出来**

上传后按 README 的指令在一个全新目录里走了一遍完整安装（原生 http 项目，两个接口），init 扫出 **0 个接口**。

根因：`node-http` 那条正则只认变量名叫 `path` / `pathname`：
```js
/path(?:name)?\s*===?\s*['"`]([^'"`]+)['"`]/g
```
而最常见的写法是 `if (req.url === '/api/items' && req.method === 'GET')`，`req.url` 完全匹配不上。

改成三种都认，method 检测也放宽到 `method` / `req.method` / `request.method`：
```js
/(?:req\.url|request\.url|\bpath|\bpathname|\burl)\s*===?\s*['"`]([^'"`]+)['"`]/g
```

**端到端验证（这才是「能用」的证据）**

修完在一个干净目录 `_tmp_install_test` 里严格照 README 走了 8 步：

| 步骤 | 结果 |
|---|---|
| 建一个原生 http 项目（2 个接口） | ✓ |
| `cp -r sidepilot ./vendor/sidepilot` | ✓ |
| `init --root . --name "测试项目"` | 扫出 2 个接口，方法/路径/风险全对 |
| 填 config（llm + api.baseUrl） | ✓ |
| 入口加两行挂载 | ✓ |
| 四个入口 | `/pilot` 200、`/pilot/docs` 200、`/pilot/admin` 200、`bootstrap` 200 |
| **真发一句话**「这个系统里有什么数据？」 | 模型调 `items_list` → 返回 1 条 → 输出表格「id/名称/价格」 |

验证完停服务、**删掉整个测试目录**（里面有带 Key 的 config.json）。

**四、本机推不了 git push，改用 API 推送**

现象：`git push` 报 `Empty reply from server`；直连 `github.com:443` 超时；本机几个代理端口（51841 / 52494 / 7890 / 10809）对 github.com 全部不通。

但 `api.github.com` **直连 200**，所以 `gh` 命令一直能用。

解决办法：绕开 git transport，用 GitHub Git Data API 手工推——建 blob → 建 tree（带 `base_tree`）→ 建 commit → 移动 ref。空仓库不能直接建 blob（会返回 409 Git Repository is empty），要先靠 contents API 放一个种子文件。

**文件**

- `.gitignore`（新增）
- `README.md`（新增，仓库根；含 Agent 安装指令）
- `sidepilot/examples/demo-shop/.sidepilot/config.example.json`（新增）
- `sidepilot/examples/demo-static/.sidepilot/config.example.json`（新增）
- `sidepilot/src/scanner.mjs` — `node-http` 正则扩展，认 `req.url` / `request.url` / `url` / `path` / `pathname`
- `sidepilot/README.md` — 「一句话安装」整段替换为指向根 README 的短指引，消除与独立模式的矛盾

**遗留**

- `raw.githubusercontent.com` 在本机不通，Agent 无法用 raw 链接取指令，只能读仓库页面或 clone（换机器通常正常）。
- 管理端仍无登录验证，公网部署需自行加 Basic Auth 或 IP 白名单。

---

### 补上大模型接入说明（README 缺这一块等于没交付）

**问题**：仓库上线后，README 里只有安装指令第 5 步带了一句 `llm.baseUrl / apiKey / model`，
既没说去哪申请，也没说模型必须支持 tool calling，更没说不填会怎样。
外人拿到仓库根本不知道怎么接模型——这是硬伤。

**做了四件事**

**1. README 新增独立章节「先准备一个大模型」，放在安装指令之前**

- 三样东西缺一不可：接口地址、API Key、**支持 tool calling 的模型名**
- 说明为什么必须支持 tool calling：SidePilot 全部能力靠 function calling，不支持就只能闲聊
- 七家服务对照表：DeepSeek / 通义百炼 / Kimi / 智谱 GLM / 硅基流动 / OpenAI / 本地 Ollama
- 填进 `config.json` 的完整 JSON 示例（含 `pricing` 说明）
- **两段 curl 自检命令**：一段验地址+Key+模型名，一段专门验 tool_calls 通不通
- 三个新手坑：baseUrl 多写 `/chat/completions`、Key 和地址不配套、模型名照抄过时文章
- 一句话成本说明

**2. 首页补前置提示条**

`index.html` 的 03「怎么接」开头加了一个赭橙竖线提示条，明说「缺一样，助手就是个空壳」。

**3. 代码：缺配置时给出明确错误，而不是偷偷用默认值**

原来 `llm.mjs` 里 `model: conf.model || 'deepseek-v4.1-flash'` —— 这个默认值是本机中转站的模型，
别人没填就会拿一个不存在的模型名去请求，报出来的错跟真正原因没关系。

改成：
- 默认值清空
- `chat()` 开头检查 baseUrl / apiKey / model 三项，缺哪项直接返回中文错误：
  「模型还没配置完整，缺少：llm.apiKey（密钥）。请编辑 .sidepilot/config.json 的 llm 段，也可以直接在 /pilot/admin 的「模型与提示词」里填。」

实测：空配置报三项全缺、只缺 Key 精确报 Key。

**4. 修一个已经过时的模型名**

查证发现 **`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 弃用**，
现在官方模型是 `deepseek-v4-flash`（非思考）/ `deepseek-v4-pro`（强推理）。
原来的 README 和两份 `config.example.json` 都还写着 `deepseek-chat`，跟着官方文章抄的人会直接踩坑。

已全部改为 `deepseek-v4-flash`，并在文档里加了一句提醒：**模型名变动很快，以控制台模型列表为准**，
所以文档重点放在「怎么自检」而不是把模型名写死。

**补记：加了中转站推广位**

作者自己在用一个中转站（openlux.ai），一个 Key 能调多家模型，对新手比自己一家家注册省事。

加了，但**不绑死**：

- README 新增「最省事的办法：用中转站」小节，给了 baseUrl / apiKey / model 三行对照表，
  链接带邀请码 `?aff=zehW`
- **明确标注了「链接含邀请码」**，不伪装成官方推荐
- 同时保留「官方直连」对照表（DeepSeek / 通义 / Kimi / 智谱 / 硅基流动 / OpenAI / Ollama），
  并补了一行说明：Claude / Gemini 不兼容 OpenAI 协议，得先套转换网关
- 加了一句风险提醒：中转请求经过第三方，敏感业务数据自行判断，在意合规就走官方直连
- 安装指令第 5 步加了分支：Agent 发现用户没 Key 时，停下来提示去申请，拿到再继续
- 首页前置提示条同样加了链接与「含邀请码」标注

**验证**

- 空配置 / 只缺 Key 两种情况的报错文案都实测过
- 正常配置（demo-shop）仍能对话：问「店里一共几个商品」→ 调 `db_query` → 「店里一共 6 个商品」
- 首页提示条截图确认排版正常，链接样式与标注清晰，未挤压下方模式卡

**文件**

- `README.md` — 新增「先准备一个大模型」整章（含中转站与官方两套方案）；安装指令第 5 步补自检命令与"缺就停下来问"
- `index.html` — 03 区块加前置提示条（含中转站链接 + 邀请码标注）+ 对应样式
- `sidepilot/src/llm.mjs` — 去掉默认模型名，缺配置时返回明确中文错误
- `sidepilot/examples/demo-shop/.sidepilot/config.example.json` — model 改 `deepseek-v4-flash`
- `sidepilot/examples/demo-static/.sidepilot/config.example.json` — 同上

---

## 模板（后续每次变更照此格式追加）

### 新增 / 修改 / 修复：一句话说明

**文件**：
- `路径/文件` — 改了什么、为什么

**验证**：怎么验的、结果如何

**遗留**：未完成项或已知问题
