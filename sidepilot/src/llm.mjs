// LLM 网关：OpenAI 兼容协议，支持流式输出与工具调用
// 只依赖 Node 内置 fetch，换模型只改 baseUrl / model 两个字段

/**
 * 把 SSE 的增量 tool_calls 拼成完整调用
 * 协议里工具调用是分片下发的：name 可能分多次到，arguments 更是逐字符拼接
 */
function mergeToolDelta(acc, deltaList) {
  deltaList.forEach((tc, i) => {
    const idx = tc.index == null ? i : tc.index;
    if (!acc[idx]) acc[idx] = { id: '', name: '', arguments: '' };
    if (tc.id) acc[idx].id = tc.id;
    if (tc.function && tc.function.name) acc[idx].name += tc.function.name;
    if (tc.function && tc.function.arguments) acc[idx].arguments += tc.function.arguments;
  });
}

export function createLLM(cfg) {
  // 保留引用而不是拷贝：管理端改了模型配置后不用重启进程，下一次对话就生效
  const conf = cfg;

  const pick = function () {
    return {
      baseUrl: String(conf.baseUrl || '').replace(/\/+$/, ''),
      apiKey: conf.apiKey || '',
      // 不给默认模型名：默认值会让"忘填"变成"用一个莫名其妙的模型报错"，
      // 不如留空，下面直接告诉用户缺哪一项
      model: conf.model || '',
      temperature: conf.temperature == null ? 0.3 : conf.temperature
    };
  };

  return {
    get model() {
      return pick().model;
    },

    /**
     * 发起一次对话
     * @param {object} opt
     * @param {Array}  opt.messages   OpenAI 格式消息
     * @param {Array}  opt.tools      工具定义（可为空）
     * @param {Function} opt.onDelta  文本增量回调 (text) => void
     * @returns {Promise<{content,toolCalls,reasoning,error}>}
     */
    chat(opt) {
      const c = pick();

      // 三样缺任何一样都别发请求：直接说清楚缺什么，比让上游报 401/404 强
      const missing = [];
      if (!c.baseUrl) missing.push('llm.baseUrl（接口地址）');
      if (!c.apiKey) missing.push('llm.apiKey（密钥）');
      if (!c.model) missing.push('llm.model（模型名）');
      if (missing.length) {
        return Promise.resolve({
          content: '',
          toolCalls: [],
          reasoning: '',
          usage: null,
          error: '模型还没配置完整，缺少：' + missing.join('、') +
            '。请编辑 .sidepilot/config.json 的 llm 段，也可以直接在 /pilot/admin 的「模型与提示词」里填。'
        });
      }

      const body = {
        model: c.model,
        messages: opt.messages,
        temperature: c.temperature,
        stream: true
      };
      // 让上游在流末尾回一个 usage，用于成本统计。
      // 少数中转不支持这个参数会报 400，可在 config.llm.streamUsage 里关掉。
      if (conf.streamUsage !== false) {
        body.stream_options = { include_usage: true };
      }
      if (opt.tools && opt.tools.length) {
        body.tools = opt.tools;
        body.tool_choice = 'auto';
      }

      return fetch(c.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + c.apiKey
        },
        body: JSON.stringify(body)
      }).then(
        (res) => {
          // 非 200：把上游的原始报错带回去，方便定位是 key 还是模型名的问题
          if (!res.ok) {
            return res.text().then((t) => ({
              content: '',
              toolCalls: [],
              reasoning: '',
              usage: null,
              error: 'LLM 返回 ' + res.status + '：' + t.slice(0, 400)
            }));
          }
          return this.readStream(res, opt.onDelta);
        },
        (err) => ({ content: '', toolCalls: [], reasoning: '', usage: null, error: '连接失败：' + err.message })
      );
    },

    /** 逐块读取 SSE 流 */
    async readStream(res, onDelta) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let usage = null;
      const toolAcc = [];
      let finishReason = null;

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        // SSE 以空行分隔事件，这里按行处理足够（数据都是单行 data:）
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          // 这里必须解析外部输入，用一次受控的 try 包住，避免整条流因一行脏数据中断
          let json = null;
          try {
            json = JSON.parse(payload);
          } catch (e) {
            continue;
          }

          // usage 通常出现在最后一个 chunk 里，且那个 chunk 的 choices 是空数组
          // 所以要先取 usage 再看 choices，顺序不能反
          if (json.usage) usage = json.usage;

          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (delta.content) {
            content += delta.content;
            if (onDelta) onDelta(delta.content);
          }
          // DeepSeek 系列会带推理过程，先收集，前端可选择展示
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.tool_calls) mergeToolDelta(toolAcc, delta.tool_calls);
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }

      // 把分片拼好的调用整理成统一结构，顺手补上缺失的 id
      const toolCalls = toolAcc.filter(Boolean).map((t, i) => ({
        id: t.id || 'call_local_' + Date.now() + '_' + i,
        name: t.name,
        arguments: t.arguments || '{}'
      }));

      return { content, toolCalls, reasoning, finishReason, usage, error: null };
    }
  };
}
