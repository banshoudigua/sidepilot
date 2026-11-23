#!/usr/bin/env node
// sidepilot 命令行：init / scan / uninstall
import { writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanProject } from '../src/scanner.mjs';
import { probeEndpoints } from '../src/probe.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
}

const root = resolve(flag('root', process.cwd()));
const dir = join(root, '.sidepilot');

function banner() {
  console.log('');
  console.log('  SidePilot · 给这个项目装一个 AI 助手');
  console.log('  项目目录  ' + root);
  console.log('');
}

/** 生成默认配置。已存在则不覆盖，只补缺失项 */
function ensureConfig(scanResult) {
  const path = join(dir, 'config.json');
  // 以扫描结果判断项目类型，比看有没有 package.json 准
  const isStatic = scanResult.stats.routesFound === 0 && scanResult.stats.staticPages > 0;

  if (existsSync(path)) {
    console.log('  配置已存在，保留原文件：.sidepilot/config.json');
    return;
  }

  const cfg = {
    project: { name: flag('name', '我的项目'), slug: 'my-project' },
    projectRoot: '.',
    prefix: '/pilot',
    manifestPath: './.sidepilot/manifest.json',
    dbPath: './.sidepilot/pilot.db',
    llm: {
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.3
    },
    api: { baseUrl: 'http://127.0.0.1:8080' },
    file: { editableDirs: isStatic ? ['www'] : ['public'], syntaxCheck: true },
    profile: {
      name: flag('name', '我的项目'),
      kind: isStatic ? 'static_site' : 'api_app',
      audience: 'internal',
      domain: '',
      topTasks: [],
      capabilities: isStatic ? ['file'] : ['api', 'db'],
      restricted: [],
      decidedBy: 'auto-detected'
    }
  };

  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
  console.log('  已生成配置：.sidepilot/config.json（记得填 llm.apiKey）');
}

function runInit() {
  banner();
  mkdirSync(dir, { recursive: true });

  console.log('  正在扫描路由…');
  const result = scanProject(root);

  const manifest = {
    spec: 'sidepilot.manifest/1',
    project: { name: flag('name', '我的项目'), slug: 'my-project' },
    generatedBy: { agent: 'sidepilot init', at: new Date().toISOString() },
    source: {
      root: '.',
      lang: result.stats.frameworks.length ? ['javascript'] : ['html'],
      framework: result.stats.frameworks,
      scannedFiles: result.stats.scannedFiles,
      routesFound: result.stats.routesFound
    },
    endpoints: result.endpoints,
    files: result.files,
    missing: []
  };

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  ensureConfig(result);

  // 打印结果
  console.log('');
  console.log('  扫描完成');
  console.log('  ─────────────────────────────');
  console.log('  扫描文件      ' + result.stats.scannedFiles + ' 个');
  console.log('  发现接口      ' + result.stats.routesFound + ' 个');
  console.log('  静态页面      ' + result.stats.staticPages + ' 个');
  if (result.stats.frameworks.length) {
    console.log('  识别框架      ' + result.stats.frameworks.join(' / '));
  }
  console.log('');
  console.log('  已生成');
  console.log('    .sidepilot/manifest.json   接口清单');
  console.log('    .sidepilot/config.json     运行配置');
  console.log('');

  if (result.stats.routesFound > 0) {
    console.log('  下一步');
    console.log('    1. 打开 .sidepilot/config.json，填 llm.apiKey 与 api.baseUrl');
    console.log('    2. 在入口文件挂载（见 README「两种接入方式」）');
    console.log('    3. 启动项目，访问 /pilot');
    console.log('    4. 跑一次接口自测，把猜的参数换成验证过的：');
    console.log('         node <sidepilot目录>/cli/index.mjs probe --root .');
  } else if (result.stats.staticPages > 0) {
    console.log('  这是个纯静态项目，已开启「编辑页面」能力。');
    console.log('  下一步：填 llm.apiKey，挂载后访问 /pilot，可以直接让助手改页面。');
  } else {
    console.log('  没扫到接口也没扫到页面，请确认项目目录是否正确。');
  }

  const lowCount = result.endpoints.filter((e) => e.confidence === 'low').length;
  if (lowCount > 0) {
    console.log('');
    console.log('  提示：有 ' + lowCount + ' 个接口的参数还没解析出来（confidence = low）。');
    console.log('  可以让 AI 助手读源码补全：把 .sidepilot/manifest.json 里标 low 的条目补齐即可。');
  }
  console.log('');
}

function runScan() {
  const result = scanProject(root);
  console.log('扫描完成：' + result.stats.routesFound + ' 个接口，' + result.stats.staticPages + ' 个页面');
  result.endpoints.forEach((e) => {
    console.log('  ' + e.method.padEnd(6) + e.path + '   [' + e.risk + ']  ' + e.evidence[0].file + ':' + e.evidence[0].line);
  });
}

// 接口自测：连真实业务系统调一次只读接口，把返回结构写回清单
function runProbe() {
  banner();

  const manifestPath = join(dir, 'manifest.json');
  const configPath = join(dir, 'config.json');
  if (!existsSync(manifestPath)) {
    console.log('  没找到 .sidepilot/manifest.json，先跑一次 init。');
    return;
  }
  if (!existsSync(configPath)) {
    console.log('  没找到 .sidepilot/config.json，先跑一次 init。');
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const baseUrl = (cfg.api && cfg.api.baseUrl) || flag('base', '');

  if (!baseUrl) {
    console.log('  config.json 里还没填 api.baseUrl。');
    console.log('  这个地址要指向「业务系统启动后的地址」，例如 http://127.0.0.1:3000');
    return;
  }

  console.log('  业务系统  ' + baseUrl);
  console.log('  正在逐个调用只读接口（只测 GET，不动数据）…');
  console.log('');

  probeEndpoints({
    baseUrl: baseUrl,
    endpoints: manifest.endpoints || [],
    headers: (cfg.api && cfg.api.headers) || {},
    timeoutMs: 4000
  }).then((stats) => {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // 逐条打印，失败的要能一眼看出是哪个
    (manifest.endpoints || []).forEach((e) => {
      if (!e.probe) return;
      if (e.probe.ok) {
        console.log('  ✓ ' + e.path.padEnd(30) + (e.probe.shape || ''));
      } else {
        console.log('  ✗ ' + e.path.padEnd(30) + (e.probe.error || '失败'));
      }
    });

    console.log('');
    console.log('  通过 ' + stats.passed + ' / 测试 ' + stats.tested + '，失败 ' + stats.failed + '，跳过 ' + stats.skipped);
    if (stats.skipped) {
      console.log('  跳过的都是 POST/PUT/DELETE 或带路径参数的接口（没法安全测）。');
    }
    console.log('');
    console.log('  返回结构已写回 manifest，AI 下次就会按真实字段名回答。');
    console.log('');
  });
}

function runUninstall() {
  banner();
  if (!existsSync(dir)) {
    console.log('  没有找到 .sidepilot 目录，可能已经卸载过了。');
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('  已删除 .sidepilot 目录。');
  console.log('');
  console.log('  还需要手动做两件事：');
  console.log('    1. 删掉入口文件里 createPilot 那两行');
  console.log('    2. 卸载依赖：npm uninstall sidepilot');
  console.log('');
}

switch (cmd) {
  case 'init':
    runInit();
    break;
  case 'scan':
    runScan();
    break;
  case 'probe':
    runProbe();
    break;
  case 'uninstall':
    runUninstall();
    break;
  default:
    console.log('');
    console.log('  sidepilot <命令>');
    console.log('');
    console.log('    init        扫描项目，生成接口清单与配置');
    console.log('    scan        只重新扫描，不改配置');
    console.log('    probe       调一遍只读接口，把真实返回结构写回清单');
    console.log('    uninstall   删除 .sidepilot 目录');
    console.log('');
    console.log('  可选参数');
    console.log('    --root <dir>   指定项目目录，默认当前目录');
    console.log('    --name <name>  项目名');
    console.log('    --base <url>   probe 时临时指定业务系统地址');
    console.log('');
  }
