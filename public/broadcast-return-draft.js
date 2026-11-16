// 排程中的群發「退回草稿」：停止這次排程（不會送出），把所有設定帶回群發頁重新編輯。
(function () {
  function bind(btn) {
    if (btn.__returnDraftBound) return;
    btn.__returnDraftBound = true;
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-id');
      if (!/^[1-9]\d*$/.test(id || '')) return;
      var ask = window.crmConfirm
        ? window.crmConfirm('把 #' + id + ' 退回草稿？這次排程會先停止、不會送出；訊息、受眾條件、A/B 與排程時間都會帶回編輯頁，改完重新預覽收件人再排程即可。', { confirmText: '退回草稿' })
        : Promise.resolve(window.confirm('把 #' + id + ' 退回草稿？'));
      ask.then(function (yes) {
        if (!yes) return;
        var orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '退回中…';
        fetch('/admin/broadcast/' + id + '/return-to-draft', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || !data.ok) throw new Error((data && (data.detail || data.error)) || '未知錯誤');
            var to = '/admin/broadcast?restore=' + id;
            if (typeof window.crmNavigate === 'function') window.crmNavigate(to); else window.location.href = to;
          })
          .catch(function (e) {
            alert('退回草稿失敗：' + e.message);
            btn.disabled = false;
            btn.textContent = orig;
          });
      });
    });
  }
  function init() { document.querySelectorAll('.sched-draft-btn').forEach(bind); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
