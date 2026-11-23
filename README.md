# SidePilot

给**存量系统**加一个真正能干活的 AI 助手：扫接口 → 出文档 → 挂助手 → 对话里调接口、查数据库、改页面。

零第三方依赖，只用 Node 内置模块（`node:http` / `node:sqlite` / 原生 `fetch`）。业务代码不动，入口加两行。

**▶ 在线看效果：[banshoudigua.github.io/sidepilot](https://banshoudigua.github.io/sidepilot/)**（介绍页，不用装任何东西）

![零依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-2f6f4f)
![Node](https://img.shields.io/badge/Node-20%2B-1a1917)
![License](https://img.shields.io/badge/license-MIT-c2410c)

> **装之前先想清楚一件事：它自己不会思考，得给它一个大模型。**
> 你需要准备三样东西——一个 OpenAI 兼容的接口地址、一个 API Key、一个**支持 tool calling 的模型名**。
> 没这三样，装上了也只是个空壳，一句话都答不出来。下面第一节专门讲这件事。

---

## 先准备一个大模型

SidePilot 不绑定任何厂商，它只是按 OpenAI 的协议发 `POST {baseUrl}/chat/completions`。
所以只要你的服务兼容这个协议，换个地址和模型名就能用。

### 需要三样东西

| 你要提供的 | 填到哪 | 例子 |
|---|---|---|
| 接口地址 `baseUrl` | `config.json` → `llm.baseUrl` | `https://api.deepseek.com/v1` |
| 密钥 `apiKey` | `config.json` → `llm.apiKey` | `sk-xxxxxxxx` |
| 模型名 `model` | `config.json` → `llm.model` | `deepseek-v4-flash` |

### 硬门槛：模型必须支持 tool calling

这不是建议，是**必要条件**。

SidePilot 的全部能力——查数据、调接口、改文件——都靠模型的 function calling 实现。
如果模型不支持，助手只会跟你闲聊，一个接口都调不动，界面上看不到任何工具调用记录。

选模型时优先挑带 **tools / function calling** 标记的。各家旗舰和主流档一般都支持，免费小模型经常不支持。

### 最省事的办法：用中转站

不想一家家注册的话，可以用中转站——**一个地址、一个 Key，能调多家模型**，账单也只有一个。

作者自己在用的：[**openlux.ai**](https://www.openlux.ai/register?aff=zehW)（链接含邀请码）。

| 要填的 | 值 |
|---|---|
| `llm.baseUrl` | `https://api.openlux.ai/v1` |
| `llm.apiKey` | 注册后在控制台创建，`sk-` 开头 |
| `llm.model` | 从它的模型列表里挑一个支持 tool calling 的，例如 `deepseek-v4.1-flash` |

> 中转站的请求会经过第三方服务器，**敏感业务数据请自行判断**。
> 在意数据合规的话，直接用下面的官方直连，别图省事。

### 官方直连：常用服务对照

| 服务商 | baseUrl | 模型名举例 |
|---|---|---|
| **DeepSeek**（最便宜） | `https://api.deepseek.com/v1` | `deepseek-v4-flash`、`deepseek-v4-pro` |
| 阿里通义（百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max`、`qwen-plus` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `kimi-k2`、`moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus`、`glm-4-flash` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 见控制台模型广场 |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen3:8b` 等本地模型 |
| Claude / Gemini | 不兼容 OpenAI 协议 | 需先套一层转换网关 |

> **模型名变动很快**（比如 DeepSeek 的 `deepseek-chat` 已在 2026-07 弃用，现在是 `deepseek-v4-flash`）。
> 表格里的模型名只是举例，**以你控制台的模型列表为准**。写错会返回 `model_not_found` 或 404。

### 填进配置文件

`.sidepilot/config.json` 里这一段：

```json
{
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-你的真实key",
    "model": "deepseek-v4-flash",
    "temperature": 0.3,
    "pricing": { "inputPerMillion": 0.15, "outputPerMillion": 0.6 }
  },
  "api": {
    "baseUrl": "http://127.0.0.1:3000"
  }
}
```

- `llm` 是模型，`api.baseUrl` 是**你自己的业务系统**地址（助手要回头调它）
- `pricing` 是每百万 token 的单价，填了管理端才能算钱；不填就只统计 token 不报金额

### 填完先自检，别等装完再排查

不装项目也能验，一条命令就够：

```bash
curl https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"只回复两个字：收到"}],"stream":false}'
```

返回里能看到 `"content": "收到"` 就说明地址、Key、模型名三样都对。

再验一次**工具调用**通不通（这才是 SidePilot 真正依赖的能力）：

```bash
curl https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"deepseek-v4-flash",
    "messages":[{"role":"user","content":"北京现在多少度"}],
    "tools":[{"type":"function","function":{"name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    "stream":false
  }'
```

返回里出现 `tool_calls` 字段，说明这个模型能用；只返回一段文字、没有 `tool_calls`，就换一个模型。

### 三个最常见的新手坑

1. **baseUrl 多写了 `/chat/completions`** —— 代码会自动拼这一段，你多写就变成 `.../chat/completions/chat/completions`，必报 404。
2. **Key 和地址不配套** —— 拿通义的 Key 填 DeepSeek 的地址，必然 401。哪家的 Key 配哪家的地址。
3. **模型名照抄了过时的文章** —— 官方早就改过名了。以控制台为准。

### 要花多少钱

按主流档位算，一次带两三个工具调用的问答大概 1000~3000 token，折合几厘到几分钱。
管理端「概览」能看到累计 token 和估算费用，填了 `pricing` 才有金额。

---

## 装进你自己的项目

把下面**整段**粘给你的 AI Agent（Claude Code / Cursor / CodeBuddy / Copilot Workspace 都行），
它会自己判断项目类型、拉代码、初始化、填配置、挂载、验证。

```text
# 任务：把 SidePilot 装进当前项目

SidePilot 是给存量系统加 AI 助手的框架：扫出项目里已有的接口，生成文档，挂上一个能调接口、
能查库、能改页面的助手。零第三方依赖，只用 Node 内置模块，不需要 npm install。

## 硬约束
- 不改业务逻辑，只在入口文件加两行
- 不新增任何依赖，不动已有依赖版本
- API Key 写进配置文件即可，不要打印到终端或写进日志
- 卡住就停下来问我，不要自己发明方案，也不要反复重试同一个动作

## 1. 判断能不能装
读 package.json / requirements.txt / composer.json，告诉我三件事：
语言是什么、入口文件在哪、路由是怎么注册的。
判断不出来就问我，别猜。

## 2. 把代码放进项目
git clone --depth 1 https://github.com/banshoudigua/sidepilot.git /tmp/sidepilot-src
mkdir -p vendor
cp -r /tmp/sidepilot-src/sidepilot ./vendor/sidepilot
rm -rf /tmp/sidepilot-src
（机器上没有 git 就告诉我，我手动下载给你）

## 3. 初始化：扫出接口
node vendor/sidepilot/cli/index.mjs init --root . --name "项目名"
把完整输出贴给我。
它会生成 .sidepilot/manifest.json（接口清单）和 .sidepilot/config.json（运行配置）。

## 4. 补全接口参数
打开 .sidepilot/manifest.json，找出 confidence 为 low 的条目，
回源码确认真实参数：名字、位置（query / body / path）、类型、是否必填。
参数名必须与源码逐字一致，不许编造；实在不确定的保持 low 并告诉我。

## 5. 填模型配置（这一步不做，对话一定失败）
先确认我有没有给你这三样：接口地址、API Key、模型名。
**缺任何一样就停下来问我，不要猜，也不要用免费试用额度自己顶替。**

如果我还没有 Key，停下来提醒我去申请，推荐这个中转站（一个 Key 能调多家模型）：
  https://www.openlux.ai/register?aff=zehW
拿到 Key 之后我再继续。

编辑 .sidepilot/config.json：
  llm.baseUrl   OpenAI 兼容地址，到 /v1 为止，不要带 /chat/completions
                例如 https://api.deepseek.com/v1
  llm.apiKey    我给你的 Key（写进去，不要打印出来，不要写进日志）
  llm.model     模型名，例如 deepseek-v4-flash
                （必须支持 tool calling，否则助手调不动任何接口）
  api.baseUrl   你的业务系统启动后的地址，例如 http://127.0.0.1:3000
  llm.pricing   可选，每百万 token 单价，填了管理端才能算钱

填完先自检一次，别等装完再排查：
  curl <baseUrl>/chat/completions -H "Authorization: Bearer <key>" \
    -H "Content-Type: application/json" \
    -d '{"model":"<model>","messages":[{"role":"user","content":"只回复：收到"}]}'
返回里有正常回答再往下走；401 是 Key 不对，404 是地址或模型名不对。

再把 profile 填上，这三项决定助手说话像不像这个系统的人：
  domain      业务是干什么的
  topTasks    用户最常做的事（会变成首屏快捷提问）
  restricted  不许碰的内容（助手遇到会直接拒绝）

## 6. 挂载
Node 项目：在入口文件里、所有路由注册之后、listen 之前加两行
  import { createPilot } from './vendor/sidepilot/src/index.mjs';
  createPilot({ config: './.sidepilot/config.json' }).attach(server);
Express / Koa 把 attach(server) 换成 mount(app, '/pilot')

非 Node 项目（PHP / Java / .NET / Python）：不要动业务代码，用独立模式
  node vendor/sidepilot/cli/serve.mjs --config ./.sidepilot/config.json --port 7788
然后让业务站把 /pilot 反代到 7788（nginx 三行，见 README「两种接入方式」）

## 7. 验证（必须真发一句话）
启动项目后逐项确认，把结果告诉我：
a) /pilot 能打开
b) 在 /pilot 里真的发一句「这个系统里有什么数据」，能收到模型回复
   —— 只看页面能不能打开不算通过，必须看到回答
c) /pilot/docs 列出接口清单
d) /pilot/admin 能打开，看得到概览数字
如果 b 失败，把报错贴给我，通常是 apiKey 或 model 名写错了。

## 8. 交付说明
告诉我：改了哪几个文件（应该只有入口那两行）、扫出多少个接口、
有几个还是 low 置信度、三个入口的地址、以及怎么卸载。

卸载：删掉入口那两行 + 删除 .sidepilot 目录 + 删除 vendor/sidepilot
```

装完你会多出三个页面，各有各的人用：

| 入口 | 给谁用 | 干什么 |
|---|---|---|
| `/pilot` | 业务人员 | 问数据、加记录、改文案，刷新接着上次聊 |
| `/pilot/docs` | 开发 / 运维 | 看接口清单、参数表、修改历史，改错了一键回滚 |
| `/pilot/admin` | 管理员 | 概览、对话记录、接口增删启停、模型与提示词、反馈、审计 |

---

## 它到底解决什么问题

不是"接个大模型"难，是这三件事难：

1. **模型不认识你的接口。** 它知道怎么写 SQL，但不知道你有 `/api/stats/sales`，更不知道它收 `days` 还是 `startDate`。SidePilot 从源码把路由扫成一份清单，再**真调一次只读接口**，把真实返回结构写回说明——模型不用猜字段名。
2. **没人敢让它直接动手。** 所有写操作必须人工点确认；改文件给逐行 diff，改前备份、改完可回滚。
3. **答错了查不出原因。** 每次工具调用都有记录：调了什么、花多久、返回几条。回答下方标出「依据」，用户能点👍👎，差评进管理端。

## 三种能力域

| 能力域 | 做什么 | 适用 |
|---|---|---|
| `api` | 把清单里的接口变成模型可调用的工具 | 有后端接口的系统 |
| `db` | 跨表统计时写**只读** SQL（语句级护栏，只放行 SELECT） | 有 SQLite 的场景 |
| `file` | 读文件、按片段替换、给 diff、留备份 | 纯静态站、模板页 |

## 两种接入方式

SidePilot 四层里有三层跟宿主语言无关，只有**挂载方式**绑 Node。

| 层 | 是否绑 Node |
|---|---|
| 前端界面（对话 / 文档 / 管理端） | 不绑，纯静态 |
| 能力域 · 调接口 | 不绑，就是发 HTTP 请求 |
| 能力域 · 改文件 | 不绑，纯文件读写 |
| 能力域 · 查库 | 部分绑（内置只有 SQLite） |
| 挂载方式 | 绑 |

**A. 嵌入模式（仅 Node）** —— 助手跟业务同一个进程：

```js
import { createPilot } from './vendor/sidepilot/src/index.mjs';
createPilot({ config: './.sidepilot/config.json' }).attach(server);
```

**B. 独立模式（任何语言）** —— 助手单独跑一个进程，业务站反代 `/pilot` 过去，**业务代码零改动**：

```bash
node vendor/sidepilot/cli/serve.mjs --config ./.sidepilot/config.json --port 7788
```

```nginx
location /pilot/ {
    proxy_pass http://127.0.0.1:7788;   # 结尾不带斜杠，保留 /pilot 前缀
    proxy_buffering off;                 # SSE 必须关，否则对话不流式
    proxy_read_timeout 300s;
}
```

IIS（ARR）、Apache（mod_proxy）同理。

| 项目类型 | 方式 | 业务侧改动 | 建议能力域 |
|---|---|---|---|
| Node（Express / Koa / 裸 http） | 嵌入 | 入口加 2 行 | api + db + file |
| PHP（Laravel / ThinkPHP / 原生） | 独立 + 反代 | **0 行** | api |
| Java（Spring Boot） | 独立 + 网关 | **0 行** | api |
| .NET（ASP.NET） | 独立 + IIS ARR | **0 行** | api |
| 纯 HTML / 静态站 | 独立 + 反代 | **0 行** | file |
| Python（FastAPI / Flask） | 独立 | 0 行 | api |

## 安全边界

默认策略一律偏保守：

- **目录白名单**：改文件只能落在配置指定的目录内
- **改前备份**：落盘前原文完整存进 `.sidepilot/backups/`
- **语法校验**：改 HTML 先做标签平衡检查，不合法不写盘
- **逐行 diff 确认**：不点确认，一个字都不变
- **原子写入**：先写临时文件再替换，断电不留半截
- **一键回滚**：用备份的原文回滚，不靠模型再改一遍

管理端 `/pilot/admin` **默认没有登录验证**，只适合内网或本机。要放公网请在前面加 Basic Auth 或 IP 白名单。

## 本地跑两个示例

`examples/demo-shop`（有接口 + 数据库）和 `examples/demo-static`（纯静态，演示反代接法）。

```bash
git clone https://github.com/banshoudigua/sidepilot.git
cd sidepilot/sidepilot/examples/demo-shop

# 配置：复制模板，填上你的 Key
cp .sidepilot/config.example.json .sidepilot/config.json
# 编辑 .sidepilot/config.json，把 llm.apiKey 换成你自己的

node server.mjs          # → http://localhost:8080
```

试着问：**「这个月卖得最好的三个商品是什么？」**
再问：**「帮我加一个哥伦比亚慧兰，单价 158，库存 40」** —— 会弹确认卡片，点确认才写入。

纯静态站要两个终端：

```bash
# 终端 1：助手独立进程
cd sidepilot/examples/demo-static
node ../../cli/serve.mjs --port 7788

# 终端 2：业务站（静态文件 + 把 /pilot 反代给 7788）
node server.mjs           # → http://localhost:8081
```

试着说：**「把耶加雪菲的价格改成 138」** —— 先读文件，给精确到行的 diff，确认后才落盘。

## 目录

```
sidepilot/
├── src/
│   ├── index.mjs          createPilot 入口
│   ├── runtime.mjs        HTTP 路由与 SSE
│   ├── agent.mjs          Agent 循环 + 写操作确认闸门
│   ├── llm.mjs            LLM 网关（流式 + tool calls + usage 统计）
│   ├── store.mjs          SQLite 存储（会话/消息/工具流水/反馈/用量/审计）
│   ├── scanner.mjs        路由扫描器（5 种框架写法）
│   ├── probe.mjs          接口自测：真实调用并回写返回结构
│   ├── admin.mjs          管理端 API
│   └── providers/         api / db / file 三个能力域
├── ui/                    对话面板 + 文档站 + 管理端 + 嵌入 SDK（原生 JS，无构建）
├── cli/
│   ├── index.mjs          init / scan / probe / uninstall
│   └── serve.mjs          独立模式启动器
└── examples/
    ├── demo-shop/         动态数据站（嵌入模式）
    └── demo-static/       纯静态站（独立模式 + 反代）
```

## 已知限制（诚实列出）

- **数据库只内置 SQLite。** MySQL / PostgreSQL / SQL Server 要直连得加驱动。更稳的做法是让系统暴露只读接口，助手走 `api` 能力域——这也更安全。
- **路由扫描器目前认 5 种写法**：Express、Koa、FastAPI、Flask、原生 http。PHP 的 `Route::get()`、Java 的 `@GetMapping`、.NET 的 `[HttpGet]` 还没写规则，`init` 扫不出来。不影响使用——管理端「新增接口」可以手工录。
- **`init` 只扫路由骨架**，参数需要 Agent 回源码补全（这是设计如此，正则做不到读类型）。
- **没有登录体系**，默认假设跑在内网 / 本机。

## 许可

MIT
