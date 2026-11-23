// SidePilot 对话面板：原生 JS，无框架无构建
// 通信走 SSE，写操作走「确认卡片 → 二次请求」的两段式

(function () {
  var PREFIX = location.pathname.replace(/\/+$/, '') || '/pilot';
  if (PREFIX.indexOf('/pilot') < 0) PREFIX = '/pilot'; // 兜底
  PREFIX = PREFIX.replace(/\/(chat|index\.html)$/, '');

  var $ = function (id) { return document.getElementById(id); };
  var streamEl, inputEl, sendBtn, historyViewEl, historyListEl;
  var sessionId = localStorage.getItem('pilot_session') || newSessionId();
  localStorage.setItem('pilot_session', sessionId);

  var pendingImages = [];
  var busy = false;
  var toolDesc = {};   // 工具名 → 中文说明，用于渲染"正在调用…"的那一行
  var currentUser = null;   // 宿主透传的用户，用来隔离会话
  var ratings = {};         // messageId → 'up' | 'down'，回显已评状态

  /** 统一请求头：把用户带上，反代也可以自己注入 x-pilot-user */
  function reqHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (currentUser) h['x-pilot-user'] = currentUser;
    return h;
  }

  function newSessionId() {
    return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ---------- 工具函数 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 轻量富文本：粗体、行内代码、表格、列表、段落 */
  function renderRich(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 表格：当前行含 |，下一行是分隔行 |---|
      if (line.indexOf('|') >= 0 && lines[i + 1] && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) {
        var headCells = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var html = '<div class="tbl"><table><thead><tr>';
        headCells.forEach(function (c) { html += '<th>' + inline(c) + '</th>'; });
        html += '</tr></thead><tbody>';
        rows.forEach(function (r) {
          html += '<tr>';
          r.forEach(function (c) { html += '<td>' + inline(c) + '</td>'; });
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }

      // 列表
      if (/^\s*[-*]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (line.trim() === '') { i++; continue; }

      // 连续普通行合成一段
      var buf = [];
      while (i < lines.length && lines[i].trim() !== '' &&
             lines[i].indexOf('|') < 0 && !/^\s*[-*]\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }

      // 兜底：若因为含 | 而一行都没吃进来，必须强行前进，否则会死循环
      if (buf.length === 0) {
        out.push('<p>' + inline(line) + '</p>');
        i++;
        continue;
      }

      out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    }

    return out.join('');
  }

  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (s) { return s.trim(); });
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="font-family:var(--mono);font-size:.92em;background:#F5F3ED;padding:1px 4px;border-radius:3px">$1</code>');
  }

  function scrollDown() {
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  // ---------- 初始化 ----------
  function boot() {
    streamEl = $('stream');
    inputEl = $('input');
    sendBtn = $('sendBtn');
    historyViewEl = $('historyView');
    historyListEl = $('historyList');

    fetch(PREFIX + '/api/bootstrap')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var p = data.profile || {};

        // 用户在 URL 上指定（?user=zhangsan），或者由反代注入后回显
        var fromUrl = new URLSearchParams(location.search).get('user');
        if (fromUrl) {
          currentUser = fromUrl;
          localStorage.setItem('pilot_user', fromUrl);
        } else if (data.user) {
          currentUser = data.user;
        } else {
          currentUser = localStorage.getItem('pilot_user') || null;
        }

        $('projectName').textContent = p.name || '未命名项目';
        $('docsLink').href = data.docsUrl || (PREFIX + '/docs');

        var kindText = p.kind === 'static_site' ? '纯静态站点 · 可编辑页面' : '业务系统 · 可调用接口';
        $('kindLabel').textContent = kindText;

        var hints = [];
        if (p.capabilities && p.capabilities.indexOf('file') >= 0) hints.push('直接改页面内容');
        if (p.capabilities && p.capabilities.indexOf('api') >= 0) hints.push('调用系统接口');
        if (p.capabilities && p.capabilities.indexOf('db') >= 0) hints.push('查数据库');
        $('capabilityHint').textContent = hints.length
          ? '我能' + hints.join('、') + '。说说你想做什么，改动之前都会先给你看。'
          : '这个项目还没配置可用的能力。';

        // 记下工具的中文名，后面渲染调用记录时用
        (data.tools || []).forEach(function (t) {
          toolDesc[t.name] = (t.desc || '').split('：')[0].replace(/^【[^】]*】/, '');
        });

        renderSuggestions(p, data.tools || [], data.suggestions || []);

        // 上次的对话要能接着看，不然等于每次都从零开始
        loadCurrentHistory();
      }, function () {
        $('kindLabel').textContent = '连接失败';
      });

    // 事件绑定
    sendBtn.addEventListener('click', submit);

    // 👍👎 用事件委托，省得每条消息都绑一次
    streamEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.rate-btn') : null;
      if (!btn) return;
      var mid = btn.getAttribute('data-mid');
      var rating = btn.getAttribute('data-rate');
      if (mid && rating) sendFeedback(mid, rating, btn.parentNode);
    });

    $('historyBtn').addEventListener('click', openHistory);
    $('historyBack').addEventListener('click', function () {
      historyViewEl.classList.remove('on');
    });
    $('newBtn').addEventListener('click', newSession);

    $('closeBtn').addEventListener('click', function () {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'pilot:close' }, '*');
      } else {
        history.back();
      }
    });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    inputEl.addEventListener('input', function () {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    $('imageBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', onPickImage);
  }

  function renderSuggestions(profile, tools, autoSuggest) {
    var box = $('suggestions');
    // 人工配的 topTasks 最贴业务，优先；没配才用按接口自动生成的
    var list = (profile.topTasks || []).slice(0, 4);
    if (!list.length) list = (autoSuggest || []).slice(0, 4);

    // 还是没有就按能力域给兜底建议
    if (!list.length) {
      if (profile.kind === 'static_site') {
        list = ['帮我看看有哪些页面可以改', '把首页的标题改一下', '这个页面有什么可以优化的'];
      } else {
        list = ['这个系统里有哪些数据可以查？'];
      }
    }

    box.innerHTML = '';
    list.forEach(function (text) {
      var b = document.createElement('button');
      b.className = 'sugg';
      b.innerHTML = '<span>' + esc(text) + '</span><span class="arrow">→</span>';
      b.addEventListener('click', function () {
        inputEl.value = text;
        submit();
      });
      box.appendChild(b);
    });
  }

  // ---------- 历史对话 ----------
  function fmtWhen(ts) {
    var d = new Date(ts);
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /** 清空消息区，回到欢迎页（欢迎块保留，只切换显示） */
  function clearStream() {
    Array.prototype.slice.call(streamEl.children).forEach(function (el) {
      if (el.id !== 'welcome') el.remove();
    });
    var w = $('welcome');
    if (w) w.classList.remove('hidden');
  }

  /** 把某段历史渲染出来 */
  function renderHistoryMessages(messages) {
    if (!messages || !messages.length) return false;

    var w = $('welcome');
    if (w) w.classList.add('hidden');

    var lastDay = '';

    messages.forEach(function (m) {
      // 隔天的地方插一条时间线，回看时更容易定位
      var day = new Date(m.at).toDateString();
      if (day !== lastDay) {
        var sep = document.createElement('div');
        sep.className = 'msg-sep';
        sep.textContent = fmtWhen(m.at);
        streamEl.appendChild(sep);
        lastDay = day;
      }

      if (m.role === 'user') {
        addUser(m.content);
      } else {
        var hbody = addAiText(m.content);
        // 历史消息也带反馈按钮，翻回去还能补评
        if (m.id) attachMeta(hbody, m.id, []);
      }
    });

    scrollDown();
    return true;
  }

  function addAiText(text) {
    var body = addAiShell();
    body.dataset.raw = text;
    body.innerHTML = renderRich(text);
    return body;
  }

  /** 拉当前会话的历史与已评状态，一起渲染 */
  function loadCurrentHistory() {
    var enc = encodeURIComponent(sessionId);
    return Promise.all([
      fetch(PREFIX + '/api/history?sessionId=' + enc).then(function (r) { return r.json(); }),
      fetch(PREFIX + '/api/feedback?sessionId=' + enc).then(function (r) { return r.json(); })
    ]).then(function (arr) {
      var d = arr[0] || {};
      ratings = (arr[1] && arr[1].ratings) || {};
      clearStream();
      return renderHistoryMessages(d.messages);
    }, function () { return false; });
  }

  function openHistory() {
    historyViewEl.classList.add('on');
    historyListEl.innerHTML = '<p class="history-empty">加载中…</p>';

    fetch(PREFIX + '/api/sessions')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        renderSessionList(d.sessions || []);
      }, function () {
        historyListEl.innerHTML = '<p class="history-empty">加载失败，请确认服务还在运行</p>';
      });
  }

  function renderSessionList(sessions) {
    if (!sessions.length) {
      historyListEl.innerHTML = '<p class="history-empty">还没有对话记录。问点什么，这里就会留下痕迹。</p>';
      return;
    }

    historyListEl.innerHTML = sessions.map(function (s) {
      var cur = s.id === sessionId ? ' current' : '';
      return '<div class="hist-item' + cur + '" data-id="' + esc(s.id) + '">' +
        '<div class="hist-main">' +
          '<div class="hist-title">' + esc(s.title || '新对话') + '</div>' +
          '<div class="hist-meta">' + fmtWhen(s.updated_at) + ' · ' + s.message_count + ' 条</div>' +
        '</div>' +
        '<button class="hist-del" data-del="' + esc(s.id) + '" title="删除">×</button>' +
      '</div>';
    }).join('');

    historyListEl.onclick = function (ev) {
      var delId = ev.target.getAttribute && ev.target.getAttribute('data-del');
      if (delId) {
        ev.stopPropagation();
        deleteSession(delId);
        return;
      }
      var item = ev.target.closest ? ev.target.closest('.hist-item') : null;
      if (!item) return;
      var id = item.getAttribute('data-id');
      if (id) switchSession(id);
    };
  }

  function switchSession(id) {
    if (id === sessionId) {
      historyViewEl.classList.remove('on');
      return;
    }
    sessionId = id;
    localStorage.setItem('pilot_session', id);
    historyViewEl.classList.remove('on');
    loadCurrentHistory();
    inputEl.focus();
  }

  function newSession() {
    sessionId = newSessionId();
    localStorage.setItem('pilot_session', sessionId);
    ratings = {};          // 新会话没有已评记录
    clearStream();
    historyViewEl.classList.remove('on');
    inputEl.value = '';
    inputEl.style.height = 'auto';
    inputEl.focus();
  }

  function deleteSession(id) {
    if (!confirm('删除这段对话记录？删除后无法恢复。')) return;

    fetch(PREFIX + '/api/session/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id })
    }).then(function (r) { return r.json(); })
      .then(function () {
        // 删的是当前会话，就顺手开一个新的
        if (id === sessionId) newSession();
        openHistory();
      }, function () {
        alert('删除失败');
      });
  }

  // ---------- 消息渲染 ----------
  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'msg msg-user';
    d.innerHTML = '<div class="who">你</div><div class="bubble">' + esc(text) + '</div>';
    streamEl.appendChild(d);
    scrollDown();
  }

  function addAiShell() {
    var d = document.createElement('div');
    d.className = 'msg msg-ai';
    d.innerHTML = '<div class="who">助手</div><div class="body"></div>';
    streamEl.appendChild(d);
    scrollDown();
    return d.querySelector('.body');
  }

  function addToolLine(name, label) {
    var d = document.createElement('div');
    d.className = 'tool-line running';
    d.innerHTML = '<span class="tool-dot"></span>' +
      '<span class="tool-label">' + esc(label || name) + '</span>' +
      '<span class="tool-sum"></span>' +
      '<span class="tool-ms"></span>';
    streamEl.appendChild(d);
    scrollDown();
    return d;
  }

  function addError(msg) {
    var d = document.createElement('div');
    d.className = 'msg-error';
    d.textContent = msg;
    streamEl.appendChild(d);
    scrollDown();
  }

  /** 答案下方：👍👎 与「依据」。依据就是这次调了哪些工具、各自返回了多少 */
  function attachMeta(bodyEl, messageId, used) {
    var host = bodyEl && bodyEl.parentNode;
    if (!host || !messageId) return;

    var names = [];
    (used || []).forEach(function (u) {
      if (!u) return;
      var n = toolDesc[u.name] || u.name;
      if (u.summary) n += '（' + u.summary + '）';
      if (names.indexOf(n) < 0) names.push(n);
    });

    var meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML =
      '<button class="rate-btn' + (ratings[messageId] === 'up' ? ' on-up' : '') +
        '" data-rate="up" data-mid="' + messageId + '">有用</button>' +
      '<button class="rate-btn' + (ratings[messageId] === 'down' ? ' on-down' : '') +
        '" data-rate="down" data-mid="' + messageId + '">没用</button>' +
      (names.length ? '<span class="used">依据：' + esc(names.join('、')) + '</span>' : '');

    host.appendChild(meta);
  }

  function sendFeedback(messageId, rating, metaEl) {
    fetch(PREFIX + '/api/feedback', {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ messageId: Number(messageId), sessionId: sessionId, rating: rating })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      ratings[messageId] = rating;
      if (!metaEl) return;
      var btns = metaEl.querySelectorAll('.rate-btn');
      Array.prototype.forEach.call(btns, function (b) {
        b.classList.remove('on-up', 'on-down');
        if (b.getAttribute('data-rate') === rating) {
          b.classList.add(rating === 'up' ? 'on-up' : 'on-down');
        }
      });
    }, function () {});
  }

  // ---------- 发送 ----------
  function submit() {
    var text = inputEl.value.trim();
    if ((!text && !pendingImages.length) || busy) return;

    busy = true;
    sendBtn.disabled = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';

    var welcome = $('welcome');
    if (welcome) welcome.classList.add('hidden');

    addUser(text || '（图片）');

    var images = pendingImages.slice();
    pendingImages = [];
    renderAttachments();

    streamPost(PREFIX + '/api/chat', { sessionId: sessionId, text: text, images: images });
  }

  /** 统一的 SSE 消费逻辑 */
  function streamPost(url, payload) {
    var bodyEl = null;
    var buffer = '';
    var thinkingEl = null;

    function ensureBody() {
      if (!bodyEl) bodyEl = addAiShell();
      return bodyEl;
    }

    function clearThinking() {
      if (thinkingEl && thinkingEl.parentNode) thinkingEl.remove();
      thinkingEl = null;
    }

    fetch(url, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify(payload)
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return finish();
          buffer += decoder.decode(chunk.value, { stream: true });

          var parts = buffer.split('\n\n');
          buffer = parts.pop();

          parts.forEach(function (block) {
            var line = block.trim();
            if (!line || line.indexOf('data:') !== 0) return;
            var obj;
            try { obj = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
            handleEvent(obj);
          });

          return pump();
        });
      }

      return pump();
    }).then(null, function (err) {
      clearThinking();
      addError('网络中断：' + err.message);
      endBusy();
    });

    function handleEvent(e) {
      if (e.type === 'thinking') {
        if (!thinkingEl) {
          thinkingEl = document.createElement('div');
          thinkingEl.className = 'thinking';
          thinkingEl.innerHTML = '<i></i><i></i><i></i>';
          streamEl.appendChild(thinkingEl);
          scrollDown();
        }
        return;
      }

      if (e.type === 'delta') {
        clearThinking();
        var b = ensureBody();
        b.dataset.raw = (b.dataset.raw || '') + e.text;
        b.innerHTML = renderRich(b.dataset.raw);
        scrollDown();
        return;
      }

      if (e.type === 'tool') {
        clearThinking();
        addToolLine(e.name, labelForTool(e.name, e.args));
        return;
      }

      if (e.type === 'tool_result') {
        var lines = streamEl.querySelectorAll('.tool-line.running');
        var last = lines[lines.length - 1];
        if (last) {
          last.classList.remove('running');
          last.classList.add(e.ok ? 'ok' : 'fail');
          // 结果摘要和耗时，让人知道"到底查到了什么、花了多久"
          var sumEl = last.querySelector('.tool-sum');
          if (sumEl && e.summary) sumEl.textContent = '· ' + e.summary;
          var msEl = last.querySelector('.tool-ms');
          if (msEl && e.ms != null) msEl.textContent = e.ms + 'ms';
        }
        return;
      }

      if (e.type === 'confirm') {
        clearThinking();
        renderConfirm(e);
        return;
      }

      if (e.type === 'applied') {
        var d = document.createElement('div');
        d.className = 'applied';
        d.textContent = '✓ 已写入 ' + (e.file || '') + '，可在文档页的历史记录里回滚';
        streamEl.appendChild(d);
        return;
      }

      if (e.type === 'error') {
        clearThinking();
        addError(e.message || '出错了');
        return;
      }

      if (e.type === 'done') {
        clearThinking();
        var doneBody = null;
        if (e.text) {
          doneBody = ensureBody();
          doneBody.dataset.raw = e.text;
          doneBody.innerHTML = renderRich(e.text);
        }
        // 这条回答的 messageId 和用过的工具，用来挂反馈按钮与「依据」
        if (e.messageId && doneBody) attachMeta(doneBody, e.messageId, e.used);
        scrollDown();
        return;
      }
    }

    function finish() {
      clearThinking();
      endBusy();
    }
  }

  function labelForTool(name, args) {
    var map = {
      db_query: '查询数据库',
      file_list: '查看可编辑的文件',
      file_read: '读取 ' + (args && args.path || '文件'),
      file_edit: '修改 ' + (args && args.path || '文件')
    };
    if (map[name]) return map[name];
    if (toolDesc[name]) return toolDesc[name];
    return '调用 ' + name;
  }

  // ---------- 确认卡片 ----------
  function renderConfirm(e) {
    var box = document.createElement('div');
    box.className = 'confirm';

    var html = '<div class="confirm-head">' +
      '<span class="confirm-tag">待确认</span>' +
      '<span class="confirm-title">' + esc(e.title || '执行操作') + '</span></div>';

    if (e.diff) {
      html += '<p class="confirm-note">下面是即将发生的改动，确认后才会落盘。</p>';
      html += '<div class="diff">' + renderDiff(e.diff) + '</div>';
    } else {
      html += '<p class="confirm-note">这是写操作，确认后才会真正发出。</p>';
      html += '<pre class="kv">' + esc(JSON.stringify(e.args || {}, null, 2)) + '</pre>';
    }

    html += '<div class="confirm-actions">' +
      '<button class="btn btn-primary" data-act="approve">确认执行</button>' +
      '<button class="btn" data-act="reject">取消</button></div>';

    box.innerHTML = html;
    streamEl.appendChild(box);
    scrollDown();

    box.addEventListener('click', function (ev) {
      var act = ev.target.getAttribute('data-act');
      if (!act) return;
      box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      box.style.opacity = '0.6';
      busy = true;
      sendBtn.disabled = true;
      streamPost(PREFIX + '/api/confirm', { sessionId: sessionId, decision: act });
    });
  }

  function renderDiff(diff) {
    return String(diff).split('\n').map(function (line) {
      if (/^\+ /.test(line)) return '<span class="d-add">' + esc(line) + '</span>';
      if (/^- /.test(line)) return '<span class="d-del">' + esc(line) + '</span>';
      if (/^@@/.test(line)) return '<span class="d-hd">' + esc(line) + '</span>';
      return esc(line);
    }).join('');
  }

  // ---------- 图片 ----------
  function onPickImage(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      addError('图片太大，请压到 4MB 以内');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      pendingImages.push(reader.result);
      renderAttachments();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function renderAttachments() {
    var box = $('attachments');
    box.innerHTML = '';
    pendingImages.forEach(function (src, idx) {
      var d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = '<img src="' + src + '"><button title="移除">×</button>';
      d.querySelector('button').addEventListener('click', function () {
        pendingImages.splice(idx, 1);
        renderAttachments();
      });
      box.appendChild(d);
    });
  }

  function endBusy() {
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  boot();
})();
