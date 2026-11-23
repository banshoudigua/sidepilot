// SidePilot 入口：createPilot
// 用法：
//   const pilot = createPilot({ config: './.sidepilot/config.json' });
//   pilot.mount(app, '/pilot');      // Express / Koa 风格的 app
//   pilot.attach(server, '/pilot');  // 原生 http.Server
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createStore } from './store.mjs';
import { createLLM } from './llm.mjs';
import { createAgent } from './agent.mjs';
import { createRuntime } from './runtime.mjs';
import { createAdmin } from './admin.mjs';
import { createApiProvider } from './providers/api.mjs';
import { createDbProvider } from './providers/db.mjs';
import { createFileProvider } from './providers/file.mjs';

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    // 配置读不出来是最常见的启动失败原因，这里必须说清楚是哪个文件
    throw new Error('配置文件格式错误，无法解析：' + path + '\n' + e.message);
  }
}

export function createPilot(options = {}) {
  const configPath = resolve(options.config || './.sidepilot/config.json');
  const baseDir = dirname(configPath);
  const config = readJson(configPath, null);

  if (!config) {
    throw new Error('找不到配置：' + configPath + '\n先在项目根目录运行：npx sidepilot init');
  }

  // 接口清单与配置分开放，方便单独版本管理
  const manifestPath = resolve(config.manifestPath || join(baseDir, 'manifest.json'));
  const manifest = readJson(manifestPath, { endpoints: [], files: [], project: {} });

  const projectRoot = resolve(config.projectRoot || process.cwd());

  // 这两块要保证是 config 上的同一个对象引用：
  // 管理端改完配置后，agent 里现读就能拿到新值，不需要重启
  if (!config.profile) {
    config.profile = {
      name: config.project && config.project.name ? config.project.name : '这个项目',
      kind: (manifest.endpoints || []).length ? 'api_app' : 'static_site',
      domain: '',
      topTasks: [],
      capabilities: [],
      restricted: []
    };
  }
  if (!config.prompt) config.prompt = {};

  const profile = config.profile;

  // ---- 存储 ----
  const store = createStore(resolve(config.dbPath || join(baseDir, 'pilot.db')));

  // ---- 模型 ----
  const llmCfg = config.llm || {};
  if (!llmCfg.apiKey) {
    console.warn('[sidepilot] 还没配置模型 API Key，对话会失败。请在 .sidepilot/config.json 里填 llm.apiKey');
  }
  const llm = createLLM({
    baseUrl: llmCfg.baseUrl,
    apiKey: llmCfg.apiKey,
    model: llmCfg.model,
    temperature: llmCfg.temperature
  });

  // ---- 能力域：按画像决定开哪些 ----
  const providers = [];
  const caps = profile.capabilities && profile.capabilities.length
    ? profile.capabilities
    : ['api', 'db', 'file'];

  let fileProvider = null;

  if (caps.indexOf('api') >= 0 && (manifest.endpoints || []).length) {
    providers.push(createApiProvider({
      baseUrl: config.api && config.api.baseUrl || 'http://127.0.0.1:' + (config.port || 8080),
      endpoints: manifest.endpoints
    }));
  }

  if (caps.indexOf('db') >= 0 && config.db && config.db.path) {
    const dbAbs = resolve(projectRoot, config.db.path);
    if (existsSync(dbAbs)) {
      providers.push(createDbProvider({
        path: dbAbs,
        maxRows: config.db.maxRows || 200
      }));
    } else {
      console.warn('[sidepilot] 配了数据源但文件不存在，已跳过 db 能力：' + dbAbs);
    }
  }

  if (caps.indexOf('file') >= 0) {
    fileProvider = createFileProvider({
      root: projectRoot,
      editableDirs: config.file && config.file.editableDirs || ['www'],
      backupDir: join(baseDir, 'backups')
    });
    // 回滚能力挂到 provider 上，runtime 会用到
    fileProvider.rollbackTo = function (relPath, beforeText) {
      // 没有原文就不能回滚——否则会把文件写成空
      if (!beforeText) {
        return { ok: false, reason: '这条记录没有保存编辑前的内容（旧版本产生的记录），无法回滚' };
      }
      const target = resolve(projectRoot, relPath);
      const allowed = (config.file && config.file.editableDirs || ['www']).some(
        (d) => target.startsWith(resolve(projectRoot, d))
      );
      if (!allowed) return { ok: false, reason: '该文件不在可编辑目录内，拒绝回滚' };
      writeFileSync(target, beforeText, 'utf8');
      return { ok: true, file: relPath };
    };
    providers.push(fileProvider);
  }

  if (!providers.length) {
    console.warn('[sidepilot] 一个能力域都没开，助手将无法做任何事。检查 .sidepilot/config.json 的 profile.capabilities');
  }

  // ---- Agent ----
  const agent = createAgent({ llm, providers, store, profile, prompt: config.prompt });

  // ---- 管理端 ----
  const admin = createAdmin({
    config,
    configPath,
    store,
    manifest,
    manifestPath,
    agent,
    projectRoot
  });

  // ---- HTTP ----
  const runtime = createRuntime({
    prefix: options.prefix || config.prefix || '/pilot',
    agent,
    store,
    profile,
    manifest,
    fileProvider,
    config,
    admin
  });

  return {
    config,
    manifest,
    profile,
    store,
    agent,
    providers,
    llm,

    /** 原生 http.Server 直接挂载（会接管该路径下的全部请求） */
    attach(server) {
      const inner = server.listeners('request').slice();
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        runtime.handle(req, res).then(
          (handled) => {
            if (handled) return;
            inner.forEach((fn) => fn.call(server, req, res));
          },
          () => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('SidePilot 内部错误');
          }
        );
      });
      console.log('[sidepilot] 已挂载，助手地址：http://localhost:' +
        (server.address() ? server.address().port : '?') + runtime.prefix);
      return this;
    },

    /** Express / Koa 风格的中间件挂载 */
    mount(app, prefix) {
      if (prefix && prefix !== runtime.prefix) {
        console.warn('[sidepilot] mount 的路径与配置不一致，以配置为准：' + runtime.prefix);
      }
      if (typeof app.use === 'function') {
        app.use((req, res, next) => {
          runtime.handle(req, res).then((handled) => {
            if (!handled && typeof next === 'function') next();
          });
        });
      } else if (typeof app.attach === 'function') {
        app.attach(this);
      } else {
        throw new Error('不认识这个 app 对象，请用 pilot.attach(server) 直接挂原生 http 服务');
      }
      return this;
    },

    /** 最底层：拿一个 (req,res) => Promise<boolean> 自己接 */
    handler() {
      return runtime.handle;
    }
  };
}

export default createPilot;
