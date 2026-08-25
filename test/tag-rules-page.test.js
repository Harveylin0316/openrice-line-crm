// 自動貼標籤頁面：挑事件→換挑選器→試算→加規則，整條路走得通。
const path = require('path');
const fs = require('fs');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIP jsdom 沒裝'); process.exit(0); }
const ejs = require('ejs');

let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const CATALOG = [
  { kind: 'played', label: '玩過遊戲', target_kind: 'activity', unit: '次', hint: '抽過轉盤' },
  { kind: 'messaged', label: '傳過訊息', target_kind: 'text', unit: '則', hint: '想只算特定內容就填字' },
  { kind: 'joined_days', label: '加好友滿幾天', target_kind: 'none', unit: '天', hint: '填天數' }
];
const DATA = {
  ok: true,
  rules: [{ id: 1, tag_id: 1, rule_kind: 'played', threshold: 2, target: 'share-miles',
            target_label: '分享超有哩', window_days: 30, active: true, last_run_at: '2026-08-25T02:00:00Z',
            last_added: 3, tag_name: '常客', tag_color: '#E8491D' }],
  catalog: CATALOG,
  tags: [{ id: 1, name: '常客', color: '#E8491D' }, { id: 2, name: '新朋友', color: '#FBC02D' }],
  targets: { activity: [{ value: 'share-miles', label: '分享超有哩' }], menu: [], broadcast: [], source: [] }
};

(async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'admin_tag_rules.ejs'),
    { user: 'admin', isAdmin: true, bodyClass: 'admin-shell', title: '自動貼標籤' });

  const posted = [];
  // fetch 要在頁面腳本跑之前就備好（腳本一載入就會去要資料）
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x/admin/tag-rules',
    beforeParse(w) {
      w.fetch = async (url, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        if (String(url).indexOf('/preview') >= 0) {
          posted.push({ url: String(url), body });
          // 依門檻回不同人數，證明前端真的有把條件送出去
          return { json: async () => ({ ok: true, count: body.threshold >= 5 ? 0 : 6, names: ['小明', '小華'] }) };
        }
        if (o && o.method === 'POST') { posted.push({ url: String(url), body }); return { json: async () => ({ ok: true, id: 9 }) }; }
        return { json: async () => DATA };
      };
    } });
  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 260));
  const d = w.document;

  // 1) 事件清單有畫出來，而且帶「現在幾人」
  const kindSel = d.getElementById('tr-kind');
  ok(kindSel && kindSel.options.length === 3, '三個事件都在下拉選單裡');
  ok(/現在 \d+ 人/.test(kindSel.options[0].text), '選單直接顯示「現在幾人符合」（'+kindSel.options[0].text+'）');

  // 2) 現有規則照人話寫出來
  const listTxt = d.getElementById('tr-list').textContent;
  ok(/玩過遊戲/.test(listTxt) && /分享超有哩/.test(listTxt) && /滿 2 次/.test(listTxt) &&
     /只算最近 30 天/.test(listTxt) && /常客/.test(listTxt), '規則寫成一句看得懂的話：' + listTxt.slice(0, 60).replace(/\s+/g, ' '));

  // 3) 換成「傳過訊息」→ 挑選器要變成自己打字
  kindSel.value = 'messaged';
  kindSel.dispatchEvent(new w.Event('change'));
  ok(d.getElementById('tr-target').hidden === true && d.getElementById('tr-target-text').hidden === false,
     '選「傳過訊息」時，對象欄位變成可以自己打字');
  ok(d.getElementById('tr-unit').textContent === '則', '單位跟著事件變（則）');

  // 4) 換成「加好友滿幾天」→ 完全不用挑對象
  kindSel.value = 'joined_days';
  kindSel.dispatchEvent(new w.Event('change'));
  ok(d.getElementById('tr-target').hidden && d.getElementById('tr-target-text').hidden &&
     d.getElementById('tr-tgt-word').hidden, '不需要挑對象的事件，就不顯示那一欄');

  // 5) 試算：有人符合
  kindSel.value = 'played';
  kindSel.dispatchEvent(new w.Event('change'));
  d.getElementById('tr-target').value = 'share-miles';
  d.getElementById('tr-n').value = '2';
  d.getElementById('tr-window').value = '30';
  posted.length = 0;
  d.getElementById('tr-preview').click();
  await new Promise(r => setTimeout(r, 60));
  const pv = posted.find(p => p.url.indexOf('/preview') >= 0);
  ok(pv && pv.body.rule_kind === 'played' && pv.body.target === 'share-miles' &&
     pv.body.threshold === 2 && pv.body.window_days === 30, '試算把所有條件都送出去了');
  const box = d.getElementById('tr-preview-box');
  ok(!box.hidden && /6/.test(box.textContent) && /小明/.test(box.textContent),
     '試算結果講人數也給名字：' + box.textContent.slice(0, 40).replace(/\s+/g, ' '));

  // 6) 試算：沒人符合時要講清楚不是壞掉
  d.getElementById('tr-n').value = '5';
  d.getElementById('tr-preview').click();
  await new Promise(r => setTimeout(r, 60));
  ok(/沒有人符合/.test(box.textContent) && /以後有人達標就會自動貼上/.test(box.textContent),
     '沒人符合時說明原因，不會讓人以為壞掉');

  // 7) 加規則：帶上對象的名字（列表才顯示得出「分享超有哩」而不是代號）
  posted.length = 0;
  d.getElementById('tr-n').value = '2';
  d.getElementById('tr-add').click();
  await new Promise(r => setTimeout(r, 60));
  const add = posted.find(p => p.url.indexOf('/tag-rules') >= 0 && p.url.indexOf('preview') < 0);
  ok(add && add.body.target === 'share-miles' && add.body.target_label === '分享超有哩' &&
     add.body.tag_id === 1, '加規則會一併存下給人看的名稱');
  ok(/五分鐘內/.test(d.getElementById('tr-note').textContent), '加完告訴你什麼時候會生效');

  // 8) 畫面上沒有術語（只看看得見的字，程式碼本身不算）
  const vis = d.body.cloneNode(true);
  [].slice.call(vis.querySelectorAll('script,style')).forEach(n => n.remove());
  const all = vis.textContent;
  ok(!/rule_kind|target_kind|\bAPI\b|JSON|SQL|\buid\b|null|undefined/i.test(all),
     '畫面上沒有工程術語');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n自動貼標籤頁面全部通過');
  process.exit(failed ? 1 : 0);
})();
