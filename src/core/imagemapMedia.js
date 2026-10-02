'use strict';
/**
 * LINE 滿版圖文訊息（imagemap）圖片處理
 *
 * LINE 的規定（官方 Messaging API reference「Imagemap message」）：
 *   - baseUrl 必須是 HTTPS（TLS 1.2+），LINE 會依裝置解析度去抓
 *     `${baseUrl}/1040`、`/700`、`/460`、`/300`、`/240`，網址「不能有副檔名」
 *   - 圖片 JPEG 或 PNG，單檔 10 MB 以內（LINE 的上限）
 *
 * 但本系統跑在 Netlify Functions：同步函式的請求／回應上限 6 MB，二進位會再經 Base64（約 +30%），
 * 實際可用約 4.5 MB。上傳（請求）與 LINE 抓圖（回應）都走函式，所以這裡把「上傳檔」與「產生的每一張」
 * 都限制在 4 MB，留安全餘裕；超過就明確擋下，不讓主機回不明錯誤。
 *   - baseSize.width 固定 1040；baseSize.height = 寬 1040 時的高度
 *
 * 所以後台只上傳一次原圖，這裡負責：
 *   1. 讀出尺寸、檢查比例（第一版建議 1040×1040；不是 1:1 只警告，不裁切、不變形）
 *   2. 依原比例產生五種寬度
 *   3. 存進既有的 line_push_media（不需要新資料表／migration），
 *      每種寬度的 id 由 assetId + 寬度「推導」出來（固定雜湊），
 *      所以 /p/line-imagemap/<assetId>/<寬度> 可以直接算出要讀哪一列。
 */

const crypto = require('crypto');

const IMAGEMAP_WIDTHS = [1040, 700, 460, 300, 240];
const BASE_WIDTH = 1040;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;          // Netlify 函式實際約 4.5 MB；LINE 本身允許 10 MB
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;          // 每一種寬度也要能被函式回應出去
const MAX_SOURCE_SIDE = 4096;                       // 避免超大圖把伺服器記憶體吃光
const MAX_BASE_HEIGHT = 2080;                       // 最長 1:2（直式），超過擋下
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAssetId(v) { return UUID_RE.test(String(v || '')); }

/** assetId + 寬度 → line_push_media 的 id（UUID 格式的固定雜湊） */
function deriveMediaId(assetId, width) {
  const h = crypto.createHash('sha256').update('line-imagemap:' + String(assetId).toLowerCase() + ':' + Number(width)).digest('hex');
  // 版本 5、RFC 4122 variant，確保是合法 UUID
  const v = h.slice(0, 12) + '5' + h.slice(13, 16) + ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 32);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

function imagemapBaseUrl(origin, assetId) {
  return String(origin || '').replace(/\/+$/, '') + '/p/line-imagemap/' + String(assetId);
}

/**
 * 處理上傳：回傳要存的五種尺寸與給後台看的資訊。
 * @returns {Promise<{ ok:boolean, error?:string, assetId?:string, baseWidth?:number, baseHeight?:number,
 *   sourceWidth?:number, sourceHeight?:number, warnings?:string[], files?:Array<{width,height,mime,buffer}> }>}
 */
async function processImagemapUpload(buffer, mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  if (mime !== 'image/png' && mime !== 'image/jpeg') return { ok: false, error: 'only_png_or_jpeg' };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: 'no_file' };
  if (buffer.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'file_too_large_max_4mb' };
  const { Jimp } = require('jimp');
  let img;
  try { img = await Jimp.read(buffer); } catch (e) { return { ok: false, error: 'image_unreadable' }; }
  const sw = img.bitmap.width;
  const sh = img.bitmap.height;
  if (!sw || !sh) return { ok: false, error: 'image_unreadable' };
  if (sw > MAX_SOURCE_SIDE || sh > MAX_SOURCE_SIDE) return { ok: false, error: 'image_too_large_pixels' };
  const baseHeight = Math.round(BASE_WIDTH * sh / sw);
  if (baseHeight > MAX_BASE_HEIGHT) return { ok: false, error: 'image_too_tall' };

  const warnings = [];
  if (sw !== sh) warnings.push(`圖片比例不是 1:1（目前 ${sw} × ${sh}）。已依原比例處理、沒有裁切；第一版建議用 1040 × 1040。`);
  if (sw < BASE_WIDTH) warnings.push(`圖片寬度只有 ${sw}px，小於建議的 1040px，在大螢幕手機上可能會模糊。`);
  else if (sw !== BASE_WIDTH) warnings.push(`圖片寬度 ${sw}px，已等比例縮放成 1040px 寬。`);

  const outMime = mime;   // PNG 保持 PNG（保留透明），JPEG 保持 JPEG
  const files = [];
  for (const w of IMAGEMAP_WIDTHS) {
    const h = Math.round(w * sh / sw);
    let body;
    if (w === sw && h === sh) {
      body = buffer;                                   // 原圖剛好就是這個寬度：原封不動，不重壓
    } else {
      const copy = img.clone();
      copy.resize({ w, h });
      body = await copy.getBuffer(outMime, outMime === 'image/jpeg' ? { quality: 88 } : undefined);
    }
    if (body.length > MAX_OUTPUT_BYTES) return { ok: false, error: 'resized_too_large' };
    files.push({ width: w, height: h, mime: outMime, buffer: body });
  }
  return {
    ok: true,
    assetId: crypto.randomUUID(),
    baseWidth: BASE_WIDTH,
    baseHeight,
    sourceWidth: sw,
    sourceHeight: sh,
    warnings,
    files
  };
}

async function storeImagemapFiles(query, assetId, files) {
  for (const f of files) {
    await query(
      `INSERT INTO line_push_media (id, mime_type, body) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [deriveMediaId(assetId, f.width), f.mime, f.buffer]
    );
  }
}

module.exports = {
  IMAGEMAP_WIDTHS,
  BASE_WIDTH,
  MAX_BASE_HEIGHT,
  MAX_UPLOAD_BYTES,
  MAX_OUTPUT_BYTES,
  isAssetId,
  deriveMediaId,
  imagemapBaseUrl,
  processImagemapUpload,
  storeImagemapFiles
};
