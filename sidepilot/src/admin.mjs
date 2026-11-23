// 管理端 API：概览、配置、接口清单、扫描、调用日志
// 与 runtime 分开，避免主路由文件膨胀
import { writeConfig, maskKey, isMasked } from './config.mjs';
import { scanProject } from './scanner.mjs';
import { probeEndpoints } from './probe.mjs';

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        done({});
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return done({});
      try {
        done(JSON.parse(text));
      } catch (e) {
        done({});
      }
    });
    req.on('error', () => done({}));
  });
}

export function createAdmin(cfg) {
  // cfg: { config, configPath, store, manifest, manifestPath, agent, projectRoot }
  const config = cfg.config;
  const store = cfg.store;
  const manifest = cfg.manifest;

  const get = (sql, ...args) => store.db.prepare(sql).get(...args);
  const all = (sql, ...args) => store.db.prepare(sql).all(...args);

  /** 保存 manifest 到磁盘 */
  function persistManifest() {
    writeConfig(cfg.manifestPath, manifest);
  }

  /** 保存 config 到磁盘 */
  function persistConfig() {
    writeConfig(cfg.configPath, config);
  }

  function overview() {
    const s = get('SELECT COUNT(*) AS c FROM sessions').c;
    const m = get('SELECT COUNT(*) AS c FROM messages').c;
    const t = get('SELECT COUNT(*) AS c FROM tool_logs').c;
    const e = get('SELECT COUNT(*) AS c FROM edits').c;
    const startToday = new Date().setHours(0, 0, 0, 0);
    const today = get('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?', startToday).c;

    // 近 7 天每天的消息量，画个小柱状图
    const recent = [];
    for (let i = 6; i >= 0; i--) {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - i);
      const to = from.getTime() + 86400000;
      const cnt = get('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ? AND created_at < ?', from.getTime(), to).c;
      recent.push({
        day: (from.getMonth() + 1) + '/' + from.getDate(),
        count: cnt
      });
    }

    const eps = manifest.endpoints || [];
    const enabled = eps.filter((x) => x.enabled !== false).length;

    // 反馈与自测情况：概览上要知道"有多少条答得不好"
    const fbDown = get("SELECT COUNT(*) AS c FROM feedback WHERE rating = 'down'").c;
    const fbAll = get('SELECT COUNT(*) AS c FROM feedback').c;
    const probed = eps.filter((x) => x.probe && x.probe.ok).length;
    // 接口自测没覆盖到的（参数还没验证过）
    const unverified = eps.filter((x) => x.enabled !== false && !(x.probe && x.probe.ok)).length;

    return {
      project: {
        name: (config.project && config.project.name) || '未命名项目',
        kind: (config.profile && config.profile.kind) || 'api_app'
      },
      stats: {
        sessions: s,
        messages: m,
        toolCalls: t,
        edits: e,
        todayMessages: today,
        endpoints: eps.length,
        enabledEndpoints: enabled,
        pages: (manifest.files || []).length,
        feedbackDown: fbDown,
        feedbackAll: fbAll,
        probed: probed,
        unverified: unverified
      },
      recent
    };
  }

  /** 读配置：密钥打码 */
  function getConfig() {
    const copy = JSON.parse(JSON.stringify(config));
    if (copy.llm) copy.llm.apiKeyMasked = maskKey(copy.llm.apiKey);
    if (copy.llm) delete copy.llm.apiKey;
    return copy;
  }

  /** 存配置：只接受白名单字段，避免把奇怪的东西写进去 */
  function saveConfig(patch, userId) {
    const needRestart = [];
    const changed = [];

    if (patch.llm) {
      config.llm = config.llm || {};
      if (typeof patch.llm.baseUrl === 'string' && patch.llm.baseUrl.trim() !== config.llm.baseUrl) {
        config.llm.baseUrl = patch.llm.baseUrl.trim();
        changed.push('llm.baseUrl');
      }
      if (typeof patch.llm.model === 'string' && patch.llm.model.trim() !== config.llm.model) {
        config.llm.model = patch.llm.model.trim();
        changed.push('llm.model');
      }
      if (patch.llm.temperature != null && Number(patch.llm.temperature) !== config.llm.temperature) {
        config.llm.temperature = Number(patch.llm.temperature);
        changed.push('llm.temperature');
      }
      // 提交的是掩码说明用户没动，保持原值
      if (typeof patch.llm.apiKey === 'string' && patch.llm.apiKey && !isMasked(patch.llm.apiKey)) {
        config.llm.apiKey = patch.llm.apiKey.trim();
        // 密钥本身绝不进审计日志，只记"改过"
        changed.push('llm.apiKey');
      }
      // 计费单价：改了才能算成本
      if (patch.llm.pricing) {
        config.llm.pricing = config.llm.pricing || {};
        if (patch.llm.pricing.inputPerMillion != null) {
          config.llm.pricing.inputPerMillion = Number(patch.llm.pricing.inputPerMillion);
          changed.push('llm.pricing.inputPerMillion');
        }
        if (patch.llm.pricing.outputPerMillion != null) {
          config.llm.pricing.outputPerMillion = Number(patch.llm.pricing.outputPerMillion);
          changed.push('llm.pricing.outputPerMillion');
        }
      }
    }

    if (patch.profile) {
      config.profile = config.profile || {};
      ['name', 'domain', 'audience', 'topTasks', 'restricted'].forEach((k) => {
        if (patch.profile[k] !== undefined) {
          config.profile[k] = patch.profile[k];
          changed.push('profile.' + k);
        }
      });
      if (Array.isArray(patch.profile.capabilities) && patch.profile.capabilities.join() !== (config.profile.capabilities || []).join()) {
        config.profile.capabilities = patch.profile.capabilities;
        needRestart.push('能力域变更');
        changed.push('profile.capabilities');
      }
    }

    if (patch.prompt) {
      config.prompt = config.prompt || {};
      if (typeof patch.prompt.extra === 'string' && patch.prompt.extra !== config.prompt.extra) {
        config.prompt.extra = patch.prompt.extra;
        changed.push('prompt.extra');
      }
    }

    if (patch.guard) {
      config.guard = config.guard || {};
      ['maxRounds', 'resultLimit', 'confirmTimeout'].forEach((k) => {
        if (patch.guard[k] != null) {
          config.guard[k] = Number(patch.guard[k]);
          changed.push('guard.' + k);
        }
      });
    }

    persistConfig();

    // 配置改动是敏感操作，必须留痕
    if (changed.length) {
      store.audit(null, 'config_change', 'config.json', { fields: changed }, userId || 'admin');
    }

    return { ok: true, needRestart, changed: changed };
  }

  function listEndpoints() {
    return (manifest.endpoints || []).map((e) => ({
      tool: e.tool,
      method: e.method,
      path: e.path,
      name: e.name || '',
      summary: e.summary || '',
      group: e.group || '未分组',
      risk: e.risk || 'write',
      enabled: e.enabled !== false,
      confidence: e.confidence || 'medium',
      params: e.params || [],
      evidence: e.evidence || [],
      responseHint: e.responseHint || '',
      probe: e.probe || null
    }));
  }

  /** 新增或修改一条接口。以 method + path 作为主键 */
  function upsertEndpoint(ep) {
    if (!ep || !ep.method || !ep.path) return { ok: false, error: 'method 与 path 必填' };
    const list = manifest.endpoints || (manifest.endpoints = []);
    const idx = list.findIndex((x) => x.method === ep.method && x.path === ep.path);

    const base = idx >= 0 ? list[idx] : {
      tool: (ep.path.replace(/^\/api\//, '').replace(/[/{}:_-]+/g, '_').replace(/^_+|_+$/g, '') || 'endpoint') +
            (ep.method === 'GET' ? '_list' : '_write'),
      params: [],
      evidence: [],
      confidence: 'medium'
    };

    const merged = Object.assign({}, base, {
      method: ep.method,
      path: ep.path,
      name: ep.name != null ? ep.name : base.name,
      summary: ep.summary != null ? ep.summary : base.summary,
      group: ep.group != null ? ep.group : base.group,
      risk: ep.risk || base.risk,
      enabled: ep.enabled != null ? !!ep.enabled : (base.enabled !== false),
      tool: ep.tool || base.tool
    });

    if (idx >= 0) list[idx] = merged;
    else list.push(merged);

    persistManifest();
    return { ok: true, endpoint: merged, created: idx < 0 };
  }

  function deleteEndpoint(method, path) {
    const list = manifest.endpoints || [];
    const idx = list.findIndex((x) => x.method === method && x.path === path);
    if (idx < 0) return { ok: false, error: '没有这条接口' };
    const [removed] = list.splice(idx, 1);
    persistManifest();
    return { ok: true, removed };
  }

  /** 重新扫描：已存在的接口保留（不覆盖手工改过的名字与开关），只补新增 */
  function rescan() {
    const result = scanProject(cfg.projectRoot);
    const list = manifest.endpoints || (manifest.endpoints = []);
    const seen = new Set(list.map((x) => x.method + ' ' + x.path));

    let added = 0;
    result.endpoints.forEach((e) => {
      if (seen.has(e.method + ' ' + e.path)) return;
      list.push(e);
      added++;
    });

    if (result.files && result.files.length) {
      manifest.files = result.files;
    }

    manifest.source = manifest.source || {};
    manifest.source.scannedFiles = result.stats.scannedFiles;
    manifest.source.routesFound = result.stats.routesFound;
    manifest.source.framework = result.stats.frameworks;

    persistManifest();
    return { ok: true, added, total: list.length, scanned: result.stats };
  }

  function listLogs(limit = 80) {
    return all(
      'SELECT id, session_id, name, args, status, duration_ms, created_at FROM tool_logs ORDER BY id DESC LIMIT ?',
      limit
    );
  }

  /** 管理端操作人：优先请求头，其次 query。都没有就记 admin（本机维护者） */
  function whoami(req) {
    const h = req.headers['x-pilot-user'];
    if (h) return String(h);
    const q = new URL(req.url, 'http://localhost').searchParams.get('user');
    return q || 'admin';
  }

  /** 处理管理端请求，返回 true 表示已接管 */
  async function handle(req, res, sub) {
    if (!sub.startsWith('/api/admin')) return false;

    const path = sub.replace('/api/admin', '') || '/';

    if (path === '/overview') {
      sendJson(res, 200, overview());
      return true;
    }

    if (path === '/config' && req.method === 'GET') {
      sendJson(res, 200, { config: getConfig() });
      return true;
    }

    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, saveConfig(body || {}, whoami(req)));
      return true;
    }

    if (path === '/prompt') {
      sendJson(res, 200, { system: cfg.agent.getSystemPrompt() });
      return true;
    }

    if (path === '/endpoints' && req.method === 'GET') {
      sendJson(res, 200, { endpoints: listEndpoints() });
      return true;
    }

    if (path === '/endpoints' && req.method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, upsertEndpoint(body.endpoint || body));
      return true;
    }

    if (path === '/endpoints/delete' && req.method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, deleteEndpoint(body.method, body.path));
      return true;
    }

    if (path === '/scan' && req.method === 'POST') {
      sendJson(res, 200, rescan());
      return true;
    }

    // 接口自测：业务系统必须在跑，否则会全失败
    if (path === '/probe' && req.method === 'POST') {
      const baseUrl = (config.api && config.api.baseUrl) || '';
      if (!baseUrl) {
        sendJson(res, 400, { ok: false, error: '还没有配置 api.baseUrl，先在「模型与提示词」里填业务系统地址' });
        return true;
      }

      const stats = await probeEndpoints({
        baseUrl: baseUrl,
        endpoints: manifest.endpoints || [],
        headers: (config.api && config.api.headers) || {},
        timeoutMs: 4000
      });

      persistManifest();
      sendJson(res, 200, { ok: true, stats: stats, endpoints: listEndpoints() });
      return true;
    }

    if (path === '/logs') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      sendJson(res, 200, { logs: store.listToolLogs(80, q.get('userId') || undefined) });
      return true;
    }

    // 回答反馈：默认只看差评，?all=1 看全部
    if (path === '/feedback') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      sendJson(res, 200, { feedback: store.listFeedback(60, q.get('all') !== '1') });
      return true;
    }

    // 操作审计：谁在什么时候动了什么
    if (path === '/audit') {
      const rows = store.listAudit(120);
      // detail 在写入时已转成可读文本，这里不再解析，前端拿到就能显示
      const audit = rows.map((a) => ({
        id: a.id,
        sessionId: a.session_id,
        sessionTitle: a.session_title || '',
        userId: a.user_id || '',
        action: a.action,
        target: a.target,
        detail: a.detail || '',
        at: a.created_at
      }));

      sendJson(res, 200, { audit: audit });
      return true;
    }

    // 用量与成本
    if (path === '/usage') {
      const summary = store.usageSummary(30);
      const pricing = (config.llm && config.llm.pricing) || {};
      const inPrice = Number(pricing.inputPerMillion || 0);
      const outPrice = Number(pricing.outputPerMillion || 0);

      // 单价可配，没配就只报 token 不算钱，免得报个假数字
      const cost = inPrice || outPrice
        ? (summary.promptTokens / 1e6 * inPrice) + (summary.completionTokens / 1e6 * outPrice)
        : null;

      sendJson(res, 200, {
        summary: summary,
        pricing: { inputPerMillion: inPrice, outputPerMillion: outPrice },
        estimatedCost: cost
      });
      return true;
    }

    sendJson(res, 404, { ok: false, error: '未知的管理接口：' + path });
    return true;
  }

  return { handle, overview, getConfig, saveConfig, listEndpoints, listLogs };
}
