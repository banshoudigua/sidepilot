// db 能力域：只读查询
// 四层护栏的第 1 层在代码里（语法白名单），第 2 层靠连接只读打开
import { DatabaseSync } from 'node:sqlite';

/** 语句级护栏：只放行单条 SELECT / WITH */
export function checkSqlReadonly(sql) {
  const s = String(sql || '').trim();
  if (!s) return { ok: false, reason: '空语句' };

  if (s.replace(/;\s*$/, '').indexOf(';') >= 0) return { ok: false, reason: '不允许多条语句' };
  if (/--|\/\*/.test(s)) return { ok: false, reason: '不允许注释' };
  if (!/^(select|with)\b/i.test(s)) return { ok: false, reason: '只允许 SELECT 查询' };

  const bad = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|pragma|vacuum|replace\s+into)\b/i;
  const hit = s.match(bad);
  if (hit) return { ok: false, reason: '含禁止关键字：' + hit[1] };

  return { ok: true };
}

export function createDbProvider(cfg) {
  // cfg: { path, maxRows, tableWhitelist }
  const maxRows = cfg.maxRows || 200;
  const db = new DatabaseSync(cfg.path, { readOnly: true });

  /** 读表结构，交给模型当上下文 */
  function readSchema() {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();

    return tables.map((t) => {
      const cols = db.prepare('PRAGMA table_info(' + t.name + ')').all();
      const fields = cols.map((c) => c.name + ':' + c.type).join(', ');
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM "' + t.name + '"').get().c;
      return t.name + '(' + fields + ')  -- ' + cnt + ' 行';
    }).join('\n');
  }

  const schemaText = readSchema();

  return {
    name: 'db',
    schemaText,

    tools() {
      return [{
        type: 'function',
        function: {
          name: 'db_query',
          description:
            '执行只读 SQL 查询（仅 SELECT）。可用表结构：\n' + schemaText,
          parameters: {
            type: 'object',
            properties: {
              sql: { type: 'string', description: '一条 SELECT 语句，不要加分号' }
            },
            required: ['sql'],
            additionalProperties: false
          }
        }
      }];
    },

    isWrite() {
      return false; // 只读，永远不需要确认
    },

    execute(toolName, args) {
      if (toolName !== 'db_query') {
        return Promise.resolve({ ok: false, error: '未知识别：' + toolName });
      }

      const check = checkSqlReadonly(args.sql);
      if (!check.ok) {
        return Promise.resolve({ ok: false, error: 'SQL 被护栏拦下：' + check.reason });
      }

      // 外层包一层，强制行数上限（不改写用户的 SQL 语义）
      const wrapped = 'SELECT * FROM (' + String(args.sql).replace(/;\s*$/, '') + ') LIMIT ' + maxRows;

      const rows = db.prepare(wrapped).all();
      const text = JSON.stringify(rows, null, 1);
      return Promise.resolve({
        ok: true,
        rows: rows.length,
        data: text.length > 3500 ? text.slice(0, 3500) + '\n...[已截断]' : text
      });
    }
  };
}
