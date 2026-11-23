// SidePilot 嵌入 SDK
// 一行引入即在宿主页面右下角生成助手入口，点击后从右侧滑出抽屉
// 样式全部内联 + 唯一 id，不依赖外部 CSS，也不会污染宿主站点
(function () {
  if (window.__sidePilotLoaded) return;
  window.__sidePilotLoaded = true;

  var script = document.currentScript;
  var prefix = ((script && script.getAttribute('data-prefix')) || '/pilot').replace(/\/+$/, '');
  var label = (script && script.getAttribute('data-label')) || 'AI 助手';
  var side = (script && script.getAttribute('data-position')) === 'left' ? 'left' : 'right';
  var accent = (script && script.getAttribute('data-accent')) || '#17161A';

  // 侧边：left 时贴左，right 时贴右
  var edge = side + ':24px';
  var panelEdge = side + ':0';

  // ---------- 悬浮按钮 ----------
  var fab = document.createElement('button');
  fab.id = 'sidepilot-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', label);
  fab.style.cssText = [
    'position:fixed',
    edge,
    'bottom:24px',
    'z-index:2147483000',
    'display:flex',
    'align-items:center',
    'gap:8px',
    'height:46px',
    'padding:0 18px 0 15px',
    'margin:0',
    'border:0',
    'border-radius:24px',
    'background:' + accent,
    'color:#FBFAF7',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    'font-size:13.5px',
    'line-height:46px',
    'cursor:pointer',
    'box-shadow:0 4px 18px rgba(23,22,26,.22),0 1px 3px rgba(23,22,26,.14)',
    'transition:transform .2s ease,opacity .2s ease'
  ].join(';');

  var dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:2px;background:#C2410C;transform:rotate(45deg);flex:0 0 auto';
  fab.appendChild(dot);
  fab.appendChild(document.createTextNode(label));

  // ---------- 抽屉 ----------
  var panel = document.createElement('div');
  panel.id = 'sidepilot-panel';
  panel.style.cssText = [
    'position:fixed',
    'top:0',
    'bottom:0',
    panelEdge,
    'width:420px',
    'max-width:100vw',
    'z-index:2147483001',
    'background:#FBFAF7',
    'box-shadow:' + (side === 'left' ? '2px' : '-2px') + ' 0 32px rgba(23,22,26,.16)',
    'transform:translateX(' + (side === 'left' ? '-100%' : '100%') + ')',
    'transition:transform .3s cubic-bezier(.32,.72,0,1)',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden'
  ].join(';');

  var frame = document.createElement('iframe');
  frame.title = 'AI 助手';
  frame.style.cssText = 'flex:1;width:100%;height:100%;border:0;display:block;background:#FBFAF7';
  panel.appendChild(frame);

  var opened = false;

  function open() {
    if (!frame.getAttribute('src')) frame.setAttribute('src', prefix + '/chat');
    panel.style.transform = 'translateX(0)';
    fab.style.opacity = '0';
    fab.style.pointerEvents = 'none';
    opened = true;
  }

  function close() {
    panel.style.transform = 'translateX(' + (side === 'left' ? '-100%' : '100%') + ')';
    fab.style.opacity = '1';
    fab.style.pointerEvents = 'auto';
    opened = false;
  }

  fab.addEventListener('click', open);

  // iframe 内的「收起」通过 postMessage 通知宿主
  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'pilot:close') close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && opened) close();
  });

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(fab);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // 供宿主页面主动调用
  window.SidePilot = {
    open: open,
    close: close,
    toggle: function () { opened ? close() : open(); }
  };
})();
