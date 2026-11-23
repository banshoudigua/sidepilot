#!/usr/bin/env node
// SidePilot 独立模式
// 把助手单独跑成一个进程，再用反向代理挂到任何语言的站点下：
//   PHP / Java / .NET / 纯静态，统统不用改一行业务代码
//
// 用法（在项目根目录执行）：
//   node <sidepilot>/cli/serve.mjs --config ./.sidepilot/config.json --port 7788
//
// nginx 反代（注意 proxy_pass 后面不带斜杠，保留 /pilot 前缀）：
//   location /pilot/ { proxy_pass http://127.0.0.1:7788; }
import http from 'node:http';
import { resolve } from 'node:path';
import { createPilot } from '../src/index.mjs';

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const configPath = resolve(String(flag('config', './.sidepilot/config.json')));
const port = Number(flag('port', 7788));
const host = String(flag('host', '127.0.0.1'));

console.log('');
console.log('  SidePilot 独立模式');
console.log('  配置  ' + configPath);
console.log('');

// 配置不存在时 createPilot 会抛错并说明怎么生成，这里不重复判断
const pilot = createPilot({ config: configPath });
const handler = pilot.handler();

const server = http.createServer((req, res) => {
  handler(req, res).then(
    (handled) => {
      // 不在 /pilot 前缀下的请求不归这个进程管
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8">' +
        '<body style="font-family:sans-serif;padding:40px;color:#333">' +
        '<h1 style="font-weight:400">404</h1>' +
        '<p>这个地址不归 SidePilot 管。助手在 <b>' + (pilot.config.prefix || '/pilot') + '</b> 下。</p>' +
        '</body>'
      );
    },
    (err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('SidePilot 内部错误：' + (err && err.message));
    }
  );
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('  端口 ' + port + ' 已被占用，换一个：--port 7799');
    process.exit(1);
  }
  console.error('  启动失败：' + err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  const base = 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port;
  console.log('  已启动  ' + base);
  console.log('');
  console.log('  助手     ' + base + '/pilot');
  console.log('  文档     ' + base + '/pilot/docs');
  console.log('  管理端   ' + base + '/pilot/admin');
  console.log('');
  console.log('  接入方式：把业务站点的 /pilot 反向代理到这个端口即可');
  console.log('');
});
