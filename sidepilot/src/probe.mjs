// 接口自测：把 manifest 里「猜的参数」变成「验证过的真实结构」
//
// 只测无副作用的 GET 只读接口。测完把返回结构写回 responseHint，
// 模型就不再对着空白的返回说明瞎猜字段名。
//
// 安全边界：
//   - 只测 method=GET 且 risk=read 的
//   - 路径里带参数（:id / {id}）的跳过，没法构造合法值
//   - 有超时，失败只记录不抛错
//   - 串行执行，不并发打爆业务系统

/** 把 JSON 值压成一行结构描述，深度最多 2 层，够模型用了 */
function describeValue(v, depth) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';

  if (Array.isArray(v)) {
    if (!v.length) return 'array(空)';
    // 数组本身不算一层：否则 items:[{...}] 只会得到 array<object>，字段名全丢了
    return 'array<' + describeValue(v[0], depth) + '>';
  }

  const t = typeof v;
  if (t === 'object') {
    // 再往下一层就只剩 object 两个字，信息量不够还占地方
    if (depth >= 2) return 'object';
    const keys = Object.keys(v).slice(0, 6);
    const parts = keys.map((k) => k + ':' + describeValue(v[k], depth + 1));
    const more = Object.keys(v).length > 6 ? ',…' : '';
    return '{' + parts.join(', ') + more + '}';
  }

  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

/** 截断，别让 responseHint 变成一坨 */
function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** 这个接口该不该测 */
function shouldProbe(ep) {
  if (!ep) return false;
  if (ep.method !== 'GET') return false;
  if (ep.risk && ep.risk !== 'read') return false;
  if (ep.enabled === false) return false;
  // 带路径参数的没法测，跳过
  if (/\{[^}]+\}|:[a-zA-Z]/.test(ep.path)) return false;
  return true;
}

/** 测单个接口 */
function probeOne(ep, baseUrl, headers, timeoutMs) {
  const url = String(baseUrl).replace(/\/+$/, '') + ep.path;
  const started = Date.now();

  return fetch(url, {
    method: 'GET',
    headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    signal: AbortSignal.timeout(timeoutMs)
  }).then(
    (res) => {
      const ms = Date.now() - started;

      if (!res.ok) {
        return { ok: false, status: res.status, ms, error: 'HTTP ' + res.status };
      }

      const ctype = res.headers.get('content-type') || '';

      // 不是 JSON 就只看类型，别把 HTML 塞进清单
      if (ctype.indexOf('json') < 0) {
        return { ok: true, status: res.status, ms, shape: '非 JSON（' + ctype + '）' };
      }

      return res.json().then(
        (data) => ({
          ok: true,
          status: res.status,
          ms,
          shape: clip(describeValue(data, 0), 240)
        }),
        () => ({ ok: false, status: res.status, ms, error: '返回不是合法 JSON' })
      );
    },
    (err) => {
      const ms = Date.now() - started;
      // 超时和连不上要分开说，排查时差别很大
      const msg = err && err.name === 'TimeoutError' ? '超时（' + timeoutMs + 'ms）' : String(err && err.message || err);
      return { ok: false, status: 0, ms, error: msg };
    }
  );
}

/**
 * 批量探测
 * @param {object} ctx
 * @param {string} ctx.baseUrl    业务系统地址，如 http://127.0.0.1:8080
 * @param {Array}  ctx.endpoints  manifest 里的接口数组（原地写入 probe 字段）
 * @param {object} ctx.headers    可选请求头（鉴权）
 * @param {number} ctx.timeoutMs  单次超时，默认 4000
 * @param {number} ctx.maxProbe   最多测多少个，默认 40
 * @param {Function} ctx.onEach   每个测完回调 (endpoint, result)
 * @returns {Promise<{tested, passed, failed, skipped}>}
 */
export async function probeEndpoints(ctx) {
  const baseUrl = ctx.baseUrl;
  const endpoints = ctx.endpoints || [];
  const headers = ctx.headers || {};
  const timeoutMs = ctx.timeoutMs || 4000;
  const maxProbe = ctx.maxProbe || 40;
  const onEach = ctx.onEach;

  const stats = { tested: 0, passed: 0, failed: 0, skipped: 0 };
  const now = Date.now();

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];

    if (!shouldProbe(ep)) {
      stats.skipped++;
      continue;
    }

    if (stats.tested >= maxProbe) {
      stats.skipped++;
      continue;
    }

    const result = await probeOne(ep, baseUrl, headers, timeoutMs);
    stats.tested++;

    ep.probe = Object.assign({ at: now }, result);

    if (result.ok && result.shape) {
      stats.passed++;
      // 真实结构覆盖掉之前猜的说明
      ep.responseHint = '实测返回：' + result.shape;
      // 测通了说明这个接口活着，置信度可以抬一档
      if (ep.confidence === 'low') ep.confidence = 'medium';
    } else {
      stats.failed++;
      ep.probe.error = result.error || '未知错误';
    }

    if (typeof onEach === 'function') onEach(ep, result);
  }

  return stats;
}
