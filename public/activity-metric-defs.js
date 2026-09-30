/*
 * 活動管理指標定義：活動列表、玩家數據頁共用這一份。
 * 頁面上標 data-metric="<key>" 的指標旁會出現「?」，點開看定義；
 * 放一個 <div data-metric-glossary="<group,group>"> 會列出完整定義表。
 * 改定義只改這裡；改了算法一定要同步改這裡（test/activity-metric-defs.test.js 會檢查每個標記都有定義）。
 */
(function (w) {
  'use strict';
  var GROUPS = [
    { id: 'list', title: '活動列表', items: [
      ['list_prizes', '獎品', '這檔活動設定的獎項種數，含銘謝惠顧。'],
      ['list_players', '玩家', '玩過至少一次的不重複 LINE 用戶數。不含後台開獎。'],
      ['list_plays', '總抽次', '用戶自己玩的總次數。不含後台開獎。']
    ] },
    { id: 'overview', title: '總覽', items: [
      ['ov_plays', '總抽次／期間抽次', '所選期間內用戶自己玩的次數。不含後台開獎。'],
      ['ov_players', '獨立玩家', '所選期間內玩過的不重複人數。'],
      ['ov_wins', '中獎次數', '所選期間內抽中實際獎品的次數。銘謝惠顧不算；後台開獎抽中算。'],
      ['ov_24h', '24 小時內', '從現在往回 24 小時的抽獎次數。不受日期篩選影響。'],
      ['ov_7d', '7 天內', '從現在往回 7 天的抽獎次數。不受日期篩選影響。']
    ] },
    { id: 'funnel', title: '開啟成效（皆為不重複人數）', items: [
      ['fn_open', '開啟活動', 'LINE 身分驗證成功、載入活動頁的人。後台安全預覽、電腦 QR Code 畫面不算。'],
      ['fn_start', '開始玩', '按下開始（轉、刮、拉、抽）的人。'],
      ['fn_complete', '拿到結果', '伺服器回傳抽獎結果的人。'],
      ['fn_share', '分享過', '在活動頁完成分享（LINE 卡片或複製連結）的人。分享次數另計。'],
      ['fn_open7d', '7 天內開啟', '從現在往回 7 天開啟過的人；下方附 24 小時內。'],
      ['fn_rates', '開始率／完成率／分享率', '開始玩、拿到結果、分享過各自 ÷ 開啟活動。']
    ] },
    { id: 'dist', title: '抽獎次數分布', items: [
      ['dist_bucket', 'N 抽', '所選期間內剛好玩了 N 次的人數。5 抽以上合併一格。不含後台開獎。'],
      ['dist_share', '占玩家', '該格人數 ÷ 所選期間玩家總數。']
    ] },
    { id: 'players', title: '玩家清單', items: [
      ['pl_invited_by', '被誰邀請', '第一個讓此人算入邀請的分享者。標「原本就是好友」的不計加碼。'],
      ['pl_total', '總共有幾次', '基礎次數＋邀請加碼（上限內）＋人工補次與群發派送。有個別配額時以個別配額為準。'],
      ['pl_used', '用了幾次', '所選期間內玩的次數。不含後台開獎。'],
      ['pl_left', '還剩', '總共有幾次 − 全部期間已玩次數。不受日期篩選影響。'],
      ['pl_wins', '中獎', '所選期間內抽中實際獎品的次數。銘謝惠顧不算。'],
      ['pl_invites', '邀請成功', '由此人邀請、原本不是好友的人數，計入加碼。原本就是好友的另列、不計。'],
      ['pl_last', '最後活動', '此人最後一次玩的時間。'],
      ['pl_override', '個別配額', '後台手動指定此人的總次數，取代一般公式。']
    ] },
    { id: 'testers', title: '測試帳號重玩', items: [
      ['ts_plays', '次抽獎', '此測試帳號在本活動玩的次數。'],
      ['ts_invites', '位成功邀請', '此測試帳號邀請、算新好友的人數。測試帳號互邀一律算新好友。'],
      ['ts_bonus', '次加碼', '人工補次與群發派送給此帳號的次數合計。']
    ] },
    { id: 'claim', title: '領券成效（同一批人、固定觀察期、不重複人數）', items: [
      ['cl_cohort', '同一批人', '第一次開啟領券頁落在所選期間的人。之後再開不重算。'],
      ['cl_window', '觀察期', '每人從自己第一次開啟起算 N 天內完成的步驟才算。'],
      ['cl_open', '開啟畫面', 'LINE 身分驗證成功、載入領券頁的人。'],
      ['cl_shown', '顯示序號', '按領取後拿到並看到序號的人。'],
      ['cl_oos', '序號發完', '按了領取但序號已發完、沒拿到的人。'],
      ['cl_copy', '複製序號', '拿到序號後按「複製序號」的人。'],
      ['cl_redeem', '前往兌換', '拿到序號後按「前往兌換」的人。'],
      ['cl_rate', '對開啟 %', '該步人數 ÷ 開啟畫面。'],
      ['cl_existing', '既有好友', '會員加入日期早於分界日的人（加入日期＝名單庫的「加入日期」）。'],
      ['cl_new', '新好友', '會員加入日期在分界日當天或之後的人。'],
      ['cl_unknown', '未知', '會員表查不到加入日期的人。'],
      ['cl_immature', '觀察期未滿', '開啟至今還不到 N 天的人，他們的後續步驟可能還會增加。']
    ] }
  ];
  var DEFS = {};
  GROUPS.forEach(function (g) { g.items.forEach(function (it) { DEFS[it[0]] = { label: it[1], text: it[2], group: g.id }; }); });

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var CSS = '.mdef-i{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;margin-left:4px;border-radius:50%;border:1px solid #D1D5DB;background:#fff;color:#6B7280;font-size:10px;font-weight:700;line-height:1;cursor:help;vertical-align:middle;padding:0;font-family:inherit}' +
    '.mdef-pop{position:absolute;z-index:60;max-width:260px;padding:8px 10px;border-radius:8px;background:#1F2937;color:#fff;font-size:12px;line-height:1.55;font-weight:400;text-align:left;white-space:normal;box-shadow:0 6px 18px rgba(0,0,0,.18)}' +
    '.mdef-glossary{margin-top:6px}.mdef-glossary details{border:1px solid #ECECEE;border-radius:10px;background:#fff}' +
    '.mdef-glossary summary{cursor:pointer;padding:10px 14px;font-weight:700;font-size:14px}' +
    '.mdef-glossary .g{padding:0 14px 12px}.mdef-glossary h3{margin:10px 0 4px;font-size:13px;color:#92400E}' +
    '.mdef-glossary dl{margin:0;display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:4px 12px;font-size:12.5px;line-height:1.55}' +
    '.mdef-glossary dt{font-weight:700;color:#1F2937}.mdef-glossary dd{margin:0;color:#4B5563}';

  var pop = null;
  function closePop() { if (pop && pop.parentNode) pop.parentNode.removeChild(pop); pop = null; }
  function openPop(btn, def) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'mdef-pop';
    pop.setAttribute('role', 'tooltip');
    pop.textContent = def.text;
    document.body.appendChild(pop);
    var r = btn.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.left + w.scrollX - 20, (w.innerWidth || 1200) - 276 + w.scrollX));
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + w.scrollY + 6) + 'px';
  }

  /** 替 root 裡所有 data-metric 標記加「?」；已加過的略過 */
  function decorate(root) {
    root = root || document;
    Array.prototype.forEach.call(root.querySelectorAll('[data-metric]'), function (el) {
      if (el.getAttribute('data-metric-done')) return;
      var def = DEFS[el.getAttribute('data-metric')];
      if (!def) return;
      el.setAttribute('data-metric-done', '1');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mdef-i';
      b.textContent = '?';
      b.title = def.text;
      b.setAttribute('aria-label', def.label + '：' + def.text);
      b.addEventListener('click', function (e) { e.stopPropagation(); if (pop) closePop(); else openPop(b, def); });
      el.appendChild(b);
    });
  }
  function renderGlossary(root) {
    root = root || document;
    Array.prototype.forEach.call(root.querySelectorAll('[data-metric-glossary]'), function (box) {
      var want = String(box.getAttribute('data-metric-glossary') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var groups = GROUPS.filter(function (g) { return !want.length || want.indexOf(g.id) >= 0; });
      box.className = (box.className ? box.className + ' ' : '') + 'mdef-glossary';
      box.innerHTML = '<details><summary>指標定義</summary><div class="g">' + groups.map(function (g) {
        return '<h3>' + esc(g.title) + '</h3><dl>' + g.items.map(function (it) {
          return '<dt>' + esc(it[1]) + '</dt><dd>' + esc(it[2]) + '</dd>';
        }).join('') + '</dl>';
      }).join('') + '</div></details>';
    });
  }
  function init(root) {
    if (!document.getElementById('mdef-css')) {
      var st = document.createElement('style'); st.id = 'mdef-css'; st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    decorate(root); renderGlossary(root);
  }
  document.addEventListener('click', closePop);
  w.ActivityMetricDefs = { GROUPS: GROUPS, DEFS: DEFS, decorate: decorate, renderGlossary: renderGlossary, init: init };
})(window);
