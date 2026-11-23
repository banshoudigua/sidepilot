// SidePilot 管理端：概览 / 对话记录 / 接口清单 / 模型与提示词 / 设置
(function () {
  var PREFIX = location.pathname.replace(/\/admin\/?$/, '') || '/pilot';
  var main = document.getElementById('main');
  var state = { overview: null, chats: null, eps: null, config: null };

  // ---------- 基础工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast on' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function api(path, opt) {
    return fetch(PREFIX + '/api/admin' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opt || {})).then(function (r) { return r.json(); });
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : n; };
    return (d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtNum(n) {
    return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ---------- 概览 ----------
  function viewOverview() {
    main.innerHTML = '<p class="loading">加载中…</p>';

    Promise.all([api('/overview'), api('/usage')]).then(function (arr) {
      var d = arr[0];
      var use = arr[1] || {};
      var us = use.summary || { calls: 0, promptTokens: 0, completionTokens: 0 };

      state.overview = d;
      var s = d.stats;

      document.getElementById('projectName').textContent = d.project.name;
      document.getElementById('cntChats').textContent = s.sessions;
      document.getElementById('cntEps').textContent = s.endpoints;

      var max = Math.max.apply(null, d.recent.map(function (r) { return r.count; }).concat([1]));

      var bars = d.recent.map(function (r) {
        var h = Math.max(2, Math.round(r.count / max * 88));
        return '<div class="bar-wrap">' +
          '<span class="bar-val">' + (r.count || '') + '</span>' +
          '<div class="bar" style="height:' + h + 'px"></div>' +
          '<span class="bar-day">' + esc(r.day) + '</span>' +
        '</div>';
      }).join('');

      main.innerHTML =
        '<div class="page-head"><h1>概览</h1><p>' + esc(d.project.name) +
          ' · ' + (d.project.kind === 'static_site' ? '纯静态站点' : '业务系统') + '</p></div>' +

        '<div class="cards">' +
          '<div class="card"><span>对话会话</span><b>' + s.sessions + '</b></div>' +
          '<div class="card"><span>消息总数</span><b>' + s.messages + '</b></div>' +
          '<div class="card"><span>接口数量</span><b>' + s.endpoints + '</b></div>' +
          '<div class="card"><span>今日消息</span><b>' + s.todayMessages + '</b></div>' +
        '</div>' +

        '<div class="cards">' +
          '<div class="card"><span>近 30 天模型调用</span><b>' + fmtNum(us.calls) + '</b></div>' +
          '<div class="card"><span>输入 token</span><b>' + fmtNum(us.promptTokens) + '</b></div>' +
          '<div class="card"><span>输出 token</span><b>' + fmtNum(us.completionTokens) + '</b></div>' +
          '<div class="card"><span>估算费用</span><b>' +
            (use.estimatedCost == null ? '<span class="muted-cell" style="font-size:14px">未配单价</span>'
              : '¥' + use.estimatedCost.toFixed(2)) +
          '</b></div>' +
        '</div>' +

        ((s.feedbackDown || s.unverified) ?
          '<div class="note warn" style="margin-bottom:16px">' +
            (s.feedbackDown ? '有 <b>' + s.feedbackDown + '</b> 条回答被用户点了👎，去「回答反馈」看看哪里答错了。 ' : '') +
            (s.unverified ? '有 <b>' + s.unverified + '</b> 个接口还没做自测，参数可能是猜的，去「接口清单」点「自测接口」。' : '') +
          '</div>' : '') +

        '<div class="chart">' +
          '<p class="chart-title">近 7 天对话量</p>' +
          '<div class="bars">' + bars + '</div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section-head"><h2>运行状态</h2></div>' +
          '<div class="section-body">' +
            '<table><tbody>' +
              '<tr><td style="width:180px;color:var(--muted)">已启用的接口</td><td>' + s.enabledEndpoints + ' / ' + s.endpoints + '</td></tr>' +
              '<tr><td style="color:var(--muted)">已通过自测</td><td>' + (s.probed || 0) + ' 个（其余参数未经校验）</td></tr>' +
              '<tr><td style="color:var(--muted)">工具调用次数</td><td>' + s.toolCalls + ' 次</td></tr>' +
              '<tr><td style="color:var(--muted)">文件改动次数</td><td>' + s.edits + ' 次（可在接口文档页回滚）</td></tr>' +
              '<tr><td style="color:var(--muted)">可编辑页面</td><td>' + s.pages + ' 个</td></tr>' +
            '</tbody></table>' +
          '</div>' +
        '</div>';
    }, function () {
      main.innerHTML = '<p class="empty">加载失败，请确认服务还在运行</p>';
    });
  }

  // ---------- 对话记录 ----------
  function viewChats() {
    main.innerHTML =
      '<div class="page-head"><h1>对话记录</h1><p>每次对话都留在这里，可以回看、删除</p></div>' +
      '<div class="section"><div class="section-body" id="chatBox"><p class="loading">加载中…</p></div></div>';

    fetch(PREFIX + '/api/sessions')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = d.sessions || [];
        var box = document.getElementById('chatBox');

        if (!list.length) {
          box.innerHTML = '<p class="empty">还没有对话记录</p>';
          return;
        }

        box.innerHTML = '<table><thead><tr><th>标题</th><th style="width:80px">消息数</th><th style="width:130px">最后活跃</th><th style="width:140px"></th></tr></thead><tbody>' +
          list.map(function (s) {
            return '<tr>' +
              '<td>' + esc(s.title || '新对话') + '</td>' +
              '<td class="mono">' + s.message_count + '</td>' +
              '<td class="mono" style="color:var(--muted)">' + fmtTime(s.updated_at) + '</td>' +
              '<td style="text-align:right">' +
                '<button class="btn btn-sm" data-view-chat="' + esc(s.id) + '">查看</button> ' +
                '<button class="btn-ghost" data-del-chat="' + esc(s.id) + '">删除</button>' +
              '</td>' +
            '</tr>';
          }).join('') + '</tbody></table>';
      }, function () {
        document.getElementById('chatBox').innerHTML = '<p class="empty">加载失败</p>';
      });
  }

  function openChatDetail(sessionId) {
    fetch(PREFIX + '/api/history?sessionId=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var rows = (d.messages || []).map(function (m) {
          return '<div class="msg-row">' +
            '<div class="msg-who">' + (m.role === 'user' ? '用户' : '助手') + '</div>' +
            '<div class="msg-text">' + esc(m.content) + '</div>' +
          '</div>';
        }).join('');

        var mask = document.createElement('div');
        mask.className = 'modal-mask';
        mask.innerHTML = '<div class="modal">' +
          '<div class="detail-head"><h3 style="margin:0">对话详情</h3>' +
            '<span class="mono" style="color:var(--muted);font-size:11px">' + (d.messages || []).length + ' 条</span>' +
          '</div>' +
          '<div style="max-height:60vh;overflow:auto">' + (rows || '<p class="empty">没有内容</p>') + '</div>' +
          '<div class="form-foot" style="justify-content:flex-end;margin-top:16px">' +
            '<button class="btn" data-close-modal>关闭</button>' +
          '</div>' +
        '</div>';

        document.body.appendChild(mask);
        mask.addEventListener('click', function (ev) {
          if (ev.target === mask || ev.target.hasAttribute('data-close-modal')) mask.remove();
        });
      });
  }

  function deleteChat(sessionId) {
    if (!confirm('删除这段对话？消息记录会一起清掉，无法恢复。')) return;

    fetch(PREFIX + '/api/session/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId })
    }).then(function (r) { return r.json(); })
      .then(function () {
        toast('已删除');
        viewChats();
      }, function () { toast('删除失败', true); });
  }

  // ---------- 回答反馈 ----------
  // 差评是最有价值的信号：它直接指出"哪句话不能信"
  function viewFeedback() {
    main.innerHTML =
      '<div class="page-head"><h1>回答反馈</h1><p>用户点👎的地方，就是提示词该改的地方</p></div>' +
      '<div class="section">' +
        '<div class="section-head">' +
          '<h2>反馈记录</h2>' +
          '<div class="actions">' +
            '<label class="inline-check"><input type="checkbox" id="fbAll"> 显示全部（含好评）</label>' +
          '</div>' +
        '</div>' +
        '<div class="section-body" id="fbBox" style="padding:0"><p class="loading" style="padding:18px">加载中…</p></div>' +
      '</div>';

    loadFeedback(false);

    document.getElementById('fbAll').addEventListener('change', function () {
      loadFeedback(this.checked);
    });
  }

  function loadFeedback(showAll) {
    var box = document.getElementById('fbBox');
    box.innerHTML = '<p class="loading" style="padding:18px">加载中…</p>';

    api('/feedback' + (showAll ? '?all=1' : '')).then(function (d) {
      var list = d.feedback || [];
      state.feedback = list;

      if (!list.length) {
        box.innerHTML = '<p class="empty" style="padding:26px">' +
          (showAll ? '还没有任何反馈。' : '还没有差评，说明回答质量还行。') +
          '</p>';
        return;
      }

      box.innerHTML = '<table><thead><tr>' +
        '<th style="width:64px">评价</th><th>用户问的</th><th style="width:170px">助手答的</th>' +
        '<th style="width:120px">备注</th><th style="width:96px">时间</th>' +
        '</tr></thead><tbody>' +
        list.map(function (f) {
          var badge = f.rating === 'down'
            ? '<span class="tag del">👎 差</span>'
            : '<span class="tag read">👍 好</span>';
          var answer = String(f.answer || '');
          var shortAnswer = answer.length > 60 ? answer.slice(0, 59) + '…' : answer;
          return '<tr>' +
            '<td>' + badge + '</td>' +
            '<td>' + esc(f.question || '（找不到对应提问）') + '</td>' +
            '<td class="muted-cell" title="' + esc(answer) + '">' + esc(shortAnswer || '—') + '</td>' +
            '<td class="muted-cell">' + esc(f.note || '—') + '</td>' +
            '<td class="mono">' + fmtTime(f.at) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }, function () {
      box.innerHTML = '<p class="empty" style="padding:26px">加载失败</p>';
    });
  }

  // ---------- 操作审计 ----------
  // 合规问的三个问题：谁、什么时候、动了什么。这张表就是答案
  function viewAudit() {
    main.innerHTML =
      '<div class="page-head"><h1>操作审计</h1><p>每一次改数据、改文件、改配置都留痕</p></div>' +
      '<div class="note">审计只记录动作和对象，不记录密钥内容。清空日志需要直接操作数据库。</div>' +
      '<div class="section">' +
        '<div class="section-head"><h2>最近 120 条</h2></div>' +
        '<div class="section-body" id="auditBox" style="padding:0"><p class="loading" style="padding:18px">加载中…</p></div>' +
      '</div>';

    api('/audit').then(function (d) {
      var list = d.audit || [];
      var box = document.getElementById('auditBox');

      if (!list.length) {
        box.innerHTML = '<p class="empty" style="padding:26px">还没有审计记录。等助手执行一次写操作就会出现。</p>';
        return;
      }

      var actionText = {
        tool_call: '调用工具',
        file_edit: '修改文件',
        config_change: '修改配置',
        rollback: '回滚'
      };

      box.innerHTML = '<table><thead><tr>' +
        '<th style="width:96px">时间</th><th style="width:100px">操作人</th>' +
        '<th style="width:96px">动作</th><th>对象</th><th style="width:34%">详情</th>' +
        '</tr></thead><tbody>' +
        list.map(function (a) {
          // 后端已把详情转成一行文本，这里只做截断，不再解析
          var detail = String(a.detail || '');
          if (detail.length > 90) detail = detail.slice(0, 89) + '…';

          return '<tr>' +
            '<td class="mono">' + fmtTime(a.at) + '</td>' +
            '<td>' + esc(a.userId || '匿名') + '</td>' +
            '<td><span class="tag">' + esc(actionText[a.action] || a.action || '—') + '</span></td>' +
            '<td class="mono">' + esc(a.target || '—') + '</td>' +
            '<td class="muted-cell" title="' + esc(a.detail || '') + '">' + esc(detail || '—') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }, function () {
      document.getElementById('auditBox').innerHTML = '<p class="empty" style="padding:26px">加载失败</p>';
    });
  }

  // ---------- 接口清单 ----------
  function viewEndpoints() {
    main.innerHTML =
      '<div class="page-head"><h1>接口清单</h1><p>AI 能调用哪些接口、以什么身份调用，都在这里控制</p></div>' +
      '<div class="note">关掉的接口不会出现在 AI 的工具列表里。写操作即使开着，执行前也会让人确认。</div>' +
      '<div class="section">' +
        '<div class="section-head">' +
          '<h2>共 <span id="epCount">0</span> 个</h2>' +
          '<div class="actions">' +
            '<input id="epSearch" type="text" placeholder="搜索路径或名称" style="border:1px solid var(--line-strong);background:var(--paper);padding:5px 10px;border-radius:4px;font-size:12.5px;outline:none;width:180px">' +
            '<button class="btn btn-sm" id="btnProbe">自测接口</button>' +
            '<button class="btn btn-sm" id="btnScan">重新扫描</button>' +
            '<button class="btn btn-sm btn-primary" id="btnAddEp">新增接口</button>' +
          '</div>' +
        '</div>' +
        '<div class="section-body" id="epBox" style="padding:0"><p class="loading" style="padding:18px">加载中…</p></div>' +
      '</div>';

    loadEndpoints();

    document.getElementById('btnScan').addEventListener('click', function () {
      var self = this;
      self.disabled = true;
      self.textContent = '扫描中…';
      api('/scan', { method: 'POST' }).then(function (d) {
        self.disabled = false;
        self.textContent = '重新扫描';
        toast('扫描完成，新增 ' + d.added + ' 个接口，共 ' + d.total + ' 个');
        loadEndpoints();
      }, function () {
        self.disabled = false;
        self.textContent = '重新扫描';
        toast('扫描失败', true);
      });
    });

    document.getElementById('btnAddEp').addEventListener('click', function () {
      openEpEditor(null);
    });

    // 自测：真调一次只读接口，把返回结构写回清单。这比"猜参数"可靠得多
    document.getElementById('btnProbe').addEventListener('click', function () {
      var self = this;
      self.disabled = true;
      self.textContent = '自测中…';
      api('/probe', { method: 'POST' }).then(function (d) {
        self.disabled = false;
        self.textContent = '自测接口';
        if (!d.ok) return toast(d.error || '自测失败', true);
        var st = d.stats || {};
        toast('自测完成：通过 ' + (st.passed || 0) + ' / ' + (st.tested || 0) + ' 个');
        loadEndpoints();
      }, function () {
        self.disabled = false;
        self.textContent = '自测接口';
        toast('自测请求失败', true);
      });
    });

    document.getElementById('epSearch').addEventListener('input', function () {
      renderEpTable(this.value.trim());
    });
  }

  function loadEndpoints() {
    api('/endpoints').then(function (d) {
      state.eps = d.endpoints || [];
      renderEpTable('');
      document.getElementById('epCount').textContent = state.eps.length;
    });
  }

  function renderEpTable(keyword) {
    var box = document.getElementById('epBox');
    var list = state.eps || [];

    if (keyword) {
      var k = keyword.toLowerCase();
      list = list.filter(function (e) {
        return (e.path + ' ' + e.name + ' ' + e.group).toLowerCase().indexOf(k) >= 0;
      });
    }

    if (!list.length) {
      box.innerHTML = '<p class="empty">没有接口。点右上角「重新扫描」或「新增接口」。</p>';
      return;
    }

    box.innerHTML = '<table><thead><tr>' +
      '<th style="width:66px">方法</th><th>路径</th><th>名称</th><th style="width:84px">分组</th>' +
      '<th style="width:72px">风险</th><th style="width:74px">已验证</th><th style="width:70px">启用</th><th style="width:132px"></th>' +
      '</tr></thead><tbody>' +
      list.map(function (e) {
        var idx = state.eps.indexOf(e);
        var riskCls = e.risk === 'read' ? 'read' : e.risk === 'destructive' ? 'del' : 'write';
        var riskTxt = e.risk === 'read' ? '只读' : e.risk === 'destructive' ? '删除' : '写';
        // 只读接口才不会真的改数据，所以只给它们做自测
        var canProbe = e.method === 'GET';
        var probeCell;
        if (e.probe && e.probe.ok) {
          probeCell = '<span class="tag read" title="' + esc(e.probe.at ? '最近自测：' + fmtTime(e.probe.at) : '已通过自测') + '">通过</span>';
        } else if (e.probe && !e.probe.ok) {
          probeCell = '<span class="tag del" title="' + esc(e.probe.error || '自测失败') + '">失败</span>';
        } else {
          probeCell = canProbe ? '<span class="tag">未测</span>' : '<span class="hint-dash">—</span>';
        }
        return '<tr>' +
          '<td><span class="method m-' + esc(e.method) + '">' + esc(e.method) + '</span></td>' +
          '<td class="mono">' + esc(e.path) + '</td>' +
          '<td>' + esc(e.name || '—') + '</td>' +
          '<td><span class="tag">' + esc(e.group || '未分组') + '</span></td>' +
          '<td><span class="tag ' + riskCls + '">' + riskTxt + '</span></td>' +
          '<td>' + probeCell + '</td>' +
          '<td>' +
            '<label class="switch"><input type="checkbox" data-ep-toggle="' + idx + '"' + (e.enabled ? ' checked' : '') + '><i></i></label>' +
          '</td>' +
          '<td style="text-align:right">' +
            '<button class="btn btn-sm" data-ep-edit="' + idx + '">编辑</button> ' +
            '<button class="btn-ghost" data-ep-del="' + idx + '">删</button>' +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  function openEpEditor(ep) {
    var isNew = !ep;
    var e = ep || { method: 'GET', path: '/api/', name: '', summary: '', group: '', risk: 'read', enabled: true };

    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal">' +
      '<h3>' + (isNew ? '新增接口' : '编辑接口') + '</h3>' +
      '<div class="grid-2">' +
        '<div class="field"><label>方法</label>' +
          '<select id="mMethod">' + ['GET','POST','PUT','PATCH','DELETE'].map(function (m) {
            return '<option' + (m === e.method ? ' selected' : '') + '>' + m + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>风险</label>' +
          '<select id="mRisk">' +
            '<option value="read"' + (e.risk === 'read' ? ' selected' : '') + '>只读（直接执行）</option>' +
            '<option value="write"' + (e.risk === 'write' ? ' selected' : '') + '>写（需确认）</option>' +
            '<option value="destructive"' + (e.risk === 'destructive' ? ' selected' : '') + '>危险（需二次确认）</option>' +
          '</select></div>' +
      '</div>' +
      '<div class="field"><label>路径</label>' +
        '<input id="mPath" type="text" value="' + esc(e.path) + '" placeholder="/api/products"></div>' +
      '<div class="grid-2">' +
        '<div class="field"><label>名称</label><input id="mName" type="text" value="' + esc(e.name || '') + '" placeholder="商品列表"></div>' +
        '<div class="field"><label>分组</label><input id="mGroup" type="text" value="' + esc(e.group || '') + '" placeholder="商品"></div>' +
      '</div>' +
      '<div class="field"><label>说明</label><input id="mSummary" type="text" value="' + esc(e.summary || '') + '" placeholder="按关键词查询在售商品"></div>' +
      '<div class="form-foot" style="justify-content:flex-end">' +
        '<button class="btn" data-close-modal>取消</button>' +
        '<button class="btn btn-primary" id="mSave">保存</button>' +
      '</div>' +
    '</div>';

    document.body.appendChild(mask);

    mask.addEventListener('click', function (ev) {
      if (ev.target === mask || ev.target.hasAttribute('data-close-modal')) mask.remove();
    });

    mask.querySelector('#mSave').addEventListener('click', function () {
      var payload = {
        method: mask.querySelector('#mMethod').value,
        path: mask.querySelector('#mPath').value.trim(),
        name: mask.querySelector('#mName').value.trim(),
        group: mask.querySelector('#mGroup').value.trim(),
        summary: mask.querySelector('#mSummary').value.trim(),
        risk: mask.querySelector('#mRisk').value,
        enabled: true
      };
      if (!payload.path || payload.path[0] !== '/') {
        toast('路径要以 / 开头', true);
        return;
      }
      api('/endpoints', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
        if (!r.ok) { toast(r.error || '保存失败', true); return; }
        toast(isNew ? '已新增' : '已保存');
        mask.remove();
        loadEndpoints();
      }, function () { toast('保存失败', true); });
    });
  }

  function toggleEndpoint(idx, enabled) {
    var e = state.eps[idx];
    if (!e) return;
    api('/endpoints', {
      method: 'POST',
      body: JSON.stringify({ method: e.method, path: e.path, enabled: enabled })
    }).then(function (r) {
      if (!r.ok) { toast(r.error || '操作失败', true); return; }
      e.enabled = enabled;
      toast(enabled ? '已启用' : '已停用');
    });
  }

  function deleteEndpoint(idx) {
    var e = state.eps[idx];
    if (!e) return;
    if (!confirm('删除接口 ' + e.method + ' ' + e.path + '？')) return;

    api('/endpoints/delete', {
      method: 'POST',
      body: JSON.stringify({ method: e.method, path: e.path })
    }).then(function (r) {
      if (!r.ok) { toast(r.error || '删除失败', true); return; }
      toast('已删除');
      loadEndpoints();
    });
  }

  // ---------- 模型与提示词 ----------
  function viewModel() {
    main.innerHTML = '<p class="loading">加载中…</p>';

    api('/config').then(function (d) {
      if (!d || !d.config) {
        main.innerHTML = '<p class="empty">配置读取失败：' + esc((d && d.error) || '返回格式不对') + '</p>';
        return;
      }
      var c = d.config;
      var llm = c.llm || {};
      var p = c.profile || {};
      var pr = c.prompt || {};

      main.innerHTML =
        '<div class="page-head"><h1>模型与提示词</h1><p>改完保存即生效，不用重启服务（能力域变更除外）</p></div>' +

        '<div class="section">' +
          '<div class="section-head"><h2>大模型</h2></div>' +
          '<div class="section-body">' +
            '<div class="field"><label>接口地址（OpenAI 兼容）</label>' +
              '<input id="cBaseUrl" type="text" value="' + esc(llm.baseUrl || '') + '" placeholder="https://api.deepseek.com/v1">' +
              '<p class="hint">任何 OpenAI 兼容服务都行：DeepSeek、通义、智谱、本地 vLLM</p></div>' +
            '<div class="grid-2">' +
              '<div class="field"><label>模型名</label>' +
                '<input id="cModel" type="text" value="' + esc(llm.model || '') + '" placeholder="deepseek-v4.1-flash"></div>' +
              '<div class="field"><label>温度</label>' +
                '<input id="cTemp" type="number" step="0.1" min="0" max="2" value="' + (llm.temperature == null ? 0.3 : llm.temperature) + '">' +
                '<p class="hint">越低越稳定，查数据建议 0.2~0.4</p></div>' +
            '</div>' +
            '<div class="field"><label>API Key</label>' +
              '<input id="cApiKey" type="text" value="' + esc(llm.apiKeyMasked || '') + '" placeholder="sk-...">' +
              '<p class="hint">不修改就保留原值；要换就直接粘贴新的</p></div>' +
          '</div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section-head"><h2>项目画像</h2></div>' +
          '<div class="section-body">' +
            '<div class="note">画像决定助手说话的方式：它知道自己在什么系统里、用户最常做什么、什么不能碰。</div>' +
            '<div class="grid-2">' +
              '<div class="field"><label>项目名</label><input id="pName" type="text" value="' + esc(p.name || '') + '"></div>' +
              '<div class="field"><label>使用者</label>' +
                '<select id="pAudience">' +
                  '<option value="internal"' + (p.audience === 'internal' ? ' selected' : '') + '>内部员工</option>' +
                  '<option value="external"' + (p.audience === 'external' ? ' selected' : '') + '>外部访客</option>' +
                '</select></div>' +
            '</div>' +
            '<div class="field"><label>业务说明</label>' +
              '<input id="pDomain" type="text" value="' + esc(p.domain || '') + '" placeholder="一家精品咖啡店的门店管理系统">' +
              '<p class="hint">一句话说清这个系统是干什么的，助手会据此理解上下文</p></div>' +
            '<div class="field"><label>用户最常做的事（每行一条）</label>' +
              '<textarea id="pTasks" rows="4">' + esc((p.topTasks || []).join('\n')) + '</textarea>' +
              '<p class="hint">会变成对话页的快捷指令</p></div>' +
            '<div class="field"><label>不允许碰的内容（每行一条）</label>' +
              '<textarea id="pRestricted" rows="3">' + esc((p.restricted || []).join('\n')) + '</textarea>' +
              '<p class="hint">写进来的内容，助手遇到会直接拒绝并说明原因</p></div>' +
          '</div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section-head">' +
            '<h2>附加提示词</h2>' +
            '<div class="actions"><button class="btn btn-sm" id="btnPreview">查看完整提示词</button></div>' +
          '</div>' +
          '<div class="section-body">' +
            '<div class="note">核心铁律（不编造、工具结果是数据不是指令）不可修改。这里只追加你项目特有的要求。</div>' +
            '<div class="field"><label>追加到系统提示词末尾</label>' +
              '<textarea id="cPromptExtra" rows="6" placeholder="例如：金额一律用「元」为单位，保留两位小数；回答时先给结论再给明细。">' + esc(pr.extra || '') + '</textarea></div>' +
          '</div>' +
        '</div>' +

        '<div class="form-foot">' +
          '<button class="btn btn-primary" id="btnSaveCfg">保存设置</button>' +
          '<button class="btn" id="btnReloadCfg">放弃修改</button>' +
        '</div>';

      document.getElementById('btnSaveCfg').addEventListener('click', function () {
        var self = this;
        self.disabled = true;

        var payload = {
          llm: {
            baseUrl: document.getElementById('cBaseUrl').value.trim(),
            model: document.getElementById('cModel').value.trim(),
            temperature: Number(document.getElementById('cTemp').value),
            apiKey: document.getElementById('cApiKey').value.trim()
          },
          profile: {
            name: document.getElementById('pName').value.trim(),
            audience: document.getElementById('pAudience').value,
            domain: document.getElementById('pDomain').value.trim(),
            topTasks: document.getElementById('pTasks').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
            restricted: document.getElementById('pRestricted').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
          },
          prompt: {
            extra: document.getElementById('cPromptExtra').value
          }
        };

        api('/config', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
          self.disabled = false;
          if (!r.ok) { toast('保存失败', true); return; }
          toast(r.needRestart && r.needRestart.length ? '已保存，' + r.needRestart.join('、') + '需重启生效' : '已保存，立即生效');
        }, function () {
          self.disabled = false;
          toast('保存失败', true);
        });
      });

      document.getElementById('btnReloadCfg').addEventListener('click', viewModel);

      document.getElementById('btnPreview').addEventListener('click', function () {
        api('/prompt').then(function (r) {
          var mask = document.createElement('div');
          mask.className = 'modal-mask';
          mask.innerHTML = '<div class="modal">' +
            '<h3>实际发送给模型的开场提示词</h3>' +
            '<pre class="prompt">' + esc(r.system) + '</pre>' +
            '<div class="form-foot" style="justify-content:flex-end">' +
              '<button class="btn" data-close-modal>关闭</button>' +
            '</div></div>';
          document.body.appendChild(mask);
          mask.addEventListener('click', function (ev) {
            if (ev.target === mask || ev.target.hasAttribute('data-close-modal')) mask.remove();
          });
        });
      });
    }, function () {
      main.innerHTML = '<p class="empty">配置读取失败，请确认服务还在运行</p>';
    });
  }

  // ---------- 设置 ----------
  function viewSettings() {
    main.innerHTML =
      '<div class="page-head"><h1>设置</h1><p>护栏阈值与数据位置</p></div>' +

      '<div class="section">' +
        '<div class="section-head"><h2>安全护栏</h2></div>' +
        '<div class="section-body">' +
          '<div class="note ok">当前默认策略：数据库只读、写操作必须人工确认、文件编辑必须落在白名单目录内。</div>' +
          '<table><tbody>' +
            '<tr><td style="width:200px;color:var(--muted)">单轮最多工具调用</td><td class="mono">6 次</td></tr>' +
            '<tr><td style="color:var(--muted)">工具返回截断</td><td class="mono">3500 字符</td></tr>' +
            '<tr><td style="color:var(--muted)">数据库查询上限</td><td class="mono">200 行</td></tr>' +
            '<tr><td style="color:var(--muted)">文件编辑前备份</td><td>开启（.sidepilot/backups）</td></tr>' +
            '<tr><td style="color:var(--muted)">HTML 语法校验</td><td>开启（标签平衡检查）</td></tr>' +
          '</tbody></table>' +
          '<p class="hint" style="margin-top:12px;color:var(--muted);font-size:12px">这些阈值目前写在代码里，需要改请在 config.json 的 guard 字段中配置后重启。</p>' +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section-head"><h2>数据位置</h2></div>' +
        '<div class="section-body">' +
          '<table><tbody>' +
            '<tr><td style="width:200px;color:var(--muted)">项目配置</td><td class="mono">.sidepilot/config.json</td></tr>' +
            '<tr><td style="color:var(--muted)">接口清单</td><td class="mono">.sidepilot/manifest.json</td></tr>' +
            '<tr><td style="color:var(--muted)">对话与审计</td><td class="mono">.sidepilot/pilot.db</td></tr>' +
            '<tr><td style="color:var(--muted)">文件备份</td><td class="mono">.sidepilot/backups/</td></tr>' +
          '</tbody></table>' +
          '<div class="note warn" style="margin-top:14px">config.json 里存着模型 API Key，这个目录不要提交到公开仓库。</div>' +
        '</div>' +
      '</div>';
  }

  // ---------- 路由 ----------
  var VIEWS = {
    overview: viewOverview,
    chats: viewChats,
    feedback: viewFeedback,
    endpoints: viewEndpoints,
    audit: viewAudit,
    model: viewModel,
    settings: viewSettings
  };

  // 侧栏的项目名与计数，任何视图下都要有值
  function initMeta() {
    api('/overview').then(function (d) {
      document.getElementById('projectName').textContent = d.project.name;
      document.getElementById('cntChats').textContent = d.stats.sessions;
      document.getElementById('cntEps').textContent = d.stats.endpoints;

      // 差评数量：侧栏一直挂着，提醒"这里有活要干"
      var fb = document.getElementById('cntFb');
      if (fb) {
        fb.textContent = d.stats.feedbackDown || '';
        fb.className = d.stats.feedbackDown ? 'warn' : '';
      }
    }, function () {
      document.getElementById('projectName').textContent = '连接失败';
    });
  }

  function route() {
    var name = (location.hash || '#overview').slice(1);
    if (!VIEWS[name]) name = 'overview';

    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      a.classList.toggle('on', a.getAttribute('data-view') === name);
    });

    initMeta();
    VIEWS[name]();
  }

  // 全局事件委托：表格里的按钮都用 data 属性标记
  main.addEventListener('click', function (ev) {
    var t = ev.target;
    var viewChat = t.getAttribute && t.getAttribute('data-view-chat');
    if (viewChat) return openChatDetail(viewChat);

    var delChat = t.getAttribute && t.getAttribute('data-del-chat');
    if (delChat) return deleteChat(delChat);

    var epEdit = t.getAttribute && t.getAttribute('data-ep-edit');
    if (epEdit) return openEpEditor(state.eps[Number(epEdit)]);

    var epDel = t.getAttribute && t.getAttribute('data-ep-del');
    if (epDel) return deleteEndpoint(Number(epDel));
  });

  main.addEventListener('change', function (ev) {
    var idx = ev.target.getAttribute && ev.target.getAttribute('data-ep-toggle');
    if (idx != null) toggleEndpoint(Number(idx), ev.target.checked);
  });

  window.addEventListener('hashchange', route);
  route();
})();
