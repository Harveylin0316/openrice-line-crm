// 圖文選單核心：設定 → LINE 物件的轉換與驗證；API 封裝打對主機、擋超大圖。
const path = require('path');
const { buildLineMenuObject, createLineRichMenuService, sanitizeMenuConfig } = require(path.join(__dirname, '..', 'src/core/lineRichMenu'));

let failed = 0;
function ok(cond, label) { console.log((cond ? 'OK  ' : '錯！ ') + label); if (!cond) failed++; }
function throws(fn, part, label) {
  try { fn(); ok(false, label + '（應該要擋下來卻沒擋）'); }
  catch (e) { ok(String(e.message).indexOf(part) >= 0, label + ' → ' + e.message); }
}

(async () => {
  // ── buildLineMenuObject ──
  const cfg = {
    size: 'large', chat_bar_text: '選單選單選單選單選單選單選單選單', open_by_default: true,
    cells: [{ x: 0, y: 0, w: 1250, h: 1686 }, { x: 1250, y: 0, w: 1250, h: 1686 }],
    buttons: [
      { label: '找餐廳', action: { type: 'uri', uri: 'https://www.openrice.com' } },
      { label: '玩遊戲', action: { type: 'message', text: '分享超有哩' } }
    ]
  };
  const m = buildLineMenuObject({ ...cfg, name: '測試選單' });
  ok(m.size.width === 2500 && m.size.height === 1686, '大選單尺寸 2500x1686');
  ok(m.chatBarText.length <= 14, 'chatBarText 截到 14 字內（實際 ' + m.chatBarText.length + '）');
  ok(m.areas.length === 2, '兩個區域');
  ok(m.areas[0].action.type === 'uri' && m.areas[0].action.label === '找餐廳', 'uri 動作帶 label');
  ok(m.areas[1].action.type === 'message' && m.areas[1].action.text === '分享超有哩', 'message 動作');
  ok(m.areas[1].bounds.x + m.areas[1].bounds.width <= 2500, '邊界不超出');

  const small = buildLineMenuObject({ ...cfg, size: 'compact', name: 'x',
    cells: [{ x: 0, y: 0, w: 2500, h: 843 }], buttons: [cfg.buttons[0]] });
  ok(small.size.height === 843, '小選單高 843');

  throws(() => buildLineMenuObject({ name: 'x', cells: [], buttons: [] }), '沒有任何格子', '空格子要擋');
  throws(() => buildLineMenuObject({ name: 'x',
    cells: Array.from({ length: 21 }, (_, i) => ({ x: 0, y: 0, w: 100, h: 100 })),
    buttons: [] }), '最多 20', '21 格要擋');
  throws(() => buildLineMenuObject({ name: 'x', cells: [{ x: 0, y: 0, w: 100, h: 100 }],
    buttons: [{ action: { type: 'uri', uri: 'javascript:alert(1)' } }] }), 'https', '危險網址要擋');
  throws(() => buildLineMenuObject({ name: 'x', cells: [{ x: 0, y: 0, w: 100, h: 100 }],
    buttons: [{ action: { type: 'message', text: '  ' } }] }), '發送的文字', '空文字要擋');
  throws(() => buildLineMenuObject({ name: 'x', cells: [{ x: 0, y: 0, w: 100, h: 100 }],
    buttons: [{}] }), '要做什麼', '沒動作要擋');
  throws(() => buildLineMenuObject({ name: 'x', cells: [{ x: 2400, y: 0, w: 200, h: 100 }],
    buttons: [{ action: { type: 'uri', uri: 'https://a.b' } }] }), '超出圖片範圍', '出界要擋');
  throws(() => buildLineMenuObject({ name: 'x', cells: [{ x: 0, y: 0, w: 100, h: 100 }],
    buttons: [{ action: { type: 'uri', uri: 'https://a.b' } }] }), '文字或圖示', '沒字沒圖示的空白格要擋');
  const iconOnly = buildLineMenuObject({ name: 'x', cells: [{ x: 0, y: 0, w: 100, h: 100 }],
    buttons: [{ icon: 'bowl', action: { type: 'uri', uri: 'https://a.b' } }] });
  ok(iconOnly.areas.length === 1, '只有圖示沒有字可以過（圖示本身就是內容）');

  // ── sanitizeMenuConfig：把怪東西洗掉 ──
  const dirty = sanitizeMenuConfig({
    size: 'huge', layout: 'x'.repeat(99), bg: '#FBC02D', chat_bar_text: '選單選單選單選單選單',
    buttons: { length: '<img src=x onerror=alert(1)>' },   // 物件冒充陣列（審查抓到的 XSS 路徑）
    cells: [{ x: '10', y: 5.7, w: 100, h: 100 }, 'garbage'],
    evil_key: 'x'
  });
  ok(Array.isArray(dirty.buttons) && dirty.buttons.length === 0, '假陣列被洗成真的空陣列');
  ok(dirty.size === 'large', '亂填的尺寸落回大選單');
  ok(dirty.layout.length <= 30 && dirty.chat_bar_text.length <= 14, '長度都截住');
  ok(!('evil_key' in dirty), '不認識的欄位丟掉');
  ok(dirty.cells[0].x === 10 && dirty.cells[0].y === 6, '座標轉成整數');

  // ── service：主機、方法、超大圖 ──
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opt) => {
    calls.push({ url, method: (opt && opt.method) || 'GET', body: opt && opt.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-abc' }),
             headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const svc = createLineRichMenuService({ channelAccessToken: 'tok' });
  const id = await svc.createRichMenu({ size: { width: 2500, height: 1686 } });
  ok(id === 'richmenu-abc', 'createRichMenu 回 id');
  ok(calls[0].url === 'https://api.line.me/v2/bot/richmenu', '建選單打 api.line.me');
  await svc.uploadImage('richmenu-abc', Buffer.alloc(1000), 'image/jpeg');
  ok(calls[1].url.indexOf('https://api-data.line.me/') === 0, '傳圖打 api-data.line.me');
  let big = false;
  try { await svc.uploadImage('x', Buffer.alloc(1024 * 1024 + 1), 'image/jpeg'); } catch (e) { big = /1MB/.test(e.message); }
  ok(big, '超過 1MB 的圖直接擋');
  global.fetch = origFetch;

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n核心轉換全部通過');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('爆掉:', e); process.exit(2); });
