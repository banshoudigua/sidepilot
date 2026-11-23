// 示例二：纯静态站 —— 演示「独立模式 + 反向代理」
//
// 这个进程只做两件事：
//   1. 把 www 下的文件发出去（业务本身）
//   2. 把 /pilot 开头的请求转发给独立的助手进程（模拟 nginx 反代）
//
// 助手进程单独跑：node ../../cli/serve.mjs --port 7788
// 真实项目里第 2 件事交给 nginx / IIS ARR / Apache mod_proxy 做，
// 业务代码一行都不用改。PHP、Java、.NET 都是这个接法。
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8081);
const PILOT_PORT = Number(process.env.PILOT_PORT || 7788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

/** 把请求原样转给助手进程。生产环境这段由 nginx 完成 */
function proxyToPilot(req, res) {
  const headers = Object.assign({}, req.headers);
  delete headers.host;

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: PILOT_PORT,
    path: req.url,
    method: req.method,
    headers
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);   // 流式转发，SSE 不会卡住
  });

  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<body style="font-family:sans-serif;padding:40px">' +
      '<h1 style="font-weight:400">助手没启动</h1>' +
      '<p>先在这个目录跑：<code>node ../../cli/serve.mjs --port ' + PILOT_PORT + '</code></p>' +
      '</body>'
    );
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 助手相关请求全部转走，业务站完全不参与
  if (url.pathname === '/pilot' || url.pathname.indexOf('/pilot/') === 0) {
    proxyToPilot(req, res);
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const abs = join(HERE, 'www', file);

  if (!existsSync(abs)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>没有这个页面：' + file + '</p>');
    return;
  }

  res.writeHead(200, { 'Content-Type': MIME[extname(abs)] || 'text/plain; charset=utf-8' });
  res.end(readFileSync(abs));
});

server.listen(PORT, () => {
  console.log('');
  console.log('  山间咖啡官网（纯静态业务站）');
  console.log('  网站        http://localhost:' + PORT + '/');
  console.log('  助手入口    http://localhost:' + PORT + '/pilot        （反代到 ' + PILOT_PORT + '）');
  console.log('');
  console.log('  助手是独立进程，需要先启动：');
  console.log('    node ../../cli/serve.mjs --port ' + PILOT_PORT);
  console.log('');
  console.log('  线上把这段反代交给 nginx：');
  console.log('    location /pilot/ { proxy_pass http://127.0.0.1:' + PILOT_PORT + '; }');
  console.log('');
});
