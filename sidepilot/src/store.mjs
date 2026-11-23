// SidePilot 本地存储层
// 用 Node 内置的 node:sqlite，不引入任何第三方依赖
// 一个项目一个库文件，默认落盘在 <项目>/.sidepilot/pilot.db
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
-- 会话索引：给「历史对话」列表用，标题取第一条用户提问
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  user_id       TEXT,              -- 归属用户，由宿主通过 x-pilot-user 头透传
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- 对话消息：按 session_id 分组
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL,
  role          TEXT    NOT NULL,
  content       TEXT,
  tool_calls    TEXT,              -- JSON：assistant 请求的工具调用
  tool_call_id  TEXT,              -- role=tool 时对应哪一次调用
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

-- 每次工具调用的流水，用于审计与排错
CREATE TABLE IF NOT EXISTS tool_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  user_id     TEXT,
  name        TEXT,
  args        TEXT,
  result      TEXT,
  status      TEXT,                -- ok | error | rejected | pending
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_logs_created ON tool_logs(created_at DESC);

-- 文件编辑记录：支持一键回滚（纯静态站的关键）
CREATE TABLE IF NOT EXISTS edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  file        TEXT NOT NULL,
  before_text TEXT,                -- 编辑前的完整内容，回滚时直接写回
  after_text  TEXT,
  diff        TEXT,                -- 给人看的 diff
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edits_file ON edits(file, id);

-- 审计：谁在什么时候让 AI 做了什么
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  user_id     TEXT,                -- 操作人，缺失时记为匿名
  action      TEXT,                -- tool_call | file_edit | config_change | rollback
  target      TEXT,                -- 被操作对象：接口路径 / 文件路径 / 配置项
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at DESC);

-- 回答反馈：一条助手消息只能评一次，用来找出答得不好的地方
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL UNIQUE,
  session_id  TEXT,
  rating      TEXT NOT NULL,       -- up | down
  note        TEXT,                -- 用户补充说明（可选）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating, id DESC);

-- 模型用量：每次调用记一条，用于成本统计
CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT,
  model             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at DESC);
`;

/**
 * 把审计详情转成一行人话再入库。
 * 存成结构化 JSON 的话，界面上还得再解析一次，不如写入时就转好。
 */
function auditDetailText(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;

  // 配置变更：列出改了哪几项
  if (Array.isArray(detail.fields)) {
    return '改动字段：' + detail.fields.join('、');
  }

  // 工具调用：参数 + 结果
  if (detail.args !== undefined) {
    const state = detail.rejected ? '被用户拒绝' : (detail.ok === false ? '执行失败' : '已执行');
    return state + '，参数 ' + JSON.stringify(detail.args);
  }

  return JSON.stringify(detail);
}

/** 老库升级：列不存在就补上（SQLite 没有 IF NOT EXISTS 的 ADD COLUMN） */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].name === column) return;
  }
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
}

/**
 * 打开（或创建）本地库
 * @param {string} dbPath 绝对路径
 */
export function createStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  // 老库补列：这些字段是后加的，已有数据不受影响
  ensureColumn(db, 'sessions', 'user_id', 'TEXT');
  ensureColumn(db, 'tool_logs', 'user_id', 'TEXT');
  ensureColumn(db, 'audit', 'user_id', 'TEXT');

  // 升级兼容：sessions 是后加的表，老库里只有 messages。
  // 这里把已有会话回填进来，否则历史列表会是空的。
  db.exec(`
    INSERT INTO sessions (id, title, created_at, updated_at, message_count)
    SELECT m.session_id,
           COALESCE(
             (SELECT SUBSTR(content, 1, 24) FROM messages
              WHERE session_id = m.session_id AND role = 'user' AND content IS NOT NULL
              ORDER BY id LIMIT 1),
             '历史对话'
           ),
           MIN(m.created_at), MAX(m.created_at), COUNT(*)
    FROM messages m
    WHERE m.session_id NOT IN (SELECT id FROM sessions)
    GROUP BY m.session_id;
  `);

  const now = () => Date.now();

  /** 维护会话索引：不存在就建，存在就刷新活跃时间与计数 */
  function touchSession(sessionId, titleIfNew, userId) {
    db.prepare(`
      INSERT INTO sessions (id, title, user_id, created_at, updated_at, message_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        updated_at    = excluded.updated_at,
        message_count = sessions.message_count + 1,
        title         = CASE WHEN sessions.title IS NULL OR sessions.title = '' THEN excluded.title ELSE sessions.title END,
        user_id       = CASE WHEN sessions.user_id IS NULL OR sessions.user_id = '' THEN excluded.user_id ELSE sessions.user_id END
    `).run(sessionId, titleIfNew || '新对话', userId || null, now(), now());
  }

  return {
    db,

    /** 追加一条消息 */
    addMessage(sessionId, role, content, extra = {}) {
      const stmt = db.prepare(
        'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?,?,?,?,?,?)'
      );
      const info = stmt.run(
        sessionId,
        role,
        content == null ? null : String(content),
        extra.toolCalls ? JSON.stringify(extra.toolCalls) : null,
        extra.toolCallId || null,
        now()
      );

      // 只有用户提问才用来当会话标题（截前 24 个字）
      const title = role === 'user' && content ? String(content).replace(/\s+/g, ' ').slice(0, 24) : null;
      touchSession(sessionId, title, extra.userId);

      return Number(info.lastInsertRowid);
    },

    /** 会话列表，最近活跃的在前。传 userId 只看该用户的 */
    listSessions(limit = 30, userId) {
      if (userId) {
        return db.prepare(
          'SELECT id, title, user_id, created_at, updated_at, message_count FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'
        ).all(userId, limit);
      }
      return db.prepare(
        'SELECT id, title, user_id, created_at, updated_at, message_count FROM sessions ORDER BY updated_at DESC LIMIT ?'
      ).all(limit);
    },

    /** 某个会话是否存在 */
    hasSession(sessionId) {
      const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
      return !!row;
    },

    /** 删掉一个会话及其消息、工具流水 */
    deleteSession(sessionId) {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM tool_logs WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    },

    /** 给界面渲染用的历史消息：过滤掉工具消息与空的助手回复 */
    listDisplayMessages(sessionId) {
      const rows = db.prepare(
        "SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id ASC"
      ).all(sessionId);

      return rows.filter((r) => {
        if (r.role === 'user') return true;
        return r.content && String(r.content).trim().length > 0;
      }).map((r) => ({
        id: r.id,          // 反馈按钮要按消息 id 记录
        role: r.role,
        content: r.content,
        at: r.created_at
      }));
    },

    /** 取某个会话的全部消息（按时间正序） */
    listMessages(sessionId) {
      const rows = db.prepare(
        'SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC'
      ).all(sessionId);
      // 还原成 OpenAI 协议要求的消息结构，直接喂给模型
      return rows.map((r) => {
        const m = { role: r.role, content: r.content == null ? '' : r.content };
        if (r.tool_calls) m.tool_calls = JSON.parse(r.tool_calls);
        if (r.tool_call_id) m.tool_call_id = r.tool_call_id;
        return m;
      });
    },

    /** 记一次工具调用 */
    logTool(sessionId, name, args, result, status, durationMs, userId) {
      db.prepare(
        'INSERT INTO tool_logs (session_id, user_id, name, args, result, status, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(
        sessionId,
        userId || null,
        name,
        JSON.stringify(args || {}),
        typeof result === 'string' ? result : JSON.stringify(result),
        status,
        durationMs || 0,
        now()
      );
    },

    /** 工具调用流水（管理端审计用），可按用户过滤 */
    listToolLogs(limit = 100, userId) {
      if (userId) {
        return db.prepare(
          'SELECT id, session_id, user_id, name, args, status, duration_ms, created_at FROM tool_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?'
        ).all(userId, limit);
      }
      return db.prepare(
        'SELECT id, session_id, user_id, name, args, status, duration_ms, created_at FROM tool_logs ORDER BY id DESC LIMIT ?'
      ).all(limit);
    },

    /** 记一次文件编辑（含编辑前全文，便于回滚） */
    recordEdit(sessionId, file, beforeText, afterText, diff) {
      const info = db.prepare(
        'INSERT INTO edits (session_id, file, before_text, after_text, diff, created_at) VALUES (?,?,?,?,?,?)'
      ).run(sessionId, file, beforeText, afterText, diff, now());
      return Number(info.lastInsertRowid);
    },

    /** 列出最近的文件编辑 */
    listEdits(limit = 50) {
      return db.prepare(
        'SELECT id, session_id, file, diff, created_at FROM edits ORDER BY id DESC LIMIT ?'
      ).all(limit);
    },

    /** 取某次编辑的原始内容，用于回滚 */
    getEdit(id) {
      return db.prepare('SELECT * FROM edits WHERE id = ?').get(id);
    },

    /** 审计。userId 缺省记匿名，方便「谁干的」这个问题有答案 */
    audit(sessionId, action, target, detail, userId) {
      db.prepare('INSERT INTO audit (session_id, user_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?)')
        .run(
          sessionId || null,
          userId || null,
          action,
          target || null,
          auditDetailText(detail),
          now()
        );
    },

    /** 今天的调用量，用于简易限流 */
    countToday(sessionId) {
      const start = new Date().setHours(0, 0, 0, 0);
      return db.prepare('SELECT COUNT(*) AS c FROM tool_logs WHERE session_id = ? AND created_at >= ?')
        .get(sessionId, start).c;
    },

    // ---------- 回答反馈 ----------

    /** 给某条助手消息打分。同一消息重复提交会覆盖 */
    addFeedback(messageId, sessionId, rating, note) {
      db.prepare(`
        INSERT INTO feedback (message_id, session_id, rating, note, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          rating = excluded.rating,
          note   = excluded.note,
          created_at = excluded.created_at
      `).run(messageId, sessionId || null, rating, note || null, now());
    },

    /** 某个会话里已评过的消息，用于前端回显按钮状态 */
    getFeedbackMap(sessionId) {
      const rows = db.prepare('SELECT message_id, rating FROM feedback WHERE session_id = ?').all(sessionId);
      const map = {};
      rows.forEach((r) => { map[r.message_id] = r.rating; });
      return map;
    },

    /**
     * 反馈列表，带上当时的问答上下文，方便判断"为什么答错"
     * onlyDown=true 只看差评
     */
    listFeedback(limit = 60, onlyDown) {
      const sql = onlyDown
        ? `SELECT f.id, f.message_id, f.session_id, f.rating, f.note, f.created_at
           FROM feedback f WHERE f.rating = 'down' ORDER BY f.id DESC LIMIT ?`
        : `SELECT f.id, f.message_id, f.session_id, f.rating, f.note, f.created_at
           FROM feedback f ORDER BY f.id DESC LIMIT ?`;

      const rows = db.prepare(sql).all(limit);

      // 顺带把"用户问了什么"取出来——定位问题全靠它
      return rows.map((r) => {
        const q = db.prepare(
          "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1"
        ).get(r.session_id, r.message_id);
        const a = db.prepare('SELECT content FROM messages WHERE id = ?').get(r.message_id);
        return {
          id: r.id,
          messageId: r.message_id,
          sessionId: r.session_id,
          rating: r.rating,
          note: r.note,
          at: r.created_at,
          question: q ? q.content : '',
          answer: a ? a.content : ''
        };
      });
    },

    // ---------- 用量与成本 ----------

    /** 记一次模型调用的 token 用量 */
    addUsage(sessionId, model, promptTokens, completionTokens) {
      if (!promptTokens && !completionTokens) return;
      db.prepare(
        'INSERT INTO usage_log (session_id, model, prompt_tokens, completion_tokens, created_at) VALUES (?,?,?,?,?)'
      ).run(sessionId || null, model || '', promptTokens || 0, completionTokens || 0, now());
    },

    /** 最近 N 天的用量汇总，按天分组 */
    usageSummary(days = 30) {
      const since = Date.now() - days * 86400000;
      const total = db.prepare(
        'SELECT COUNT(*) AS calls, SUM(prompt_tokens) AS pin, SUM(completion_tokens) AS pout FROM usage_log WHERE created_at >= ?'
      ).get(since);

      const byDay = db.prepare(`
        SELECT strftime('%m/%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
               SUM(prompt_tokens) AS pin, SUM(completion_tokens) AS pout, COUNT(*) AS calls
        FROM usage_log WHERE created_at >= ?
        GROUP BY day ORDER BY day ASC
      `).all(since);

      return {
        days,
        calls: total.calls || 0,
        promptTokens: total.pin || 0,
        completionTokens: total.pout || 0,
        byDay
      };
    },

    /** 审计流水：带上会话标题，界面上不用再查一次 */
    listAudit(limit = 80) {
      return db.prepare(`
        SELECT a.id, a.session_id, a.user_id, a.action, a.target, a.detail, a.created_at,
               s.title AS session_title
        FROM audit a
        LEFT JOIN sessions s ON s.id = a.session_id
        ORDER BY a.id DESC LIMIT ?
      `).all(limit);
    }
  };
}
