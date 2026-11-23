// HTTP 运行时：把助手、文档站、API 挂到宿主项目的某个路径下
// 不依赖任何框架，同时兼容 Express（handler 支持 (req,res,next) 签名）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(HERE, '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/** 读取请求体（限制 8MB，防止大图撑爆） */
export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        done('');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(''));
  });
}

/**
 * 解析 JSON 请求体。外部输入不可信，解析失败一律返回空对象，
 * 不让一颗坏 JSON 把整个请求打成 500。集中在这一处兜。
 */
function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text) || {};
  } catch (e) {
    return {};
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * 按接口清单生成首屏「你可以问我」。
 * 用户打开只看到一个空输入框，不知道该问什么——这一句能救回来。
 */
function suggestQuestions(manifest) {
  const eps = (manifest.endpoints || []).filter((e) => e.enabled !== false);
  const out = [];
  const seen = {};

  const push = function (q) {
    if (!q || seen[q]) return;
    seen[q] = true;
    out.push(q);
  };

  eps.forEach(function (e) {
    const name = String(e.name || '').trim();
    const group = String(e.group || '').trim();
    const subject = name || group;
    if (!subject) return;

    if (e.risk !== 'read' && e.risk !== undefined) {
      // 写接口给一条"新增"的示范
      if (/新增|创建|添加|create/i.test(name)) {
        push('帮我新增一条' + subject.replace(/新增|创建|添加/g, '') + '记录');
      }
      return;
    }

    if (/统计|汇总|报表|分析/.test(name)) {
      push('最近 30 天的' + name.replace(/统计|汇总|报表|分析/g, '') + '情况怎么样？');
    } else if (/列表|清单|查询/.test(name)) {
      push(name.replace(/列表|清单|查询/g, '') + '都有哪些？');
    } else if (/订单/.test(name)) {
      push('最近有哪些' + subject.replace(/最近/, '') + '？');
    } else {
      push(subject + '现在是什么情况？');
    }
  });

  return out.slice(0, 4);
}

/** 解析当前用户：反代注入的请求头优先，其次是 query，都没有就当匿名 */
function resolveUser(req, url) {
  const h = req.headers['x-pilot-user'];
  if (h) return String(h).slice(0, 64);
  const q = url.searchParams.get('user') || url.searchParams.get('userId');
  if (q) return String(q).slice(0, 64);
  return undefined;
}

function sendFile(res, absPath) {
  if (!existsSync(absPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到 ' + absPath);
    return;
  }
  const buf = readFileSync(absPath);
  res.writeHead(200, {
    'Content-Type': MIME[extname(absPath)] || 'application/octet-stream',
    // 界面资源不缓存：改样式/脚本后刷新立刻生效，避免"改了没变化"的错觉
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(buf);
}

export function createRuntime(cfg) {
  // cfg: { prefix, agent, store, profile, manifest, fileProvider, config }
  const prefix = (cfg.prefix || '/pilot').replace(/\/+$/, '');
  const agent = cfg.agent;
  const store = cfg.store;
  const profile = cfg.profile;

  /** SSE 通道封装 */
  function openSSE(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    return (obj) => {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    };
  }

  /** 文档站要用的数据：把 manifest 转成渲染友好的结构 */
  function docData() {
    const eps = (cfg.manifest.endpoints || []);
    const groups = {};
    eps.forEach((e) => {
      const g = e.group || '未分组';
      (groups[g] = groups[g] || []).push(e);
    });
    return {
      project: cfg.manifest.project,
      groups: Object.keys(groups).map((g) => ({ name: g, endpoints: groups[g] })),
      files: cfg.manifest.files || [],
      stats: {
        total: eps.length,
        read: eps.filter((e) => e.risk === 'read').length,
        write: eps.filter((e) => e.risk !== 'read').length,
        files: (cfg.manifest.files || []).length
      }
    };
  }

  /**
   * 处理一个请求。返回 true 表示这个请求归 SidePilot 管
   */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path !== prefix && !path.startsWith(prefix + '/')) return false;

    // 访问 /pilot（结尾没斜杠）时，页面内的相对路径会解析到根目录，导致 CSS/JS 全 404
    // 统一 302 到带斜杠的地址
    if (path === prefix) {
      res.writeHead(302, { Location: prefix + '/' });
      res.end();
      return true;
    }

    const sub = path.slice(prefix.length) || '/';

    // 管理端接口交给独立模块处理
    if (sub.indexOf('/api/admin') === 0 && cfg.admin) {
      return cfg.admin.handle(req, res, sub);
    }

    // ---- 静态资源 ----
    if (sub === '/sdk.js') return sendFile(res, join(UI_DIR, 'sdk.js')), true;
    if (sub === '/chat.js') return sendFile(res, join(UI_DIR, 'chat.js')), true;
    if (sub === '/chat.css') return sendFile(res, join(UI_DIR, 'chat.css')), true;
    if (sub === '/docs.js') return sendFile(res, join(UI_DIR, 'docs.js')), true;
    if (sub === '/docs.css') return sendFile(res, join(UI_DIR, 'docs.css')), true;
    if (sub === '/admin.js') return sendFile(res, join(UI_DIR, 'admin.js')), true;
    if (sub === '/admin.css') return sendFile(res, join(UI_DIR, 'admin.css')), true;

    if (sub === '/' || sub === '/chat') return sendFile(res, join(UI_DIR, 'chat.html')), true;
    if (sub === '/docs') return sendFile(res, join(UI_DIR, 'docs.html')), true;
    if (sub === '/admin') return sendFile(res, join(UI_DIR, 'admin.html')), true;

    // ---- 引导数据 ----
    if (sub === '/api/bootstrap') {
      sendJson(res, 200, {
        profile,
        prefix,
        user: resolveUser(req, url) || null,
        suggestions: suggestQuestions(cfg.manifest),
        tools: agent.listTools().map((t) => ({ name: t.function.name, desc: t.function.description })),
        docsUrl: prefix + '/docs'
      });
      return true;
    }

    // ---- 历史会话 ----
    if (sub === '/api/sessions') {
      const uid = resolveUser(req, url);
      sendJson(res, 200, { sessions: store.listSessions(40, uid), user: uid || null });
      return true;
    }

    // ---- 回答反馈 ----
    if (sub === '/api/feedback' && req.method === 'POST') {
      const body = await readBody(req);
      const input = parseJson(body);
      if (!input.messageId || !input.rating) {
        sendJson(res, 400, { ok: false, error: 'messageId 与 rating 必填' });
        return true;
      }
      store.addFeedback(Number(input.messageId), input.sessionId, input.rating, input.note);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (sub === '/api/feedback') {
      const sid = url.searchParams.get('sessionId') || '';
      sendJson(res, 200, { ratings: sid ? store.getFeedbackMap(sid) : {} });
      return true;
    }

    if (sub === '/api/history') {
      const sid = url.searchParams.get('sessionId') || '';
      if (!sid) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
        return true;
      }
      sendJson(res, 200, {
        sessionId: sid,
        exists: store.hasSession(sid),
        messages: store.listDisplayMessages(sid)
      });
      return true;
    }

    if (sub === '/api/session/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const input = parseJson(body);
      if (!input.sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
        return true;
      }
      store.deleteSession(input.sessionId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ---- 对话（SSE）----
    if (sub === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const input = parseJson(body);
      const sessionId = input.sessionId || 'anon';
      const emit = openSSE(res);

      const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

      agent.start({
        sessionId,
        userText: input.text || '',
        images: input.images || [],
        userId: input.userId || resolveUser(req, url),
        onEvent: (e) => emit(e)
      }).then(
        () => {
          clearInterval(keepAlive);
          res.end();
        },
        (err) => {
          clearInterval(keepAlive);
          emit({ type: 'error', message: String(err && err.message) });
          res.end();
        }
      );
      return true;
    }

    // ---- 确认写操作 ----
    if (sub === '/api/confirm' && req.method === 'POST') {
      const body = await readBody(req);
      const input = parseJson(body);
      const emit = openSSE(res);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

      agent.confirm({
        sessionId: input.sessionId || 'anon',
        decision: input.decision,
        userId: input.userId || resolveUser(req, url),
        onEvent: (e) => emit(e)
      }).then(
        () => {
          clearInterval(keepAlive);
          res.end();
        },
        (err) => {
          clearInterval(keepAlive);
          emit({ type: 'error', message: String(err && err.message) });
          res.end();
        }
      );
      return true;
    }

    // ---- 文件编辑历史与回滚 ----
    if (sub === '/api/edits') {
      sendJson(res, 200, { edits: store.listEdits(30) });
      return true;
    }

    if (sub === '/api/rollback' && req.method === 'POST') {
      const body = await readBody(req);
      const input = parseJson(body);
      const row = store.getEdit(input.id);
      if (!row) {
        sendJson(res, 404, { ok: false, error: '没有这条编辑记录' });
        return true;
      }
      // 用编辑前的全文还原：交给 file provider 走同一套白名单校验
      const fp = cfg.fileProvider;
      const target = fp && fp.rollbackTo ? fp.rollbackTo(row.file, row.before_text) : { ok: false, reason: '当前项目不支持回滚' };
      sendJson(res, target.ok ? 200 : 400, target);
      return true;
    }

    // ---- 文档数据 ----
    if (sub === '/api/docs') {
      sendJson(res, 200, docData());
      return true;
    }

    sendJson(res, 404, { ok: false, error: '未知路径 ' + sub });
    return true;
  }

  return { handle, prefix, docData };
}
