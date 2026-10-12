(function () {
  'use strict';
  // 網頁內的確認視窗：取代 window.confirm()。
  // LINE、Facebook 等 App 內建瀏覽器常會直接擋掉 confirm()（不顯示、直接回傳 false），
  // 造成「按了取消卻什麼都沒發生」。這個視窗是頁面自己畫的，任何瀏覽器都會顯示。
  // 用法：crmConfirm('訊息', { confirmText: '確定取消', cancelText: '先不要', danger: true }).then(function (ok) { ... })
  var STYLE_ID = 'crm-confirm-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.crm-confirm-overlay{position:fixed;inset:0;z-index:100000;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.crm-confirm-box{background:#fff;border-radius:14px;max-width:420px;width:100%;padding:20px;box-shadow:0 20px 40px rgba(0,0,0,.25);font-family:inherit}' +
      '.crm-confirm-msg{font-size:15px;line-height:1.6;color:#111827;margin:0 0 18px;white-space:pre-line;overflow-wrap:anywhere}' +
      '.crm-confirm-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}' +
      '.crm-confirm-actions button{font:inherit;font-size:14px;padding:10px 18px;border-radius:10px;cursor:pointer;min-height:44px}' +
      '.crm-confirm-no{background:#fff;border:1px solid #D1D5DB;color:#374151}' +
      '.crm-confirm-yes{background:#111827;border:1px solid #111827;color:#fff;font-weight:700}' +
      '.crm-confirm-yes.danger{background:#DC2626;border-color:#DC2626}';
    document.head.appendChild(s);
  }
  window.crmConfirm = function (message, opts) {
    opts = opts || {};
    ensureStyle();
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var overlay = document.createElement('div');
      overlay.className = 'crm-confirm-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var box = document.createElement('div');
      box.className = 'crm-confirm-box';
      var msg = document.createElement('p');
      msg.className = 'crm-confirm-msg';
      msg.id = 'crm-confirm-msg-' + Date.now();
      msg.textContent = String(message || '');
      overlay.setAttribute('aria-labelledby', msg.id);
      var actions = document.createElement('div');
      actions.className = 'crm-confirm-actions';
      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'crm-confirm-no';
      no.textContent = opts.cancelText || '先不要';
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'crm-confirm-yes' + (opts.danger ? ' danger' : '');
      yes.textContent = opts.confirmText || '確定';
      actions.appendChild(no);
      actions.appendChild(yes);
      box.appendChild(msg);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      var done = false;
      function close(result) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* ignore */ }
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        if (e.key === 'Tab') { // 焦點留在視窗內
          var first = no, last = yes;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      no.addEventListener('click', function () { close(false); });
      yes.addEventListener('click', function () { close(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { no.focus(); }, 0);   // 預設焦點在「先不要」，避免誤按 Enter 就取消
    });
  };
})();
