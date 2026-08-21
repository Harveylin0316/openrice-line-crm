/**
 * LINE 圖文選單（Rich Menu）API 封裝。
 *
 * 注意事項（都是實際規格，別憑感覺改）：
 * - 建選單／查列表／設預設 走 api.line.me；上傳與下載選單圖走 api-data.line.me，主機不同。
 * - 圖片限制：JPEG/PNG、1MB 以下、寬 800–2500、高 ≥250、寬高比 ≥1.45。
 *   標準尺寸 2500×1686（大）與 2500×843（小）。
 * - 一個選單最多 20 個可點區域（areas）。
 * - 在「LINE 官方後台（OA Manager）」做的選單不會出現在這個 API 的列表裡；
 *   反之，用 API 設的預設選單會蓋過官方後台設定的那個。UI 要照實講。
 */

const API = 'https://api.line.me';
const DATA_API = 'https://api-data.line.me';

function createLineRichMenuService({ channelAccessToken }) {
  const token = channelAccessToken || '';

  async function call(method, url, { body, contentType, raw } = {}) {
    const headers = { Authorization: 'Bearer ' + token };
    let payload;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        headers['Content-Type'] = contentType || 'application/octet-stream';
        payload = body;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    const resp = await fetch(url, { method, headers, body: payload });
    if (raw) return resp;
    let json = null;
    const text = await resp.text();
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
    if (!resp.ok) {
      const detail = (json && (json.message || json.raw)) || ('HTTP ' + resp.status);
      const err = new Error('LINE API ' + resp.status + ': ' + String(detail).slice(0, 300));
      err.status = resp.status;
      err.line = json;
      throw err;
    }
    return json;
  }

  /** 建立選單，回 richMenuId */
  async function createRichMenu(menu) {
    const out = await call('POST', API + '/v2/bot/richmenu', { body: menu });
    return out.richMenuId;
  }

  /** 上傳選單圖（Buffer；contentType 必須是 image/jpeg 或 image/png） */
  async function uploadImage(richMenuId, buffer, contentType) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('圖片內容是空的');
    if (buffer.length > 1024 * 1024) throw new Error('圖片超過 1MB（' + Math.round(buffer.length / 1024) + 'KB）');
    await call('POST', DATA_API + '/v2/bot/richmenu/' + encodeURIComponent(richMenuId) + '/content',
      { body: buffer, contentType });
  }

  /** 下載選單圖，回 { buffer, contentType }；LINE 那邊沒有圖會 404 */
  async function downloadImage(richMenuId) {
    const resp = await call('GET', DATA_API + '/v2/bot/richmenu/' + encodeURIComponent(richMenuId) + '/content', { raw: true });
    if (!resp.ok) {
      const err = new Error('LINE API ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { buffer, contentType: resp.headers.get('content-type') || 'image/jpeg' };
  }

  /** 所有用 API 建的選單 */
  async function listRichMenus() {
    const out = await call('GET', API + '/v2/bot/richmenu/list');
    return Array.isArray(out.richmenus) ? out.richmenus : [];
  }

  /** 目前所有人看到的預設選單。
   *  回 { id, owned_elsewhere }：
   *  - id=null, owned_elsewhere=false → 沒有預設選單
   *  - id=null, owned_elsewhere=true  → 預設選單是「LINE 官方後台（OA Manager）」設的，
   *    API 讀不到內容（LINE 回 403 the richmenu is owned by another channel，實測確認）。
   *    這不是錯誤——大多數帳號一開始都是這個狀態。 */
  async function getDefaultRichMenu() {
    try {
      const out = await call('GET', API + '/v2/bot/user/all/richmenu');
      return { id: out.richMenuId || null, owned_elsewhere: false };
    } catch (e) {
      if (e.status === 404) return { id: null, owned_elsewhere: false };
      if (e.status === 403) return { id: null, owned_elsewhere: true };
      throw e;
    }
  }

  /** 設為所有人的預設選單 */
  async function setDefault(richMenuId) {
    await call('POST', API + '/v2/bot/user/all/richmenu/' + encodeURIComponent(richMenuId));
  }

  /** 取消預設（所有人都看不到選單） */
  async function clearDefault() {
    await call('DELETE', API + '/v2/bot/user/all/richmenu');
  }

  /** 刪除選單（已是預設也刪得掉，用戶端選單會直接消失） */
  async function deleteRichMenu(richMenuId) {
    try {
      await call('DELETE', API + '/v2/bot/richmenu/' + encodeURIComponent(richMenuId));
    } catch (e) {
      if (e.status === 404) return; // 已經不在就當刪好了
      throw e;
    }
  }

  /** 分頁切換用的別名：先試更新，不存在就建立（別名一經建立 id 永遠不變） */
  async function upsertAlias(aliasId, richMenuId) {
    try {
      await call('POST', API + '/v2/bot/richmenu/alias/' + encodeURIComponent(aliasId),
        { body: { richMenuId } });
    } catch (e) {
      if (e.status !== 404) throw e;
      await call('POST', API + '/v2/bot/richmenu/alias',
        { body: { richMenuAliasId: aliasId, richMenuId } });
    }
  }
  async function deleteAlias(aliasId) {
    try { await call('DELETE', API + '/v2/bot/richmenu/alias/' + encodeURIComponent(aliasId)); }
    catch (e) { if (e.status !== 404) throw e; }
  }

  /** 把選單綁到一批用戶（名單專屬選單）；一次最多 500 人，這裡自動分批 */
  async function bulkLink(richMenuId, userIds) {
    for (let i = 0; i < userIds.length; i += 500) {
      await call('POST', API + '/v2/bot/richmenu/bulk/link',
        { body: { richMenuId, userIds: userIds.slice(i, i + 500) } });
    }
  }
  /** 解除一批用戶的專屬選單（回到所有人看到的那個） */
  async function bulkUnlink(userIds) {
    for (let i = 0; i < userIds.length; i += 500) {
      await call('POST', API + '/v2/bot/richmenu/bulk/unlink',
        { body: { userIds: userIds.slice(i, i + 500) } });
    }
  }

  return {
    createRichMenu, uploadImage, downloadImage,
    listRichMenus, getDefaultRichMenu, setDefault, clearDefault, deleteRichMenu,
    upsertAlias, deleteAlias, bulkLink, bulkUnlink
  };
}

/** 分頁列高度（2500 寬座標系）。有兩個以上分頁時，圖最上面這一條是分頁頭。 */
const TAB_BAR_H = 176;

/** 把設定攤平成分頁陣列：舊格式（cells/buttons 在最外層）視為單一分頁 */
function normalizeTabs(config) {
  if (Array.isArray(config.tabs) && config.tabs.length > 0) {
    return config.tabs.map(t => ({
      label: String((t && t.label) || '').slice(0, 10),
      cells: Array.isArray(t && t.cells) ? t.cells : [],
      buttons: Array.isArray(t && t.buttons) ? t.buttons : []
    }));
  }
  return [{ label: '', cells: Array.isArray(config.cells) ? config.cells : [],
            buttons: Array.isArray(config.buttons) ? config.buttons : [] }];
}

/**
 * 把後台編輯器的設定轉成 LINE 的 rich menu 物件。
 * 多分頁時一個分頁＝一張選單：opts.tabIndex 指定要輸出哪一頁，
 * opts.aliasIds 是每一頁的別名（分頁頭用 richmenuswitch 互切），
 * opts.trackId 帶在切換動作的 data 裡（webhook 靠它記錄「誰切了分頁」）。
 */
function buildLineMenuObject(config, opts) {
  opts = opts || {};
  const tabs = normalizeTabs(config);
  const fullImageTabs = new Set();
  {
    const src = Array.isArray(config.tabs) && config.tabs.length ? config.tabs : [config];
    src.forEach((t, ti) => { if (t && t.full_image_url) fullImageTabs.add(ti); });
  }
  const tabIndex = Number(opts.tabIndex || 0);
  const tab = tabs[tabIndex];
  if (!tab) throw new Error('找不到第 ' + (tabIndex + 1) + ' 個分頁');
  const multiTab = tabs.length > 1;
  if (multiTab && config.size === 'compact') throw new Error('有分頁的選單要用大尺寸');
  if (tabs.length > 3) throw new Error('分頁最多 3 個');

  const width = 2500;
  const height = config.size === 'compact' ? 843 : 1686;
  const name = String(config.name || '圖文選單').slice(0, 300) + (multiTab ? ('｜' + (tab.label || ('分頁' + (tabIndex + 1)))) : '');
  const chatBarText = String(config.chat_bar_text || '選單').slice(0, 14);
  const cells = tab.cells;
  const buttons = tab.buttons;
  if (cells.length === 0) throw new Error((multiTab ? ('「' + (tab.label || ('分頁' + (tabIndex + 1))) + '」') : '選單') + '沒有任何格子');
  if (cells.length + (multiTab ? tabs.length - 1 : 0) > 20) throw new Error('格子最多 20 個');

  // 分頁頭：其他分頁可點（切過去），自己這頁的頭不放動作
  const tabAreas = [];
  if (multiTab) {
    const aliasIds = Array.isArray(opts.aliasIds) ? opts.aliasIds : [];
    for (let t = 0; t < tabs.length; t++) {
      if (t === tabIndex) continue;
      if (!aliasIds[t]) throw new Error('第 ' + (t + 1) + ' 個分頁還沒有別名，發布流程有問題');
      const x0 = Math.round(t * width / tabs.length);
      const x1 = Math.round((t + 1) * width / tabs.length);
      tabAreas.push({
        bounds: { x: x0, y: 0, width: x1 - x0, height: TAB_BAR_H },
        action: {
          type: 'richmenuswitch',
          richMenuAliasId: aliasIds[t],
          data: 'rmtab|' + String(opts.trackId || 0) + '|' + t
        }
      });
    }
  }

  const areas = cells.map((c, i) => {
    const b = buttons[i] || {};
    const a = b.action || {};
    const bounds = {
      x: Math.max(0, Math.round(c.x)),
      y: Math.max(0, Math.round(c.y)),
      width: Math.max(1, Math.round(c.w)),
      height: Math.max(1, Math.round(c.h))
    };
    if (bounds.x + bounds.width > width || bounds.y + bounds.height > height) {
      throw new Error('第 ' + (i + 1) + ' 格超出圖片範圍');
    }
    let action;
    if (a.type === 'uri') {
      const uri = String(a.uri || '').trim();
      if (!/^(https:\/\/|line:\/\/|tel:)/.test(uri)) throw new Error('第 ' + (i + 1) + ' 格的網址要以 https:// 開頭');
      action = { type: 'uri', uri: uri.slice(0, 1000) };
    } else if (a.type === 'message') {
      const text = String(a.text || '').trim();
      if (!text) throw new Error('第 ' + (i + 1) + ' 格還沒填要發送的文字');
      action = { type: 'message', text: text.slice(0, 300) };
    } else {
      throw new Error('第 ' + (i + 1) + ' 格還沒設定按下去要做什麼');
    }
    const label = String(b.label || '').trim().slice(0, 20);
    if (label) action.label = label;
    // 動作合法之後才檢查外觀：沒字也沒圖示的格子會在正式選單上變成空白（或印出佔位字），
    // 使用者按了也不知道自己按到什麼——直接擋下。
    if (!fullImageTabs.has(tabIndex) &&
        !label && !(b.icon && String(b.icon).trim()) && !(b.image && String(b.image).trim())) {
      throw new Error('第 ' + (i + 1) + ' 格還沒放文字、圖示或圖片');
    }
    return { bounds, action };
  });

  if (multiTab) {
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].y < TAB_BAR_H) throw new Error('第 ' + (i + 1) + ' 格壓到分頁列了');
    }
  }

  return {
    size: { width, height },
    selected: config.open_by_default !== false, // 預設打開選單（LINE 官方預設也是開）
    name,
    chatBarText,
    areas: tabAreas.concat(areas)
  };
}

/**
 * 把前端送來的 config 洗成固定形狀再入庫。
 * 只留認識的欄位、限制長度與型別——jsonb 進了 DB 之後會被直接畫在後台頁面上，
 * 不洗乾淨等於讓任何員工帳號往管理頁塞任意 HTML。
 */
function sanitizeMenuConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  const cleanCells = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 20).map(x => ({
    x: num(x && x.x), y: num(x && x.y), w: num(x && x.w), h: num(x && x.h)
  }));
  const cells = cleanCells(c.cells);
  const cleanButtons = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 20).map(b => {
    b = (b && typeof b === 'object') ? b : {};
    const a = (b.action && typeof b.action === 'object') ? b.action : null;
    let action = null;
    if (a && a.type === 'uri') {
      action = { type: 'uri', uri: str(a.uri, 1000) };
      if (a.activity_id != null) action.activity_id = str(a.activity_id, 20);
    } else if (a && a.type === 'message') {
      action = { type: 'message', text: str(a.text, 300) };
    }
    const img = str(b.image, 500);
    return {
      label: str(b.label, 20), sublabel: str(b.sublabel, 30),
      icon: b.icon ? str(b.icon, 30) : null,
      bg: b.bg ? str(b.bg, 20) : null,
      image: (/^\/p\/line-media\/[0-9a-f-]+$/i.test(img) || /^https:\/\//.test(img)) ? img : null,
      action
    };
  });
  const buttons = cleanButtons(c.buttons);
  const tabs = Array.isArray(c.tabs)
    ? c.tabs.slice(0, 3).map(t => {
        t = (t && typeof t === 'object') ? t : {};
        const fimg = str(t.full_image_url, 500);
        return { label: str(t.label, 10), layout: str(t.layout, 30),
                 full_image_url: (/^\/p\/line-media\/[0-9a-f-]+$/i.test(fimg) || /^https:\/\//.test(fimg)) ? fimg : null,
                 cells: cleanCells(t.cells), buttons: cleanButtons(t.buttons) };
      })
    : null;
  return {
    size: c.size === 'compact' ? 'compact' : 'large',
    layout: str(c.layout, 30),
    bg: str(c.bg, 20) || '#FBC02D',
    cell_bg: str(c.cell_bg, 20) || '#FFF9E8',
    chat_bar_text: str(c.chat_bar_text, 14) || '選單',
    open_by_default: c.open_by_default !== false,
    full_image_url: (() => { const f = str(c.full_image_url, 500);
      return (/^\/p\/line-media\/[0-9a-f-]+$/i.test(f) || /^https:\/\//.test(f)) ? f : null; })(),
    cells, buttons,
    ...(tabs ? { tabs } : {})
  };
}

module.exports = { createLineRichMenuService, buildLineMenuObject, sanitizeMenuConfig, normalizeTabs, TAB_BAR_H };
