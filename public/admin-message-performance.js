(() => {
  'use strict';
  // 訊息成效：一則訊息一列。指標定義在頁面上的「指標定義」與 src/core/messagePerformanceList.js。
  const $ = (id) => document.getElementById(id);
  const form = $('mp-filters');
  const tbody = $('mp-tbody');
  const status = $('mp-status');
  let rows = [];
  let loadState = 'loading';
  let appliedRange = {};
  let generation = 0;
  let rangeKey = '30d';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));
  const taipeiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const shift = (ymd, days) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const twTime = (v) => { try { return new Date(v).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; } };
  const twDate = (v) => { try { return new Date(v).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' }); } catch (e) { return ''; } };

  function rangeFor(key) {
    const t = taipeiToday();
    if (key === 'today') return [t, t];
    if (key === '7d') return [shift(t, -6), t];
    if (key === 'month') return [t.slice(0, 8) + '01', t];
    return [shift(t, -29), t];
  }
  function markPreset(key) {
    rangeKey = key;
    document.querySelectorAll('[data-mp-range]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mp-range') === key));
  }

  // 點擊率：沒有可追蹤連結→不適用；還沒人收到→尚無資料
  function rateCell(r) {
    if (!r.tracked) return '<span class="mp-na" title="這則訊息沒有可追蹤的連結">不適用</span>';
    if (!r.people) return '<span class="mp-na">尚無資料</span>';
    return '<span class="mp-rate">' + r.rate + '%</span>';
  }
  function clickersCell(r) { return r.tracked ? num(r.clickers) : '<span class="mp-na">—</span>'; }
  function timeCell(r) {
    if (r.basis === 'experiment') return esc(twDate(r.firstAt) + ' – ' + twDate(r.lastAt));
    if (r.type === 'broadcast') return esc(twTime(r.firstAt));
    const a = twDate(r.firstAt); const b = twDate(r.lastAt);
    return esc(a === b ? a : a + ' – ' + b);
  }
  function thumb(src, fallback) {
    return src ? '<div class="mp-thumb" style="background-image:url(&quot;' + esc(src) + '&quot;)"></div>'
      : '<div class="mp-thumb">' + esc(fallback || '') + '</div>';
  }

  function matches(r, q) {
    if (!q) return true;
    const hay = [r.title, r.notification, r.context, r.typeLabel].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.indexOf(w) >= 0);
  }

  function render() {
    if (loadState !== 'ready') return;
    const q = $('mp-q').value.trim();
    const list = rows.filter((r) => matches(r, q));
    const t = list.reduce((a, r) => {
      a.msgs += 1; a.people += r.people;
      if (r.tracked) { a.tp += r.people; a.clickers += r.clickers || 0; }
      return a;
    }, { msgs: 0, people: 0, tp: 0, clickers: 0 });
    const totalRate = t.tp ? Math.round((t.clickers / t.tp) * 1000) / 10 + '%' : '—';
    $('mp-kpis').innerHTML =
      '<div class="mp-kpi"><b>' + num(t.msgs) + '</b><span>訊息數</span></div>' +
      '<div class="mp-kpi"><b>' + num(t.people) + '</b><span>收到人數（合計）</span></div>' +
      '<div class="mp-kpi"><b>' + num(t.clickers) + '</b><span>點擊人數（合計）</span></div>' +
      '<div class="mp-kpi"><b>' + totalRate + '</b><span>合計點擊率</span></div>';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="mp-muted">' + (rows.length ? '沒有符合搜尋的訊息。' : '這段期間沒有送出的訊息。') + '</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((r, i) => {
      const main = '<tr class="mp-row" data-i="' + rows.indexOf(r) + '"><td><div class="mp-msg">' + thumb(r.thumb, r.typeLabel) +
        '<div><span class="mp-tag mp-tag-' + esc(r.type) + '">' + esc(r.typeLabel) + '</span><span class="mp-name">' + esc(r.title) + '</span>' +
        '<div class="mp-meta">' + esc(r.context) + (r.notification && r.notification !== r.title ? '｜通知：' + esc(r.notification) : '') + '</div></div></div></td>' +
        '<td class="mp-col-time">' + timeCell(r) + '</td><td class="n">' + num(r.people) + '</td><td class="n">' + clickersCell(r) + '</td><td class="n">' + rateCell(r) + '</td></tr>';
      const subs = (r.variants || []).map((v) => '<tr class="mp-sub"><td><div class="mp-msg">' + thumb(v.thumb, v.variant.toUpperCase()) +
        '<div><span class="mp-name">' + esc(v.title) + '</span>' + (v.notification ? '<div class="mp-meta">' + esc(v.notification) + '</div>' : '') + '</div></div></td>' +
        '<td class="mp-col-time"></td><td class="n">' + num(v.people) + '</td><td class="n">' + clickersCell(v) + '</td><td class="n">' + rateCell(v) + '</td></tr>').join('');
      return main + subs;
    }).join('');
  }

  async function openDetail(tr) {
    const r = rows[Number(tr.getAttribute('data-i'))];
    // 明細放在這則訊息（含 A/B 版本列）的最後面；已經打開就收起
    let after = tr;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains('mp-sub')) after = after.nextElementSibling;
    const open = after.nextElementSibling;
    if (open && open.classList.contains('mp-detail')) { open.remove(); return; }
    tbody.querySelectorAll('.mp-detail').forEach((d) => d.remove());
    const row = document.createElement('tr');
    row.className = 'mp-detail';
    row.innerHTML = '<td colspan="5"><div class="mp-detail-box">載入中…</div></td>';
    after.after(row);
    const box = row.querySelector('.mp-detail-box');
    const f = r.failures || {};
    const fail = '發送狀況：送出 ' + num(r.sends) + ' 次，LINE 拒絕 ' + num(f.rejected) + ' 次、結果不確定 ' + num(f.uncertain) + ' 次' +
      (f.skipped ? '、略過 ' + num(f.skipped) + ' 次' : '') + (f.pending ? '、處理中 ' + num(f.pending) + ' 次' : '') + '。';
    const params = new URLSearchParams({ type: r.basis === 'experiment' ? 'keyword_ab' : r.type, sourceId: r.sourceId || '', revision: r.revision || '',
      experimentId: r.experimentId || '', from: appliedRange.from, to: appliedRange.to });
    let groups = [];
    try {
      const res = await fetch('/admin/message-performance/messages/detail?' + params.toString());
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || '明細無法讀取');
      groups = d.groups || [];
    } catch (e) { box.innerHTML = esc(fail) + '<br>連結明細暫時讀不到：' + esc(e.message); return; }
    const attributionNote = groups.some(g => g.links.some(l => typeof l.primary === 'boolean'))
      ? '<p class="mp-muted">各連結只計入第一次成功回覆起的觀察期內點擊。列表點擊率只計主要目標；同一人點多個連結，各列人數不可相加。</p>' : '';
    const linkTables = groups.map((g) => {
      const head = g.variant ? '<div style="margin-top:8px;"><b>' + g.variant.toUpperCase() + ' 版</b></div>' : '';
      if (!g.links.length) return head + '<div class="mp-muted">沒有可追蹤的連結。</div>';
      return head + '<table><thead><tr><th>連結</th><th>目的地</th><th style="text-align:right;">點擊次數</th><th style="text-align:right;">點擊人數</th></tr></thead><tbody>' +
        g.links.map((l) => '<tr><td>' + esc(l.label) + (typeof l.primary === 'boolean' ? (l.primary ? '（主要目標）' : '（非主要目標）') : '') + '</td><td class="uri">' + esc(l.uri) + '</td><td style="text-align:right;">' + num(l.clicks) + '</td><td style="text-align:right;">' + num(l.people) + '</td></tr>').join('') +
        '</tbody></table>';
    }).join('');
    box.innerHTML = '<div>' + esc(fail) + '</div>' + attributionNote + linkTables + (r.link ? '<div style="margin-top:6px;"><a href="' + esc(r.link) + '">前往' + esc(r.typeLabel) + '設定 ›</a></div>' : '');
  }

  async function load() {
    const gen = ++generation;
    const from = $('mp-from').value;
    const to = $('mp-to').value;
    if (!from || !to) { status.textContent = '請選擇開始與結束日期'; return; }
    if (from > to) { status.textContent = '開始日期不能晚於結束日期'; return; }
    status.textContent = '';
    loadState = 'loading';
    rows = [];
    $('mp-kpis').textContent = '載入中…';
    tbody.innerHTML = '<tr><td colspan="5" class="mp-muted">載入中…</td></tr>';
    const params = new URLSearchParams({ from, to });
    if ($('mp-source').value) params.set('source', $('mp-source').value);
    const url = new URL(location.href);
    ['source', 'from', 'to'].forEach((k) => url.searchParams.delete(k));
    params.forEach((v, k) => url.searchParams.set(k, v));
    history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
    try {
      const res = await fetch('/admin/message-performance/messages?' + params.toString());
      const d = await res.json();
      if (gen !== generation) return;
      if (!d.ok) throw new Error(d.error || '資料無法讀取');
      rows = d.rows || [];
      appliedRange = { from, to };
      loadState = 'ready';
      if (d.truncated) status.textContent = '訊息太多，只顯示最近 300 則；請縮短期間或選擇類型。';
      render();
    } catch (e) {
      if (gen !== generation) return;
      rows = [];
      loadState = 'error';
      $('mp-kpis').textContent = '成效資料暫時無法讀取';
      tbody.innerHTML = '<tr><td colspan="5" class="mp-muted">讀取失敗：' + esc(e.message) + '</td></tr>';
    }
  }

  document.querySelectorAll('[data-mp-range]').forEach((b) => b.addEventListener('click', () => {
    const key = b.getAttribute('data-mp-range');
    markPreset(key);
    if (key === 'custom') { $('mp-from').focus(); return; }
    const [f, t] = rangeFor(key);
    $('mp-from').value = f; $('mp-to').value = t;
    load();
  }));
  ['mp-from', 'mp-to'].forEach((id) => $(id).addEventListener('change', () => markPreset('custom')));
  $('mp-source').addEventListener('change', load);
  $('mp-q').addEventListener('input', render);
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.mp-row');
    if (tr && !e.target.closest('a')) openDetail(tr);
  });

  // 手機上「指標定義」預設收起（佔太多畫面），點一下就能展開；電腦維持展開
  try { if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) $('mp-defs').open = false; } catch (e) { /* ignore */ }

  // 初始：網址帶的類型與日期優先（其他頁的「看成效」連結會帶 ?source=）
  const qs = new URLSearchParams(location.search);
  if (qs.get('source')) $('mp-source').value = qs.get('source');
  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  if (ymd(qs.get('from')) && ymd(qs.get('to'))) {
    $('mp-from').value = qs.get('from'); $('mp-to').value = qs.get('to');
    const match = ['today', '7d', '30d', 'month'].find((k) => { const r = rangeFor(k); return r[0] === qs.get('from') && r[1] === qs.get('to'); });
    markPreset(match || 'custom');
  } else {
    const [f, t] = rangeFor('30d');
    $('mp-from').value = f; $('mp-to').value = t;
    markPreset('30d');
  }
  load();
})();
