// 文档站渲染：拉 /api/docs 与 /api/edits，纯 DOM 操作
(function () {
  var PREFIX = location.pathname.replace(/\/docs\/?$/, '') || '/pilot';
  var data = null;
  var edits = [];
  var keyword = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- 侧栏 ----------
  function renderSide() {
    var side = document.getElementById('side');
    var html = '<p class="nav-title">分组</p>';

    (data.groups || []).forEach(function (g, i) {
      html += '<a class="nav-item" href="#g' + i + '"><span>' + esc(g.name) + '</span><em>' + g.endpoints.length + '</em></a>';
    });

    if (data.files && data.files.length) {
      html += '<div class="nav-gap"></div><p class="nav-title">可编辑页面</p>';
      data.files.forEach(function (f) {
        html += '<a class="nav-item" href="#files"><span>' + esc(f.path.split('/').pop()) + '</span><em>' + Math.round(f.size / 1024) + 'k</em></a>';
      });
    }

    if (edits.length) {
      html += '<div class="nav-gap"></div><p class="nav-title">修改历史</p>';
      html += '<a class="nav-item" href="#history"><span>最近改动</span><em>' + edits.length + '</em></a>';
    }

    side.innerHTML = html;
  }

  // ---------- 主区 ----------
  function renderMain() {
    var main = document.getElementById('main');
    main.innerHTML = '';

    var shown = 0;

    (data.groups || []).forEach(function (g, gi) {
      var eps = g.endpoints.filter(match);
      if (!eps.length) return;
      shown += eps.length;

      var sec = document.createElement('section');
      sec.className = 'group';
      sec.id = 'g' + gi;

      var head = '<div class="group-head"><h2>' + esc(g.name) + '</h2><em>' + eps.length + ' 个接口</em></div>';
      var body = '';

      eps.forEach(function (e) {
        body += renderEndpoint(e);
      });

      sec.innerHTML = head + body;
      main.appendChild(sec);
    });

    // 文件清单（纯静态站）
    if (data.files && data.files.length) {
      var filesSec = document.createElement('section');
      filesSec.className = 'group';
      filesSec.id = 'files';
      var fh = '<div class="group-head"><h2>可编辑页面</h2><em>' + data.files.length + ' 个文件</em></div>';
      var fr = '';
      data.files.forEach(function (f) {
        fr += '<div class="file-row"><code>' + esc(f.path) + '</code><span class="size">' + (f.size / 1024).toFixed(1) + ' KB</span></div>';
      });
      filesSec.innerHTML = fh + fr;
      main.appendChild(filesSec);
    }

    // 修改历史
    if (edits.length) {
      var hisSec = document.createElement('section');
      hisSec.className = 'group';
      hisSec.id = 'history';
      var hh = '<div class="group-head"><h2>修改历史</h2><em>可回滚</em></div>';
      var hr = '';
      edits.forEach(function (ed) {
        hr += '<div class="edit-row"><code>' + esc(ed.file) + '</code>' +
              '<span class="when">' + fmtTime(ed.created_at) + '</span>' +
              '<button class="btn-mini" data-rollback="' + ed.id + '">回滚</button></div>';
      });
      hisSec.innerHTML = hh + hr;
      main.appendChild(hisSec);

      hisSec.addEventListener('click', onRollback);
    }

    if (!shown && !(data.files && data.files.length)) {
      main.innerHTML = '<p class="empty">' +
        (keyword ? '没有匹配「' + esc(keyword) + '」的内容' : '这个项目还没有采集到接口或页面。先运行 npx sidepilot init 扫描一遍。') +
        '</p>';
    }
  }

  function match(e) {
    if (!keyword) return true;
    var k = keyword.toLowerCase();
    return (e.path + ' ' + e.name + ' ' + (e.summary || '') + ' ' + (e.group || '')).toLowerCase().indexOf(k) >= 0;
  }

  function renderEndpoint(e) {
    var html = '<article class="ep">';
    html += '<div class="ep-head">';
    html += '<span class="method m-' + esc(e.method) + '">' + esc(e.method) + '</span>';
    html += '<span class="path">' + esc(e.path) + '</span>';
    html += '<span class="badge ' + (e.risk === 'read' ? 'read' : 'write') + '">' + (e.risk === 'read' ? '只读' : '写操作') + '</span>';
    if (e.confidence === 'low') html += '<span class="badge low">待确认</span>';
    html += '<span class="ep-name">' + esc(e.name || '') + '</span>';
    html += '</div>';

    if (e.summary) html += '<p class="ep-summary">' + esc(e.summary) + '</p>';

    if (e.params && e.params.length) {
      html += '<table class="params"><thead><tr><th>参数</th><th>位置</th><th>类型</th><th>必填</th><th>说明</th></tr></thead><tbody>';
      e.params.forEach(function (p) {
        html += '<tr>' +
          '<td>' + esc(p.name) + '</td>' +
          '<td>' + esc(p.in) + '</td>' +
          '<td>' + esc(p.type || 'string') + '</td>' +
          '<td>' + (p.required ? '<span class="req">是</span>' : '—') + '</td>' +
          '<td>' + esc(p.desc || '') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="ep-summary" style="color:var(--muted);font-size:12px">无参数</p>';
    }

    var meta = [];
    if (e.auth && e.auth.type && e.auth.type !== 'none') meta.push('鉴权：' + e.auth.type);
    if (e.responseHint) meta.push('返回：' + e.responseHint);
    if (e.evidence && e.evidence.length) meta.push('来源：' + e.evidence[0].file + ':' + e.evidence[0].line);

    if (meta.length) {
      html += '<p class="meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</p>';
    }

    html += '</article>';
    return html;
  }

  // ---------- 回滚 ----------
  function onRollback(ev) {
    var id = ev.target.getAttribute('data-rollback');
    if (!id) return;
    if (!confirm('确定回滚这次修改吗？文件会还原到改动前的内容。')) return;

    ev.target.disabled = true;
    ev.target.textContent = '回滚中…';

    fetch(PREFIX + '/api/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(id) })
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          ev.target.textContent = '已回滚';
          setTimeout(load, 700);
        } else {
          ev.target.textContent = '失败';
          alert(res.reason || res.error || '回滚失败');
        }
      }, function (err) {
        ev.target.textContent = '失败';
        alert('回滚请求失败：' + err.message);
      });
  }

  // ---------- 加载 ----------
  function load() {
    fetch(PREFIX + '/api/docs')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        data = d;
        document.getElementById('docTitle').textContent = (d.project && d.project.name ? d.project.name : '接口文档');
        document.getElementById('docSub').textContent = '自动生成 · ' + (d.stats.total || 0) + ' 个接口';
        document.getElementById('chatLink').href = PREFIX + '/chat';

        var s = d.stats;
        document.getElementById('stats').innerHTML =
          '<div class="stat"><b>' + s.total + '</b><span>接口总数</span></div>' +
          '<div class="stat"><b>' + s.read + '</b><span>只读</span></div>' +
          '<div class="stat"><b>' + s.write + '</b><span>写操作</span></div>' +
          '<div class="stat"><b>' + (d.files ? d.files.length : 0) + '</b><span>可编辑页面</span></div>';

        return fetch(PREFIX + '/api/edits').then(function (r) { return r.json(); });
      })
      .then(function (e) {
        edits = (e && e.edits) || [];
        renderSide();
        renderMain();
      }, function () {
        document.getElementById('main').innerHTML = '<p class="empty">加载失败，请确认服务还在运行。</p>';
      });
  }

  document.getElementById('search').addEventListener('input', function (ev) {
    keyword = ev.target.value.trim();
    if (data) renderMain();
  });

  load();
})();
