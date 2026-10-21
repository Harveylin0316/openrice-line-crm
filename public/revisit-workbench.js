(function () {
  'use strict';
  function bucket(row) {
    if (row.status === 'pending') return 'pending';
    if (row.status === 'needs_review') return 'review';
    if (row.status === 'sent') return 'sent';
    return 'other';
  }
  function summarize(rows) {
    var counts = { pending: 0, review: 0, sent: 0, other: 0, total: rows.length };
    rows.forEach(function (row) { counts[bucket(row)]++; });
    return counts;
  }
  function filter(rows, mode, query) {
    var q = String(query || '').trim().toLocaleLowerCase();
    return rows.filter(function (row) {
      return (mode === 'all' || bucket(row) === mode) &&
        (!q || [row.recipient_name, row.recipient_email, row.restaurant_name].join(' ').toLocaleLowerCase().includes(q));
    });
  }
  function label(row) {
    if (row.status === 'needs_review' && row.failure_detail === 'outlook_draft_requested') return '草稿已準備・待核對寄出';
    return { pending: '待處理', needs_review: '寄送結果待核對', sent: '已記錄寄出', sending: '交給公司信箱中', failed: '寄送遭拒', skipped: '已排除', cancelled: '已取消' }[row.status] || row.status;
  }
  function next(rows, selected) {
    var start = rows.findIndex(function (r) { return Number(r.id) === Number(selected); });
    for (var offset = 1; offset <= rows.length; offset++) {
      var r = rows[(start + offset) % rows.length];
      if (Number(r.id) !== Number(selected) && ['pending', 'review'].includes(bucket(r))) return r;
    }
    return null;
  }
  function mount(opts) {
    var doc = opts.document, mode = 'all', query = '', rows = [];
    var toolbar = doc.getElementById('rv-worklist');
    var filters = toolbar.querySelector('[data-filters]');
    var names = { all: '全部', review: '待核對', pending: '待處理', sent: '已記錄寄出', other: '其他' };
    var search = toolbar.querySelector('input');
    function paint() {
      var counts = summarize(rows);
      filters.replaceChildren();
      Object.keys(names).forEach(function (key) {
        var b = doc.createElement('button'); b.type = 'button'; b.className = 'rv-btn rv-secondary';
        b.textContent = names[key] + ' ' + (key === 'all' ? counts.total : counts[key]);
        b.setAttribute('aria-pressed', String(mode === key));
        b.addEventListener('click', function () { mode = key; paint(); opts.onFilter(); });
        filters.append(b);
      });
      var visible = filter(rows, mode, query);
      toolbar.querySelector('[data-result-count]').textContent = '顯示 ' + visible.length + ' / ' + rows.length + ' 封';
      var progress = doc.getElementById('rv-batch-progress');
      progress.textContent = '本批 ' + counts.total + ' 封｜待處理 ' + counts.pending + '・待核對 ' + counts.review + '・已記錄寄出 ' + counts.sent + '・其他 ' + counts.other;
    }
    search.addEventListener('input', function () { query = search.value; paint(); opts.onFilter(); });
    var nextButton = toolbar.querySelector('[data-next-recipient]');
    nextButton.addEventListener('click', function () {
      var row = next(rows, opts.selectedId());
      if (row) { mode = 'all'; query = ''; search.value = ''; paint(); opts.onFilter(); opts.select(row.id); }
    });
    return {
      update: function (items, reset) { rows = items; if (reset) { mode = 'all'; query = ''; search.value = ''; } paint(); nextButton.disabled = !next(rows, opts.selectedId()); },
      visible: function () { return filter(rows, mode, query); },
      selected: function () { nextButton.disabled = !next(rows, opts.selectedId()); }
    };
  }
  function overview(doc, data, isOwner, openCampaign) {
    var root = doc.getElementById('rv-next-action'); root.replaceChildren(); root.removeAttribute('role');
    var campaigns = data.campaigns || [];
    var active = campaigns.find(function (c) { return Number(c.needs_review) > 0; }) || campaigns.find(function (c) { return Number(c.pending) > 0; });
    var title = doc.createElement('h2'), text = doc.createElement('p'), b = doc.createElement('button');
    b.type = 'button'; b.className = 'rv-btn rv-primary';
    if (active) {
      title.textContent = Number(active.needs_review) > 0 ? '先核對還沒確認寄出的信' : '繼續處理已準備的回訪信';
      text.textContent = '批次 #' + active.id + '：' + Number(active.pending || 0) + ' 封待處理、' + Number(active.needs_review || 0) + ' 封待核對。開啟草稿不代表已寄出，請先處理現有工作。';
      b.textContent = isOwner ? '繼續這批工作' : '查看這批工作';
      b.addEventListener('click', function () { openCampaign(active.id); });
    } else {
      title.textContent = data.booking_source ? '名單已帶入，準備下一批回訪' : '從用餐名單開始準備回訪';
      text.textContent = '同步名單 → 優惠選用 → 檢查內容 → 在郵件程式寄出 → 回來核對。每位客人獨立一封，保留退訂連結。';
      b.textContent = data.booking_source ? '前往產生草稿' : '前往同步名單';
      b.addEventListener('click', function () { doc.getElementById(data.booking_source ? 'rv-generate' : 'rv-sync-from').focus(); });
    }
    root.append(title, text, b);
  }
  window.RevisitWorkbench = { bucket: bucket, summarize: summarize, filter: filter, label: label, next: next, mount: mount, overview: overview };
})();
