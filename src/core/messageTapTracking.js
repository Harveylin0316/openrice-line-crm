/**
 * 訊息裡「開啟網址」按鈕的記名追蹤。
 *
 * 為什麼要這樣做：LINE 訊息的按鈕點下去直接開網址，伺服器收不到任何 LINE 身分，
 * 所以永遠不知道是誰按的。改成先過一個 LIFF 跳板（拿身分 → 記一筆 → 跳走），
 * 才能把「按過這顆按鈕的人」變成一包名單。
 *
 * 兩種訊息形狀都要吃得下：
 *   - 模板模式（mode='template'）：按鈕就是 template.ctaUrl
 *   - 自訂訊息（mode='flex_json'）：按鈕散落在 Flex JSON 裡的 action
 *
 * 按鈕編號 = 走訪順序（0, 1, 2…），前後端用同一套走訪才對得起來。
 */

/** 目的地已經是自家 LIFF 的按鈕不包跳板：那種頁面本來就認得出是誰，包了只是多一層等待 */
function isOwnLiff(uri) {
  return /^https:\/\/liff\.line\.me\//i.test(String(uri || ''));
}

function isTrackableUri(uri) {
  const u = String(uri || '');
  return /^https?:\/\//i.test(u) && !isOwnLiff(u);
}

/**
 * 走訪訊息設定，對每一顆「開啟網址」的按鈕呼叫 visit(node, index)。
 * visit 回傳字串就把該顆的網址換掉（用來包成跳板）。
 * 回傳找到的按鈕清單 [{ index, uri, label }]。
 */
function walkUriActions(config, visit) {
  const found = [];
  let index = 0;
  const consider = (holder, label) => {
    const a = holder && holder.action;
    if (!a || a.type !== 'uri' || !a.uri) return;
    const uri = String(a.uri);
    if (!isTrackableUri(uri)) return;          // 自家 LIFF 或非 http 一律跳過
    const item = { index, uri, label: a.label || label || null };
    found.push(item);
    if (typeof visit === 'function') {
      const replaced = visit(item);
      if (typeof replaced === 'string' && replaced) a.uri = replaced;
    }
    index += 1;
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    // 節點自己帶 action（button / box / image 都可能帶）
    consider(node, node.text || null);
    for (const k of Object.keys(node)) {
      if (k === 'action') continue;            // action 內部不用再往下走
      walk(node[k]);
    }
  };
  if (!config || typeof config !== 'object') return found;
  if (config.mode === 'template' && config.template) {
    // 模板模式：ctaUrl 就是唯一那顆
    const t = config.template;
    if (isTrackableUri(t.ctaUrl)) {
      const item = { index, uri: String(t.ctaUrl), label: t.ctaLabel || null };
      found.push(item);
      if (typeof visit === 'function') {
        const replaced = visit(item);
        if (typeof replaced === 'string' && replaced) t.ctaUrl = replaced;
      }
      index += 1;
    }
    return found;
  }
  walk(config.flex || config.contents || config);
  return found;
}

/** 只是列出有哪些按鈕（後台挑選器用），不動原本的設定 */
function listUriButtons(config) {
  return walkUriActions(JSON.parse(JSON.stringify(config || {})));
}

/**
 * 回傳「按鈕已包成跳板」的新設定（原設定不動）。
 * 沒有 liffId 就原樣返回——記不到人也不能把訊息弄壞。
 */
function withMessageTracking(config, { source, refId, liffId }) {
  if (!config || !liffId) return config;
  let clone;
  try { clone = JSON.parse(JSON.stringify(config)); }
  catch (e) { return config; }
  walkUriActions(clone, (item) =>
    'https://liff.line.me/' + liffId + '/t/m/' + source + '/' + refId + '_' + item.index);
  return clone;
}

/** 反查第 n 顆按鈕的真正目的地（跳板要用；一律回頭查設定，不從網址帶） */
function findUriButton(config, index) {
  const list = listUriButtons(config);
  const n = Number(index);
  return list.find(b => b.index === n) || null;
}

module.exports = { walkUriActions, listUriButtons, withMessageTracking, findUriButton, isTrackableUri, isOwnLiff };
