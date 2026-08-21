/**
 * 圖文選單後台 —— 目標是比 LINE 官方後台好用：
 *   1. 選範本、改字、就能發布（選單圖由編輯器直接畫好上傳，不用自己開 Photoshop）
 *   2. 按鍵動作跟站內活動打通（選活動就自動帶 LIFF 連結；發送文字會觸發活動卡片）
 *   3. 發布前後台都看得到現在「所有人實際看到的是哪一個」
 *
 * 路由：
 *   GET  /admin/richmenu                    編輯器頁面
 *   GET  /admin/richmenu/api/data           我們存的選單 + LINE 上的選單 + 目前預設
 *   POST /admin/richmenu/api/save           存草稿（config 是編輯器的 JSON）
 *   POST /admin/richmenu/api/publish        發布：建選單 → 傳圖 →（可選）設為預設；舊版清掉
 *   POST /admin/richmenu/api/set-default    把某個選單設成所有人看到的
 *   POST /admin/richmenu/api/clear-default  讓所有人都不顯示選單
 *   POST /admin/richmenu/api/delete         刪草稿（已發布的會連 LINE 上的一起刪 → requireOwner）
 *   GET  /admin/richmenu/api/line-image     取 LINE 上選單的圖（base64，給列表預覽用）
 */

const { createLineRichMenuService, buildLineMenuObject } = require('../core/lineRichMenu');

function registerAdminRichMenuRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin, requireOwner } = authCore;
  const rm = createLineRichMenuService({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
  });
  const jsonErr = (res, s, e, extra = {}) => res.status(s).json({ ok: false, error: e, ...extra });

  const gamesLiffId = () =>
    process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';

  app.get('/admin/richmenu', requireAdmin, (req, res) => {
    res.render('admin_richmenu', {
      title: '圖文選單',
      bodyClass: 'admin-shell richmenu-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/richmenu/api/data', requireAdmin, async (_req, res) => {
    try {
      const { rows: menus } = await query(
        `SELECT id, name, config, line_rich_menu_id, status, is_default, published_at, updated_at
           FROM rich_menus ORDER BY updated_at DESC LIMIT 100`);

      // LINE 那邊的實況（token 沒設或網路掛掉時，後台仍要能編草稿）；
      // 兩支分開容錯，一支掛不要拖垮另一支
      let lineMenus = [], defaultId = null, defaultOwnedElsewhere = false, lineError = null;
      try { lineMenus = await rm.listRichMenus(); }
      catch (e) { lineError = String(e.message || e).slice(0, 200); }
      try {
        const d = await rm.getDefaultRichMenu();
        defaultId = d.id; defaultOwnedElsewhere = d.owned_elsewhere;
      } catch (e) { if (!lineError) lineError = String(e.message || e).slice(0, 200); }
      const ours = new Set(menus.map(m => m.line_rich_menu_id).filter(Boolean));
      const orphans = lineMenus
        .filter(l => !ours.has(l.richMenuId))
        .map(l => ({ richMenuId: l.richMenuId, name: l.name, chatBarText: l.chatBarText,
                     size: l.size, areas: (l.areas || []).length }));

      // 快速綁定用：進行中的活動（選了就自動帶 LIFF 連結／活動名稱關鍵字）
      const { rows: acts } = await query(
        `SELECT id, slug, name, game_type, status, liff_id_override
           FROM activities WHERE status IN ('active','draft') AND game_type <> 'mgm'
           ORDER BY status = 'active' DESC, id DESC LIMIT 30`);

      res.json({
        ok: true, menus, orphans, default_line_id: defaultId,
        default_owned_elsewhere: defaultOwnedElsewhere, line_error: lineError,
        liff_id: gamesLiffId(),
        activities: acts.map(a => ({
          id: a.id, slug: a.slug, name: a.name, game_type: a.game_type, status: a.status,
          liff_url: 'https://liff.line.me/' + (a.liff_id_override || gamesLiffId()) + '/' +
                    a.game_type + '/' + encodeURIComponent(a.slug)
        })),
        wallet_url: gamesLiffId() ? ('https://liff.line.me/' + gamesLiffId() + '/wallet') : ''
      });
    } catch (err) {
      console.error('richmenu data error:', err && err.message);
      jsonErr(res, 500, 'data_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/richmenu/api/save', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) return jsonErr(res, 400, 'name_required', { detail: '先幫選單取個名字' });
      const config = body.config;
      if (!config || typeof config !== 'object') return jsonErr(res, 400, 'bad_config');
      // 存之前先驗一次，讓錯誤在「儲存」就被講出來，不要等到發布才爆
      try { buildLineMenuObject({ ...config, name }); }
      catch (e) { /* 草稿允許沒填完 —— 只在發布時強制 */ }
      const by = (req.authUser && req.authUser.un) || 'admin';
      const id = Number(body.id) || null;
      if (id) {
        const upd = await query(
          `UPDATE rich_menus SET name=$2, config=$3::jsonb, updated_at=now()
            WHERE id=$1 RETURNING id`,
          [id, name, JSON.stringify(config)]);
        if (upd.rows.length === 0) return jsonErr(res, 404, 'not_found');
        return res.json({ ok: true, id });
      }
      const ins = await query(
        `INSERT INTO rich_menus (name, config, created_by) VALUES ($1, $2::jsonb, $3) RETURNING id`,
        [name, JSON.stringify(config), by]);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (err) {
      console.error('richmenu save error:', err && err.message);
      jsonErr(res, 500, 'save_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/richmenu/api/publish', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const id = Number(body.id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      const { rows } = await query(`SELECT id, name, config, line_rich_menu_id, is_default FROM rich_menus WHERE id=$1`, [id]);
      if (rows.length === 0) return jsonErr(res, 404, 'not_found');
      const row = rows[0];

      // 圖片：前端 canvas 畫好轉成 dataURL 送上來
      const dataUrl = String(body.image || '');
      const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) return jsonErr(res, 400, 'bad_image', { detail: '圖片格式不對，重新整理後再試一次' });
      const contentType = m[1];
      const buffer = Buffer.from(m[2], 'base64');
      if (buffer.length > 1024 * 1024) {
        return jsonErr(res, 400, 'image_too_big', { detail: '圖片壓完還是超過 1MB，把格子裡的字減少一點再試' });
      }

      let menuObj;
      try { menuObj = buildLineMenuObject({ ...row.config, name: row.name }); }
      catch (e) { return jsonErr(res, 400, 'invalid_menu', { detail: e.message }); }

      const setDefault = body.set_default === true || row.is_default === true;
      const oldLineId = row.line_rich_menu_id;

      // 1) 建新選單 → 2) 傳圖（失敗就把剛建的刪掉，LINE 上不留半成品）
      const newId = await rm.createRichMenu(menuObj);
      try {
        await rm.uploadImage(newId, buffer, contentType);
      } catch (e) {
        await rm.deleteRichMenu(newId).catch(() => {});
        throw e;
      }
      // 3) 要當預設就先切過去，再刪舊的（順序不能反，反了用戶會有幾秒沒選單）
      if (setDefault) await rm.setDefault(newId);
      if (oldLineId && oldLineId !== newId) await rm.deleteRichMenu(oldLineId).catch(() => {});

      if (setDefault) await query(`UPDATE rich_menus SET is_default=false WHERE id<>$1`, [id]);
      await query(
        `UPDATE rich_menus SET line_rich_menu_id=$2, status='published', is_default=$3,
                published_at=now(), updated_at=now() WHERE id=$1`,
        [id, newId, setDefault]);

      res.json({ ok: true, line_rich_menu_id: newId, is_default: setDefault });
    } catch (err) {
      console.error('richmenu publish error:', err && err.message);
      jsonErr(res, 500, 'publish_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });

  app.post('/admin/richmenu/api/set-default', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      let lineId = String(body.line_rich_menu_id || '').trim();
      let rowId = Number(body.id) || null;
      if (rowId) {
        const { rows } = await query(`SELECT line_rich_menu_id FROM rich_menus WHERE id=$1`, [rowId]);
        if (rows.length === 0) return jsonErr(res, 404, 'not_found');
        lineId = rows[0].line_rich_menu_id;
        if (!lineId) return jsonErr(res, 400, 'not_published', { detail: '這個選單還沒發布，先按發布' });
      }
      if (!lineId) return jsonErr(res, 400, 'bad_id');
      await rm.setDefault(lineId);
      await query(`UPDATE rich_menus SET is_default = (line_rich_menu_id = $1)`, [lineId]);
      res.json({ ok: true });
    } catch (err) {
      console.error('richmenu set-default error:', err && err.message);
      jsonErr(res, 500, 'set_default_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });

  app.post('/admin/richmenu/api/clear-default', requireOwner, async (_req, res) => {
    try {
      await rm.clearDefault();
      await query(`UPDATE rich_menus SET is_default=false`);
      res.json({ ok: true });
    } catch (err) {
      console.error('richmenu clear-default error:', err && err.message);
      jsonErr(res, 500, 'clear_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });

  // 刪除：草稿直接刪；已發布（或 LINE 上的孤兒選單）會動到所有用戶 → 老闆帳號才行
  app.post('/admin/richmenu/api/delete', requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const rowId = Number(body.id) || null;
      const orphanLineId = String(body.line_rich_menu_id || '').trim();

      if (rowId) {
        const { rows } = await query(`SELECT line_rich_menu_id, status FROM rich_menus WHERE id=$1`, [rowId]);
        if (rows.length === 0) return jsonErr(res, 404, 'not_found');
        const r = rows[0];
        if (r.line_rich_menu_id) {
          // 已發布：要動 LINE 上的東西 → 升級成 owner 檢查
          return requireOwner(req, res, async () => {
            try {
              await rm.deleteRichMenu(r.line_rich_menu_id);
              await query(`DELETE FROM rich_menus WHERE id=$1`, [rowId]);
              res.json({ ok: true });
            } catch (e) { jsonErr(res, 500, 'delete_failed', { detail: String(e.message || '').slice(0, 300) }); }
          });
        }
        await query(`DELETE FROM rich_menus WHERE id=$1`, [rowId]);
        return res.json({ ok: true });
      }

      if (orphanLineId) {
        return requireOwner(req, res, async () => {
          try {
            await rm.deleteRichMenu(orphanLineId);
            res.json({ ok: true });
          } catch (e) { jsonErr(res, 500, 'delete_failed', { detail: String(e.message || '').slice(0, 300) }); }
        });
      }
      jsonErr(res, 400, 'bad_id');
    } catch (err) {
      console.error('richmenu delete error:', err && err.message);
      jsonErr(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // LINE 上選單的圖 → base64 JSON（走 JSON 避免 serverless 二進位回應的坑；圖最大 1MB 沒問題）
  app.get('/admin/richmenu/api/line-image', requireAdmin, async (req, res) => {
    try {
      const rid = String(req.query.rid || '').trim();
      if (!/^richmenu-[0-9a-f]+$/i.test(rid)) return jsonErr(res, 400, 'bad_id');
      const { buffer, contentType } = await rm.downloadImage(rid);
      res.json({ ok: true, data_url: 'data:' + contentType + ';base64,' + buffer.toString('base64') });
    } catch (err) {
      if (err.status === 404) return jsonErr(res, 404, 'no_image');
      console.error('richmenu image error:', err && err.message);
      jsonErr(res, 500, 'image_failed', { detail: String(err && err.message || '').slice(0, 200) });
    }
  });
}

module.exports = { registerAdminRichMenuRoutes };
