/**
 * 台灣手機號碼正規化 — webhook 的自助登記與後台的出席名單比對共用。
 * 兩邊必須用同一套規則，否則使用者登記「0912-345-678」、
 * 出席名單匯出「886912345678」，十月比對就會漏人。
 *
 * 吃 0912-345-678 / +886912345678 / 886912345678 / 全形數字 / 夾空白與括號，
 * 輸出 09xxxxxxxx；不合格回 null。
 */
function normalizeTwMobile(text) {
  let t = String(text || '').trim();
  // 全形數字轉半形
  t = t.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 分隔符含全形連字號與各種破折號——打全形數字的人，符號通常也是全形
  t = t.replace(/[\s\-－–—()（）.]/g, '');
  if (/^\+?886/.test(t)) t = '0' + t.replace(/^\+?886/, '');
  return /^09\d{8}$/.test(t) ? t : null;
}

/** 手機遮罩：0912***678，回覆訊息與後台列表用 */
function maskTwMobile(phone) {
  const p = String(phone || '');
  return p.length === 10 ? p.slice(0, 4) + '***' + p.slice(-3) : p;
}

module.exports = { normalizeTwMobile, maskTwMobile };
