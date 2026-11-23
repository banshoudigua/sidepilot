# SidePilot

给存量系统加一个 AI 助手：**扫接口 → 出文档 → 挂助手 → 对话调接口或改页面**。

零第三方依赖，Node 内置模块全包（`node:http` / `node:sqlite` / 原生 `fetch`）。

---

## 一句话安装

把下面这段完整粘进项目里的 AI Agent（CodeBuddy / Claude Code / Cursor 都行），
它会自己判断、放代码、初始化、填配置、挂载、验证。

> 前提：**目标项目必须是 Node.js**。SidePilot 零第三方依赖，不需要 `npm install`——
> 这一点很关键，本机 npm 装包容易卡死，而它压根不用装。

```text
# 任务：给这个项目装一个 AI 助手（SidePilot）

约束：SidePilot 只支持 Node.js 项目；零第三方依赖，不需要 npm install；
不要给项目新增任何依赖，也不要改业务代码。

请按顺序做，每步把结果告诉我。卡住就停下来问我，不要自己发明方案。

## 1. 判断能不能装
读 package.json，确认四件事：是不是 Node 项目、入口文件是哪个、
监听端口多少、路由怎么注册的（Express / Koa / 原生 http）。
不是 Node 项目就停下来告诉我，不要硬装。

## 2. 放代码
把 sidepilot 整个目录复制到项目的 vendor/sidepilot。
不要放进 node_modules，也不需要 npm install。

## 3. 初始化
在项目根目录执行：
  node vendor/sidepilot/cli/index.mjs init --root . --name "项目名"
它会扫路由，生成 .sidepilot/manifest.json、.sidepilot/config.json。
把完整输出贴给我。

## 4. 补全接口参数
打开 .sidepilot/manifest.json，找出 confidence 为 low 的条目，
回源码确认每个参数：名字、位置（query / body / path）、类型、是否必填，就地补齐。
参数名必须与源码逐字一致，不许编造；不确定的标成 low 留给我确认。

## 5. 填模型配置
编辑 .sidepilot/config.json：
  llm.baseUrl   OpenAI 兼容地址，例如 https://api.deepseek.com/v1
  llm.apiKey    模型密钥（我会提供，你写进去，不要打印出来）
  llm.model     模型名
  api.baseUrl   指向项目启动后的地址，例如 http://127.0.0.1:3000
另外把 profile 填上：业务是干什么的（domain）、用户最常做什么（topTasks）、
哪些内容不许碰（restricted）。这三项决定助手说话像不像这个系统的人。

## 6. 挂载
在入口文件里、所有路由注册之后、listen 之前，加两行：
  import { createPilot } from './vendor/sidepilot/src/index.mjs';
  createPilot({ config: './.sidepilot/config.json' }).attach(server);

如果你是 Express / Koa：把 attach(server) 换成 mount(app, '/pilot')。

## 7. 验证（必须真发一句话）
启动项目，逐项确认并把结果告诉我：
  a) /pilot 能打开
  b) 在 /pilot 里真的发一句「这个系统里有什么数据」，能收到回答
     —— 只看页面能不能打开不算通过，必须看到模型回复
  c) /pilot/docs 列出接口清单
  d) /pilot/admin 能打开，能看到概览数字
如果 b 失败，把报错贴给我，大概率是 apiKey 或 model 名写错。

## 8. 交付说明
告诉我：改了哪几个文件（应该只有入口那两行）、扫出多少个接口、
有几个还是 low 置信度、以及怎么卸载。

卸载方式：删掉入口那两行 + 删除 .sidepilot 目录 + 删除 vendor/sidepilot。

## 铁律
- 不改业务代码，只加入口那两行
- 不动已有依赖版本，不新增依赖
- 失败就停下报告，不要反复重试同一个动作
```

---

## 三个入口

| 入口 | 地址 | 干什么 |
|---|---|---|
| 助手 | `/pilot` | 终端用户对话 |
| 文档 | `/pilot/docs` | 看接口、查修改历史、回滚 |
| **管理端** | `/pilot/admin` | 改配置、管接口、管对话 |

> 管理端默认没有登录验证，**只适合内网或本机使用**。要放到公网，请在前面加一层 Basic Auth 或 IP 白名单。

---

## 两种接入方式（关键）

SidePilot 不是"Node 专用库"。它四层里有三层跟宿主语言无关，只有**挂载方式**绑 Node。

| 层 | 是否绑 Node |
|---|---|
| 前端界面（对话/文档/管理端） | 不绑，纯静态，任何语言托管 |
| 能力域 · 调接口 | 不绑，就是发 HTTP 请求 |
| 能力域 · 改文件 | 不绑，纯文件读写 |
| 能力域 · 查库 | 部分绑（内置只有 SQLite） |
| **挂载方式** | **绑** |

所以有两种接法：

### 方式 A：嵌入模式（仅 Node 项目）

助手跟业务跑在同一个进程里，两行代码：

```js
import { createPilot } from './vendor/sidepilot/src/index.mjs';
createPilot({ config: './.sidepilot/config.json' }).attach(server);
```

示例：`examples/demo-shop`（8080）

### 方式 B：独立模式（任何语言）

助手单独跑一个进程，业务站把 `/pilot` 反代过去。**业务代码零改动**。

```bash
# 在项目根目录
node vendor/sidepilot/cli/serve.mjs --config ./.sidepilot/config.json --port 7788
```

nginx：

```nginx
location /pilot/ {
    proxy_pass http://127.0.0.1:7788;      # 注意结尾没有斜杠，保留 /pilot 前缀
    proxy_buffering off;                    # SSE 必须关，否则对话不流式
    proxy_read_timeout 300s;
}
```

IIS（ARR）、Apache（mod_proxy）同理。

示例：`examples/demo-static`（8081 业务站 + 7788 助手），server.mjs 里有一段 20 行的反代，就是模拟 nginx 干的事。

### 各种语言怎么接

| 项目类型 | 方式 | 业务侧改动 | 能力域建议 |
|---|---|---|---|
| Node（Express/Koa/裸 http） | A 嵌入 | 入口加 2 行 | api + db + file |
| **PHP**（Laravel/ThinkPHP/原生） | B 独立 + nginx 反代 | **0 行** | api（走他已有的接口） |
| **Java**（Spring Boot） | B 独立 + nginx/网关 | **0 行** | api |
| **.NET**（ASP.NET） | B 独立 + IIS ARR | **0 行** | api |
| **纯 HTML / 静态站** | B 独立 + nginx | **0 行** | file（直接改页面） |
| Python（FastAPI/Flask） | B 独立 | 0 行 | api |

### 两个真实限制

**1. 数据库只内置 SQLite。** MySQL / PostgreSQL / SQL Server 要直连得加驱动，而本机 npm 装包容易卡死。
更稳的做法是**不直连库**——让系统暴露几个只读接口，助手走 `api` 能力域。这也符合原设计：「能走接口就不碰库」。

**2. 路由扫描器目前认 5 种写法**：Express、Koa、FastAPI、Flask、原生 http。
PHP 的 `Route::get()`、Java 的 `@GetMapping`、.NET 的 `[HttpGet]` 还没写规则，`init` 扫不出来。
但**不影响使用**——在管理端 `/pilot/admin` 里点「新增接口」手工录入即可，字段就是方法、路径、参数。

---

## 已经开始跑的示例

> 仓库里两个示例是**开发态**写法，直接相对路径引用 `../../src/index.mjs`。
> 装到别人的项目时按安装指令第 2 步复制到 `vendor/sidepilot`，用那段 import 路径。

### 一、带动态数据管理（有接口 + 数据库）

```bash
cd sidepilot/examples/demo-shop
node server.mjs
```

- 管理页面 http://localhost:8080
- AI 助手 http://localhost:8080/pilot
- 接口文档 http://localhost:8080/pilot/docs

试着问：**「这个月卖得最好的三个商品是什么？」** — 助手会自己选接口、查库、出表格。
再问：**「帮我加一个哥伦比亚慧兰，单价 158，库存 40」** — 会弹确认卡片，你点确认才写入。

### 二、纯静态站（演示独立模式）

需要两个终端：

```bash
# 终端 1：助手独立进程
cd sidepilot/examples/demo-static
node ../../cli/serve.mjs --port 7788

# 终端 2：业务站点（静态文件 + 把 /pilot 反代给 7788）
cd sidepilot/examples/demo-static
node server.mjs
```

- 网站首页 http://localhost:8081
- 改页面 http://localhost:8081/pilot（经反代到 7788，页面上会出现悬浮球）
- 也可以直连助手 http://localhost:7788/pilot

试着说：**「把耶加雪菲的价格改成 138」** — 助手会先读文件，再给出精确到行的 diff，你确认后才落盘。
改完刷新首页就能看到。想撤销就去 /pilot/docs 的「修改历史」点回滚。

这个例子里，业务站完全不知道 SidePilot 存在——`server.mjs` 里只有一段 20 行的反代，
等价于线上 nginx 干的事。**这就是 PHP / Java / .NET 的接法。**

---

## 两种形态的差别

| | demo-shop | demo-static |
|---|---|---|
| 接入方式 | 嵌入模式（同进程） | **独立模式（反代）** |
| 能力域 | `api` + `db` | `file` |
| 助手怎么干活 | 调接口 / 写 SQL | 读文件、替换片段 |
| 风险控制 | 写操作弹确认 | 六道闸：白名单、备份、语法校验、diff 确认、原子写、回滚 |
| 典型提问 | 查数据、做统计、加记录 | 改文案、调价格、换段落 |

---

## 目录

```
sidepilot/
├── src/
│   ├── index.mjs          createPilot 入口
│   ├── runtime.mjs        HTTP 路由与 SSE
│   ├── agent.mjs          Agent 循环 + 确认闸门
│   ├── llm.mjs            LLM 网关（流式 + tool calls）
│   ├── store.mjs          SQLite 存储
│   ├── scanner.mjs        路由扫描器
│   └── providers/
│       ├── api.mjs        按 manifest 调接口
│       ├── db.mjs         只读 SQL（含护栏）
│       └── file.mjs       文件读写（六道闸）
├── ui/                    助手面板 + 文档站（原生 JS，无构建）
├── cli/index.mjs          init / scan / uninstall
└── examples/
    ├── demo-shop/         动态数据站
    └── demo-static/       纯静态站
```

---

## 已经做到什么程度

**可用**
- 接口扫描（Express / Koa / FastAPI / Flask / 原生 http 五种写法）
- 流式对话 + tool calling，可切换任意 OpenAI 兼容模型
- 三种能力域：调接口 / 查数据库 / 改文件
- 写操作强制人工确认；文件改动给逐行 diff
- 文件编辑六道闸（含备份与一键回滚）
- **对话记录**：刷新页面自动接着上次聊；顶栏「历史」可查看、切换、删除会话；「＋」新建对话
- **管理端** `/pilot/admin`：概览统计、对话记录管理、接口清单增删改与启停、模型与提示词配置（改完立即生效）、护栏说明
- 接口文档站：分组、搜索、参数表、修改历史
- 嵌入 SDK：一行 script，右侧 420px 抽屉，样式全内联不污染宿主

**还没做**
- `init` 只能扫出路由骨架，参数需要 Agent 补全（这是设计如此，不是缺陷）
- 只测了 Node 侧，Python 版未实现
- 没有登录体系，默认假设跑在内网/本机
- 多项目管理（联邦 Console）未实现

---

## 安全提醒

这个项目让 AI 能改你的文件、调你的接口。默认策略是保守的：

- 文件编辑必须落在白名单目录内，且每次改动都要人工确认
- 数据库只读，SQL 走语句级护栏
- 写接口必须点确认才发出

但仍然建议：**先在内网或本机试，不要直接接生产环境。**
