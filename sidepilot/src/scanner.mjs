// 路由扫描器：从源码里抽出接口清单
// 覆盖四种最常见写法，扫不到参数的标 low 置信度，交给 Agent 补全
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.sidepilot', 'dist', 'build', '.next', 'vendor', '__pycache__']);

/** 各种框架的路由写法 */
const PATTERNS = [
  // Express / Koa-router：app.get('/api/x', ...)  router.post('/api/x', ...)
  {
    name: 'express',
    re: /\b(?:app|router|server|api)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    pick: (m) => ({ method: m[1].toUpperCase(), path: m[2] })
  },
  // FastAPI / Flask 装饰器：@app.get("/x")  @router.post("/x")
  {
    name: 'fastapi',
    re: /@\w+\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi,
    pick: (m) => ({ method: m[1].toUpperCase(), path: m[2] })
  },
  // Flask：@app.route("/x", methods=["POST"])
  {
    name: 'flask',
    re: /@\w+\.route\s*\(\s*["']([^"']+)["']([^)]*)\)/gi,
    pick: (m) => {
      const mm = m[2].match(/methods\s*=\s*\[([^\]]+)\]/i);
      const method = mm ? mm[1].replace(/["'\s]/g, '').split(',')[0].toUpperCase() : 'GET';
      return { method, path: m[1] };
    }
  },
  // 原生 http：if (path === '/api/x' && req.method === 'GET')
  {
    name: 'node-http',
    re: /path(?:name)?\s*===?\s*['"`]([^'"`]+)['"`]/g,
    pick: (m, line) => {
      const mm = line.match(/req\.method\s*===?\s*['"](\w+)['"]/i);
      return { method: mm ? mm[1].toUpperCase() : 'GET', path: m[1] };
    }
  }
];

function walk(dir, out, root) {
  let items = [];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const it of items) {
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name) || it.name.startsWith('.')) continue;
      walk(join(dir, it.name), out, root);
    } else if (/\.(m?js|cjs|ts|py|php)$/i.test(it.name)) {
      const full = join(dir, it.name);
      try {
        if (statSync(full).size > 400 * 1024) continue; // 跳过超大文件
      } catch (e) { continue; }
      out.push(full);
    }
  }
}

/** 用路径推导一个语义化的工具名 */
function toolName(method, path) {
  const clean = path
    .replace(/^\/api\//, '')
    .replace(/[/{}:_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  const hasParam = /\{[^}]+\}|:[a-zA-Z]/.test(path);
  const verb = method === 'GET' ? (hasParam ? 'detail' : 'list')
    : method === 'POST' ? 'create'
    : method === 'DELETE' ? 'remove'
    : 'update';

  return (clean ? clean + '_' : '') + verb.toLowerCase();
}

/** 用路径推导中文名与分组 */
function inferMeta(method, path) {
  const seg = path.split('/').filter(Boolean);
  const groupRaw = seg[0] === 'api' ? seg[1] : seg[0];
  const group = groupRaw || '通用';

  const verbMap = { GET: '查询', POST: '新增', PUT: '修改', PATCH: '修改', DELETE: '删除' };
  const isList = method === 'GET' && !/\{[^}]+\}|:[a-zA-Z]/.test(path);
  const name = (verbMap[method] || '调用') + (isList ? '列表' : '') + ' ' + group;

  return {
    group,
    name,
    risk: method === 'GET' ? 'read' : method === 'DELETE' ? 'destructive' : 'write'
  };
}

/**
 * 扫描一个项目目录
 * @returns {{endpoints:Array, files:Array, stats:object}}
 */
export function scanProject(root) {
  const files = [];
  walk(root, files, root);

  const found = new Map(); // key: method + path
  const frameworks = new Set();

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const rel = relative(root, file).replace(/\\/g, '/');

    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text)) !== null) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        const lineText = lines[lineNo - 1] || '';
        let route = null;
        try { route = p.pick(m, lineText); } catch (e) { continue; }
        if (!route || !route.path) continue;
        if (route.path[0] !== '/') continue;          // 只认绝对路径
        if (route.path === '/') continue;             // 根路径通常是静态首页，不是接口
        if (/\.(png|jpg|css|js|ico)$/i.test(route.path)) continue;

        const key = route.method + ' ' + route.path;
        if (found.has(key)) continue;

        frameworks.add(p.name);
        const meta = inferMeta(route.method, route.path);
        found.set(key, {
          tool: toolName(route.method, route.path),
          method: route.method,
          path: route.path,
          name: meta.name,
          summary: '（参数待补全）',
          group: meta.group,
          risk: meta.risk,
          auth: { type: 'unknown' },
          params: [],
          responseHint: '',
          evidence: [{ file: rel, line: lineNo, note: '路由注册位置' }],
          confidence: 'low'
        });
      }
    }
  }

  // 纯静态站：没有接口，改为列出可编辑的页面
  const htmlFiles = [];
  const walkHtml = (dir) => {
    let items = [];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name) || it.name.startsWith('.')) continue;
        walkHtml(join(dir, it.name));
      } else if (/\.html?$/i.test(it.name)) {
        htmlFiles.push({
          path: relative(root, join(dir, it.name)).replace(/\\/g, '/'),
          label: it.name.replace(/\.html?$/i, ''),
          editable: true
        });
      }
    }
  };
  walkHtml(root);

  return {
    endpoints: Array.from(found.values()),
    files: htmlFiles,
    stats: {
      scannedFiles: files.length,
      routesFound: found.size,
      staticPages: htmlFiles.length,
      frameworks: Array.from(frameworks)
    }
  };
}
