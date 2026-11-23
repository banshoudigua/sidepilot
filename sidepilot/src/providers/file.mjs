// file 能力域：读写项目里的文件，供纯静态站使用
// 六道闸：路径白名单 / 写前快照 / 语法校验 / diff 预览确认 / 原子写入 / 一键回滚
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, relative, join, dirname, extname } from 'node:path';

/** 极简 HTML 标签平衡校验：抓住最常见的「改坏一个标签」 */
function checkHtmlBalance(html) {
  const voidTags = new Set(['br','hr','img','input','meta','link','area','base','col','embed','source','track','wbr']);
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let m;

  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const isClose = m[0].startsWith('</');
    const selfClose = /\/>$/.test(m[0]) || voidTags.has(tag);
    if (selfClose) continue;
    if (!isClose) {
      stack.push(tag);
    } else {
      if (stack.length === 0) return { ok: false, reason: '多余的闭合标签 </' + tag + '>' };
      const top = stack.pop();
      if (top !== tag) return { ok: false, reason: '标签不匹配：期望 </' + top + '>，实际 </' + tag + '>' };
    }
  }

  if (stack.length) return { ok: false, reason: '有未闭合的标签：<' + stack.join('>, <') + '>' };
  return { ok: true };
}

/** 轻量 diff：找出最短公共前后缀，中间部分就是改动块 */
function makeDiff(before, after, file) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);

  const lines = [];
  lines.push('@@ ' + file + ' 第 ' + (head + 1) + ' 行起 @@');
  removed.forEach((l) => lines.push('- ' + l));
  added.forEach((l) => lines.push('+ ' + l));
  return lines.join('\n');
}

export function createFileProvider(cfg) {
  // cfg: { root, editableDirs, backupDir, syntaxCheck }
  const root = resolve(cfg.root);
  const editableDirs = (cfg.editableDirs || ['www']).map((d) => resolve(root, d));
  const backupDir = resolve(cfg.backupDir || join(root, '.sidepilot/backups'));
  const syntaxCheck = cfg.syntaxCheck !== false;

  /** 第 1 道闸：路径必须落在白名单目录内 */
  function guardedPath(input) {
    if (!input) return { ok: false, reason: '缺少文件路径' };
    if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('/')) {
      return { ok: false, reason: '不接受绝对路径，请用相对项目根目录的路径' };
    }
    if (input.indexOf('..') >= 0) return { ok: false, reason: '不允许 .. 跳出项目目录' };

    const abs = resolve(root, input);
    const inAllowed = editableDirs.some((d) => abs === d || abs.startsWith(d + '\\') || abs.startsWith(d + '/'));
    if (!inAllowed) {
      return {
        ok: false,
        reason: '该路径不在允许编辑的目录内（允许：' + editableDirs.map((d) => relative(root, d)).join(', ') + '）'
      };
    }
    if (/[\\/](\.env|\.git|node_modules|[^\\/]*\.pem|[^\\/]*\.key)$/.test(abs)) {
      return { ok: false, reason: '该文件类型受保护，不允许编辑' };
    }
    if (!existsSync(abs)) return { ok: false, reason: '文件不存在：' + input };
    return { ok: true, abs, rel: relative(root, abs).replace(/\\/g, '/') };
  }

  /** 列出可编辑目录下的页面文件 */
  function listFiles() {
    const out = [];
    editableDirs.forEach((d) => {
      if (!existsSync(d)) return;
      const walk = (dir) => {
        readdirSync(dir, { withFileTypes: true }).forEach((it) => {
          const full = join(dir, it.name);
          if (it.isDirectory()) {
            if (it.name === 'node_modules' || it.name.startsWith('.')) return;
            walk(full);
          } else if (/\.(html?|css|js|json|md)$/i.test(it.name)) {
            out.push({
              path: relative(root, full).replace(/\\/g, '/'),
              size: statSync(full).size
            });
          }
        });
      };
      walk(d);
    });
    return out;
  }

  return {
    name: 'file',
    listFiles,

    tools() {
      return [
        {
          type: 'function',
          function: {
            name: 'file_list',
            description: '列出这个项目里可以编辑的页面文件',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
          }
        },
        {
          type: 'function',
          function: {
            name: 'file_read',
            description: '读取某个文件的完整内容（带行号）。改文件前必须先读它，确认原文。',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '相对项目根目录的路径，例如 www/index.html' }
              },
              required: ['path'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'file_edit',
            description:
              '修改文件。必须给出「原文片段 → 新片段」的替换对，不要给行号，不要输出整个文件。' +
              '原文片段必须在文件里唯一出现，否则会被拒绝。一次可以给多个替换对，全部校验通过才会保存。',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '相对项目根目录的路径' },
                edits: {
                  type: 'array',
                  description: '替换列表',
                  items: {
                    type: 'object',
                    properties: {
                      search: { type: 'string', description: '原文片段，必须与文件内容逐字一致' },
                      replace: { type: 'string', description: '替换成的内容' }
                    },
                    required: ['search', 'replace']
                  }
                }
              },
              required: ['path', 'edits'],
              additionalProperties: false
            }
          }
        }
      ];
    },

    isWrite(toolName) {
      return toolName === 'file_edit';
    },

    /** 预演：只算 diff 不落盘，给前端做确认卡片 */
    preview(toolName, args) {
      if (toolName !== 'file_edit') return { ok: false, reason: '不支持预演' };

      const p = guardedPath(args.path);
      if (!p.ok) return p;

      const before = readFileSync(p.abs, 'utf8');
      let after = before;

      for (const e of args.edits || []) {
        if (!e.search) return { ok: false, reason: '有替换项缺少原文片段' };
        const first = after.indexOf(e.search);
        if (first < 0) {
          return { ok: false, reason: '在 ' + p.rel + ' 里找不到这段原文：\n' + e.search.slice(0, 120) };
        }
        if (after.indexOf(e.search, first + 1) >= 0) {
          return { ok: false, reason: '这段原文在文件里出现了多次，无法确定改哪一处，请提供更长的上下文：\n' + e.search.slice(0, 120) };
        }
        after = after.slice(0, first) + e.replace + after.slice(first + e.search.length);
      }

      if (after === before) return { ok: false, reason: '替换后内容没有变化' };

      // 第 3 道闸：语法校验（HTML 标签平衡）
      if (syntaxCheck && extname(p.rel) === '.html') {
        const chk = checkHtmlBalance(after);
        if (!chk.ok) return { ok: false, reason: '改完后 HTML 结构不合法：' + chk.reason };
      }

      return {
        ok: true,
        abs: p.abs,
        rel: p.rel,
        before,
        after,
        diff: makeDiff(before, after, p.rel)
      };
    },

    /** 真正落盘：备份 → 原子写 */
    execute(toolName, args) {
      if (toolName === 'file_list') {
        return Promise.resolve({ ok: true, data: JSON.stringify(listFiles(), null, 1) });
      }

      if (toolName === 'file_read') {
        const p = guardedPath(args.path);
        if (!p.ok) return Promise.resolve(p);
        const text = readFileSync(p.abs, 'utf8');
        const numbered = text.split('\n').map((l, i) => String(i + 1).padStart(3, ' ') + '| ' + l).join('\n');
        return Promise.resolve({
          ok: true,
          data: numbered.length > 7000 ? numbered.slice(0, 7000) + '\n...[文件较长已截断，可用 search 精确匹配]' : numbered
        });
      }

      if (toolName !== 'file_edit') {
        return Promise.resolve({ ok: false, error: '未知工具：' + toolName });
      }

      // 落盘前重新预演一遍，确认结果依然合法（防止预览后文件被外部改动）
      const pre = this.preview('file_edit', args);
      if (!pre.ok) return Promise.resolve({ ok: false, error: pre.reason });

      // 第 2 道闸：写前快照
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(backupDir, stamp + '__' + pre.rel.replace(/[\\/]/g, '_'));
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, pre.before, 'utf8');

      // 第 5 道闸：先写临时文件再改名，避免写一半损坏
      const tmp = pre.abs + '.pilot-tmp';
      writeFileSync(tmp, pre.after, 'utf8');
      renameSync(tmp, pre.abs);

      return Promise.resolve({
        ok: true,
        rel: pre.rel,
        diff: pre.diff,
        before: pre.before,          // 回滚要用，必须原样带回
        after: pre.after,
        backup: relative(root, backupPath).replace(/\\/g, '/'),
        data: '已保存 ' + pre.rel + '，备份在 ' + relative(root, backupPath).replace(/\\/g, '/')
      });
    }
  };
}
