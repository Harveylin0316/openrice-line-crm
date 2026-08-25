/**
 * 後台權限的即時檢查（liveness）。獨立成模組，測試才測得到「正本」——
 * 原本這段直接寫在 app.js 裡，測試只能抄一份副本來測，改壞了照樣全綠。
 */
function createAdminLiveness({ query, authCore }) {
  // /admin 即時權限檢查（liveness）：授權原本只讀 7 天 JWT，登入後不再看 DB，
  // 導致「停用/降級」要等到 token 過期才生效、甚至被降級者能自我復權。
  // 這裡在每個 /admin request 讀一次 DB 現況：帳號不存在/非後台帳號/已停用/session 版本過舊 → 視為登出；
  // 否則用 DB 的即時 role/is_admin 覆寫 req.authUser，讓停用與降級「立即生效」。
  //
  // 【資料庫查不到時怎麼辦】原本是「一律放行」——代價是被停權的人在資料庫抖動期間
  // 照樣能操作後台。改成分層處理，兼顧安全與可用性：
  //   1. 先重試一次（大多數抖動是幾百毫秒的事）
  //   2. 還是失敗 → 用剛才驗過的結果（60 秒內驗證成功過的才算數）
  //   3. 連快取都沒有 → 看是不是會改到東西：
  //        看頁面／讀資料（GET）放行，但頁面上標記「暫時看不到最新權限」
  //        會寫入的動作（POST 等）一律擋下來，回一句人看得懂的話
  // 這樣短暫抖動完全無感，真的連不上資料庫時也不會讓沒權限的人改到東西。
  const LIVENESS_TTL_MS = 60 * 1000;
  const livenessCache = new Map();   // uid → { at, role, se }
  return async function adminLiveness(req, res, next) {
    const au = req.authUser;
    // 注意：Express 預設路由大小寫不敏感（/ADMIN/... 也會命中 /admin 路由），
    // 所以這裡的前綴判斷也必須 toLowerCase，否則大寫路徑會繞過 liveness 檢查。
    const isAdminPath = String(req.path || '').toLowerCase().startsWith('/admin');
    if (au && au.uid && isAdminPath) {
      const tokenSe = Number(au.se) || 0;
      let row = null, dbFailed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await query('SELECT is_admin, role, is_active, sess_epoch FROM users WHERE id = $1', [au.uid]);
          row = r.rows[0] || null;
          dbFailed = false;
          break;
        } catch (e) {
          dbFailed = true;
          if (attempt === 0) { await new Promise(r2 => setTimeout(r2, 300)); continue; }
          console.warn('admin liveness check failed:', e && e.message);
        }
      }

      if (!dbFailed) {
        if (!row || row.is_admin !== true || row.is_active === false || (Number(row.sess_epoch) || 0) !== tokenSe) {
          authCore.clearAuthCookie(res);
          req.authUser = null;
          livenessCache.delete(au.uid);
        } else {
          req.authUser.adm = true;
          req.authUser.role = row.role || 'admin';
          livenessCache.set(au.uid, { at: Date.now(), role: row.role || 'admin', se: tokenSe });
          if (livenessCache.size > 500) {
            const now = Date.now();
            for (const [k, v] of livenessCache) { if (now - v.at > LIVENESS_TTL_MS) livenessCache.delete(k); }
          }
        }
      } else {
        const cached = livenessCache.get(au.uid);
        const fresh = cached && (Date.now() - cached.at) <= LIVENESS_TTL_MS && cached.se === tokenSe;
        if (fresh) {
          req.authUser.adm = true;
          req.authUser.role = cached.role;
        } else {
          // 沒有近期驗證紀錄，又問不到資料庫：只讓「看」的動作過，別讓「改」的動作過。
          //
          // 【絕對不要在這裡清登入】這條路的前提是「我們問不到資料庫」，不是「這個人無效」。
          // 清了等於把正在工作的人踢出去——而且登入本身也要查資料庫，他連重登都做不到。
          // 真的無效的人，資料庫恢復後下一個請求就會走上面那條被清掉，不差這一次。
          const readOnly = req.method === 'GET' || req.method === 'HEAD';
          if (!readOnly) {
            res.set('Retry-After', '10');
            // 傳統表單送出的頁面收到 JSON 會整頁變成一串程式碼——依請求型態分流
            const wantsJson = req.xhr ||
              /json/i.test(String(req.get('accept') || '')) ||
              /json/i.test(String(req.get('content-type') || '')) ||
              String(req.path || '').includes('/api/');
            if (wantsJson) {
              return res.status(503).json({
                ok: false, error: 'auth_unavailable',
                detail: '系統忙線中，剛才的操作沒有執行。等十秒再按一次，不用重新登入。'
              });
            }
            return res.status(503).type('html').send(
              '<!doctype html><meta charset="utf-8"><title>系統忙線中</title>' +
              '<div style="max-width:520px;margin:80px auto;padding:0 20px;' +
              'font-family:-apple-system,\'PingFang TC\',sans-serif;line-height:1.9;color:#1D1D1F;">' +
              '<h1 style="font-size:20px;margin:0 0 12px;">系統忙線中，剛才的操作沒有執行</h1>' +
              '<p style="color:#6B6B70;font-size:14px;margin:0 0 20px;">' +
              '等十秒再送一次就好，<b>不用重新登入</b>。</p>' +
              '<a href="javascript:history.back()" style="display:inline-block;padding:10px 18px;' +
              'background:#1D1D1F;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;">回上一頁</a>' +
              '</div>');
          }
          res.locals.authDegraded = true;   // 版面可據此提示「暫時看不到最新權限」
          // 降級期間不能沿用 token 裡的舊角色：被降級的人會拿著舊身分逛管理員頁面。
          // 保守起見降到最低權限（一般後台人員），要動帳號設定的頁面自然會擋。
          req.authUser.role = 'staff';
        }
      }
    }
    const cur = req.authUser;
    res.locals.currentRole = cur ? (cur.role || (cur.adm ? 'admin' : null)) : null;
    res.locals.currentUid = cur ? cur.uid : null;
    next();
  };
}

module.exports = { createAdminLiveness };
