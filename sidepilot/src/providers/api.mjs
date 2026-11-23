// api 能力域：把 manifest 里的接口变成 AI 可调用的工具
// 执行方式 = 本机回环 HTTP，天然复用项目自己的路由与业务逻辑

/** 把路径里的占位符替换成实际值，同时收集剩余参数 */
function buildUrl(base, path, params, args) {
  let url = base + path;
  const query = new URLSearchParams();

  (params || []).forEach((p) => {
    const val = args[p.name];
    if (val === undefined || val === null || val === '') return;

    if (p.in === 'path') {
      // 支持 {id} 与 :id 两种写法
      url = url.replace('{' + p.name + '}', encodeURIComponent(val))
               .replace(':' + p.name, encodeURIComponent(val));
    } else if (p.in === 'query') {
      query.set(p.name, Array.isArray(val) ? val.join(',') : String(val));
    }
  });

  if (query.toString()) url += (url.indexOf('?') >= 0 ? '&' : '?') + query.toString();
  return url;
}

/** 收集 body 与 header 参数 */
function splitBodyAndHeader(params, args) {
  const body = {};
  const headers = {};

  (params || []).forEach((p) => {
    const val = args[p.name];
    if (val === undefined || val === null || val === '') return;
    if (p.in === 'body') body[p.name] = val;
    if (p.in === 'header') headers[p.name] = String(val);
  });

  return { body, headers };
}

/** 结果太大时截断，避免撑爆上下文（方案 4.3 的成本护栏） */
function clampResult(text, limit = 3500) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '\n...[已截断，原长 ' + s.length + ' 字符，可缩小查询范围]';
}

export function createApiProvider(cfg) {
  // cfg: { baseUrl, endpoints }
  const baseUrl = cfg.baseUrl;
  const endpoints = cfg.endpoints || [];

  // 只把「允许 AI 使用」的接口暴露成工具
  const usable = endpoints.filter((e) => e.enabled !== false);

  return {
    name: 'api',

    /** 生成 OpenAI 工具定义 */
    tools() {
      return usable.map((ep) => {
        const props = {};
        const required = [];
        (ep.params || []).forEach((p) => {
          props[p.name] = {
            type: p.type === 'integer' ? 'integer' : p.type === 'number' ? 'number' : 'string',
            description: (p.desc || p.name) + (p.in === 'body' ? '（请求体字段）' : '')
          };
          if (p.required) required.push(p.name);
        });

        // 把自测得到的真实返回结构写进描述：模型知道字段名就不会瞎猜
        let desc = '【' + (ep.group || '通用') + '】' + ep.name + '：' + (ep.summary || '');
        if (ep.responseHint) desc += '。' + ep.responseHint;
        if (ep.method && ep.method !== 'GET') desc += '（' + ep.method + ' ' + ep.path + '）';

        return {
          type: 'function',
          function: {
            name: ep.tool,
            description: desc,
            parameters: {
              type: 'object',
              properties: props,
              required,
              additionalProperties: false
            }
          }
        };
      });
    },

    /** 该工具是不是写操作（写操作必须先让用户确认） */
    isWrite(toolName) {
      const ep = usable.find((e) => e.tool === toolName);
      return ep ? ep.risk !== 'read' : false;
    },

    /** 执行一次接口调用 */
    execute(toolName, args) {
      const ep = usable.find((e) => e.tool === toolName);
      if (!ep) {
        return Promise.resolve({ ok: false, error: '没有这个接口：' + toolName });
      }

      const url = buildUrl(baseUrl, ep.path, ep.params, args);
      const { body, headers } = splitBodyAndHeader(ep.params, args);
      const method = ep.method.toUpperCase();
      const hasBody = Object.keys(body).length > 0;

      return fetch(url, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'X-SidePilot': '1' },
          headers
        ),
        body: hasBody ? JSON.stringify(body) : undefined
      }).then(
        (res) =>
          res.text().then((text) => ({
            ok: res.ok,
            status: res.status,
            data: clampResult(text),
            url,
            method
          })),
        (err) => ({ ok: false, error: '请求失败：' + err.message, url, method })
      );
    }
  };
}
