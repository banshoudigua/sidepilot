# SidePilot

给存量系统加一个 AI 助手：**扫接口 → 出文档 → 挂助手 → 对话调接口或改页面**。

零第三方依赖，Node 内置模块全包（`node:http` / `node:sqlite` / 原生 `fetch`）。

---

## 安装

完整安装指令在仓库根部的 [README.md](../README.md#装进你自己的项目)，那段可以直接整段粘给 AI Agent。

需要记住三点：

- SidePilot **零第三方依赖**，不需要 `npm install`，把目录复制到 `vendor/sidepilot` 即可
- Node 项目用嵌入模式，入口加两行；PHP / Java / .NET 用独立模式，业务代码零改动
- 装完必须**真发一句话**验证，只看页面能不能打开不算通过

下面几节是这个框架本身的技术细节：能力域、两种接入方式、安全边界。

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
