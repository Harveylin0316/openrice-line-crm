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

const { createLineRichMenuService, buildLineMenuObject, sanitizeMenuConfig, normalizeTabs } = require('../core/lineRichMenu');

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
        `SELECT id, name, config, line_rich_menu_id, line_rich_menu_ids, status, is_default,
                published_at, updated_at, audience_list_id, audience_applied_at, audience_applied_count,
                schedule_start_at, schedule_end_at, schedule_end_menu_id, schedule_state
           FROM rich_menus ORDER BY updated_at DESC LIMIT 100`);
      const { rows: lists } = await query(
        `SELECT id, name, total FROM admin_recipient_lists ORDER BY id DESC LIMIT 50`);

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
        ok: true, menus, orphans, lists, default_line_id: defaultId,
        default_owned_elsewhere: defaultOwnedElsewhere, line_error: lineError,
        liff_id: gamesLiffId(),
        activities: acts.map(a => {
          const lid = a.liff_id_override || gamesLiffId();
          return {
            id: a.id, slug: a.slug, name: a.name, game_type: a.game_type, status: a.status,
            // 沒設 LIFF ID 時寧可不給連結，也不要組出 liff.line.me//... 這種點了壞掉的網址
            liff_url: lid ? ('https://liff.line.me/' + lid + '/' + a.game_type + '/' + encodeURIComponent(a.slug)) : null
          };
        }),
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
      if (!body.config || typeof body.config !== 'object') return jsonErr(res, 400, 'bad_config');
      // 入庫前洗成固定形狀：這份 jsonb 之後會被直接畫在後台列表上，不能讓任意結構進來
      const config = sanitizeMenuConfig(body.config);
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

  const baseUrl = () => String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');

  /** 發布用：把每一格的「開啟網址」包成站內轉址（記一筆點擊再跳過去）。
   *  published_config 存的是原始網址，/r 轉址靠它查目的地——選單上的是追蹤網址。 */
  function withTrackingLinks(config, rowId) {
    const base = baseUrl();
    if (!base) return config; // 本機沒有站台網址就直接用原始連結
    const clone = JSON.parse(JSON.stringify(config));
    const tabs = Array.isArray(clone.tabs) && clone.tabs.length ? clone.tabs : null;
    const wrap = (buttons, tabIdx) => (buttons || []).forEach((b, ci) => {
      if (b && b.action && b.action.type === 'uri' && /^https:\/\//.test(String(b.action.uri || ''))) {
        b.action = { ...b.action, uri: base + '/r/' + rowId + '/' + tabIdx + '/' + ci };
      }
    });
    if (tabs) tabs.forEach((t, ti) => wrap(t.buttons, ti));
    else wrap(clone.buttons, 0);
    return clone;
  }

  app.post('/admin/richmenu/api/publish', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const id = Number(body.id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      const { rows } = await query(
        `SELECT id, name, config, line_rich_menu_id, line_rich_menu_ids, is_default, audience_list_id
           FROM rich_menus WHERE id=$1`, [id]);
      if (rows.length === 0) return jsonErr(res, 404, 'not_found');
      const row = rows[0];

      // 圖片：每個分頁一張（單頁選單就是一張），前端 canvas 畫好轉 dataURL 送上來
      const rawImages = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
      const buffers = [];
      for (const dataUrl of rawImages) {
        const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
        if (!m) return jsonErr(res, 400, 'bad_image', { detail: '圖片格式不對，重新整理後再試一次' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 1024 * 1024) {
          return jsonErr(res, 400, 'image_too_big', { detail: '圖片壓完還是超過 1MB，把格子裡的字減少一點再試' });
        }
        buffers.push({ buf, contentType: m[1] });
      }

      const cleanConfig = sanitizeMenuConfig(row.config);
      const tabs = normalizeTabs(cleanConfig);
      if (buffers.length !== tabs.length) {
        return jsonErr(res, 400, 'bad_image', { detail: '圖片數量跟分頁數對不上，重新整理後再試一次' });
      }
      // 別名 id 由選單編號決定，永遠不變——分頁切換靠它
      const aliasIds = tabs.map((_, t) => 'crm-r' + id + '-t' + t);
      const trackedConfig = withTrackingLinks(cleanConfig, id);

      const menuObjs = [];
      try {
        for (let t = 0; t < tabs.length; t++) {
          menuObjs.push(buildLineMenuObject({ ...trackedConfig, name: row.name }, { tabIndex: t, aliasIds, trackId: id }));
        }
      } catch (e) { return jsonErr(res, 400, 'invalid_menu', { detail: e.message }); }

      const oldIds = [];
      if (Array.isArray(row.line_rich_menu_ids)) row.line_rich_menu_ids.forEach(x => x && x.id && oldIds.push(x.id));
      else if (row.line_rich_menu_id) oldIds.push(row.line_rich_menu_id);

      let liveDefault = null;
      try { liveDefault = (await rm.getDefaultRichMenu()).id; } catch (e) { /* 查不到就當不是 */ }
      const replacingLive = oldIds.includes(liveDefault);
      const setDefault = body.set_default === true || replacingLive;

      // 1) 每個分頁：建選單＋傳圖（任一步失敗→把這次建的全部刪掉）
      const newIds = [];
      try {
        for (let t = 0; t < tabs.length; t++) {
          const nid = await rm.createRichMenu(menuObjs[t]);
          newIds.push(nid);
          await rm.uploadImage(nid, buffers[t].buf, buffers[t].contentType);
        }
      } catch (e) {
        for (const nid of newIds) await rm.deleteRichMenu(nid).catch(() => {});
        throw e;
      }

      // 2) 寫 DB（失敗→刪光這次建的，舊選單原封不動）
      const idsJson = newIds.map((nid, t) => ({ tab: t, id: nid, alias: tabs.length > 1 ? aliasIds[t] : null }));
      try {
        await query(
          `UPDATE rich_menus SET line_rich_menu_id=$2, line_rich_menu_ids=$3::jsonb,
                  published_config=$4::jsonb, status='published',
                  audience_applied_at = CASE WHEN audience_list_id IS NULL THEN audience_applied_at ELSE NULL END,
                  published_at=now(), updated_at=now() WHERE id=$1`,
          [id, newIds[0], JSON.stringify(idsJson), JSON.stringify(cleanConfig)]);
      } catch (e) {
        for (const nid of newIds) await rm.deleteRichMenu(nid).catch(() => {});
        return jsonErr(res, 500, 'db_failed', { detail: '選單沒有發布出去（後台紀錄寫入失敗），再試一次。' });
      }

      // 3) 分頁別名指到新選單（切換靠這個；失敗就先不刪舊的，讓人重試）
      if (tabs.length > 1) {
        try {
          for (let t = 0; t < tabs.length; t++) await rm.upsertAlias(aliasIds[t], newIds[t]);
        } catch (e) {
          return jsonErr(res, 500, 'alias_failed', {
            detail: '選單發布了，但分頁切換沒接好。再按一次發布就會修好。' });
        }
      }

      // 4) 設預設（失敗照實講：已發布成備用）
      if (setDefault) {
        try {
          await rm.setDefault(newIds[0]);
        } catch (e) {
          return jsonErr(res, 500, 'set_default_failed', {
            detail: '選單發布成功，但「換成所有人看到的」這一步失敗。回列表對它按「設為所有人看到的」再試一次。' });
        }
        await query(`UPDATE rich_menus SET is_default = (id = $1)`, [id]).catch(() => {});
      }

      // 5) 清掉舊版（絕不刪正在被所有人看到的，除非新的已接手）
      for (const oid of oldIds) {
        if (newIds.includes(oid)) continue;
        const oldStillLive = !setDefault && oid === liveDefault;
        if (!oldStillLive) await rm.deleteRichMenu(oid).catch(() => {});
      }

      res.json({ ok: true, line_rich_menu_id: newIds[0], tabs: tabs.length, is_default: setDefault,
                 audience_needs_reapply: !!row.audience_list_id });
    } catch (err) {
      console.error('richmenu publish error:', err && err.message);
      jsonErr(res, 500, 'publish_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });

  app.post('/admin/richmenu/api/set-default', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      let lineId = String(body.line_rich_menu_id || '').trim();
      const rowId = Number(body.id) || null;
      if (rowId) {
        const { rows } = await query(`SELECT line_rich_menu_id FROM rich_menus WHERE id=$1`, [rowId]);
        if (rows.length === 0) return jsonErr(res, 404, 'not_found');
        lineId = rows[0].line_rich_menu_id;   // 多分頁時這是分頁一；用戶切到別頁是他自己的狀態，預設一律回到分頁一
        if (!lineId) return jsonErr(res, 400, 'not_published', { detail: '這個選單還沒發布，先按發布' });
      }
      if (!lineId) return jsonErr(res, 400, 'bad_id');
      await rm.setDefault(lineId);
      // IS NOT DISTINCT FROM：草稿列的 line_rich_menu_id 是 NULL，
      // 用 = 比對會算出 NULL 塞進 NOT NULL 欄位，整句失敗（審查抓到的實錯）
      try {
        await query(`UPDATE rich_menus SET is_default = (line_rich_menu_id IS NOT DISTINCT FROM $1)`, [lineId]);
      } catch (e) {
        return jsonErr(res, 500, 'db_failed', {
          detail: '所有人看到的選單已經換好了，但後台紀錄沒跟上。重新整理頁面就會恢復正常。' });
      }
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

      // 不管頁面上顯示什麼，刪除前都跟 LINE 確認一次「這是不是所有人正在看的選單」。
      // 頁面資料可能過期（別的管理員剛切換過），靠前端判斷會出事。
      async function isLiveDefault(lid) {
        if (!lid) return false;
        try { return (await rm.getDefaultRichMenu()).id === lid; } catch (e) { return false; }
      }

      if (rowId) {
        const { rows } = await query(`SELECT line_rich_menu_id, line_rich_menu_ids, status FROM rich_menus WHERE id=$1`, [rowId]);
        if (rows.length === 0) return jsonErr(res, 404, 'not_found');
        const r = rows[0];
        const allIds = Array.isArray(r.line_rich_menu_ids) && r.line_rich_menu_ids.length
          ? r.line_rich_menu_ids.map(x => x && x.id).filter(Boolean)
          : (r.line_rich_menu_id ? [r.line_rich_menu_id] : []);
        for (const lid of allIds) {
          if (await isLiveDefault(lid)) {
            return jsonErr(res, 400, 'is_live', {
              detail: '這個選單正是所有人看到的，刪掉大家的選單會直接消失。先把別的選單設為所有人看到的，再回來刪。' });
          }
        }
        if (allIds.length) {
          // 已發布：要動 LINE 上的東西 → 升級成 owner 檢查；分頁別名一併清掉
          const aliases = Array.isArray(r.line_rich_menu_ids)
            ? r.line_rich_menu_ids.map(x => x && x.alias).filter(Boolean) : [];
          return requireOwner(req, res, async () => {
            try {
              for (const a of aliases) await rm.deleteAlias(a).catch(() => {});
              for (const lid of allIds) await rm.deleteRichMenu(lid);
              await query(`DELETE FROM rich_menus WHERE id=$1`, [rowId]);
              res.json({ ok: true });
            } catch (e) { jsonErr(res, 500, 'delete_failed', { detail: String(e.message || '').slice(0, 300) }); }
          });
        }
        await query(`DELETE FROM rich_menus WHERE id=$1`, [rowId]);
        return res.json({ ok: true });
      }

      if (orphanLineId) {
        if (await isLiveDefault(orphanLineId)) {
          return jsonErr(res, 400, 'is_live', {
            detail: '這個選單正是所有人看到的，刪掉大家的選單會直接消失。先把別的選單設為所有人看到的，再回來刪。' });
        }
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

  // ── 公開轉址：選單上的「開啟網址」按鍵都指到這裡，記一筆點擊再跳到真正的目的地 ──
  app.get('/r/:id(\\d+)/:tab(\\d+)/:cell(\\d+)', async (req, res) => {
    const FALLBACK = 'https://www.openrice.com';
    try {
      const id = Number(req.params.id), tab = Number(req.params.tab), cell = Number(req.params.cell);
      const { rows } = await query(`SELECT published_config FROM rich_menus WHERE id=$1`, [id]);
      const cfg = rows.length ? rows[0].published_config : null;
      let uri = null, label = null;
      if (cfg) {
        const tabs = normalizeTabs(cfg);
        const b = tabs[tab] && tabs[tab].buttons ? tabs[tab].buttons[cell] : null;
        if (b && b.action && b.action.type === 'uri' && /^https:\/\//.test(String(b.action.uri || ''))) {
          uri = b.action.uri; label = b.label || null;
        }
      }
      // 記錄失敗不能擋跳轉——用戶體驗優先
      await query(
        `INSERT INTO rich_menu_taps (menu_id, tab, cell, kind, label) VALUES ($1,$2,$3,'link',$4)`,
        [id, tab, cell, label]).catch(() => {});
      res.redirect(uri || FALLBACK);
    } catch (e) {
      res.redirect(FALLBACK);
    }
  });

  // ── 圖片上傳（每格的圖／整張完稿圖共用）：存進 line_push_media，回公開網址路徑 ──
  app.post('/admin/richmenu/api/upload-image', requireAdmin, async (req, res) => {
    try {
      const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ''));
      if (!m) return jsonErr(res, 400, 'bad_image', { detail: '只收 JPG 或 PNG 圖片' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 2 * 1024 * 1024) return jsonErr(res, 400, 'image_too_big', { detail: '圖片超過 2MB，壓小一點再傳' });
      const crypto = require('crypto');
      const newId = crypto.randomUUID();
      await query(`INSERT INTO line_push_media (id, mime_type, body) VALUES ($1, $2, $3)`, [newId, m[1], buf]);
      res.json({ ok: true, url: '/p/line-media/' + newId });
    } catch (err) {
      console.error('richmenu upload error:', err && err.message);
      jsonErr(res, 500, 'upload_failed', { detail: String(err && err.message || '').slice(0, 200) });
    }
  });

  // ── 上下架排程 ──────────────────────────────────────────────
  app.post('/admin/richmenu/api/schedule', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const id = Number(body.id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      const { rows } = await query(`SELECT line_rich_menu_id FROM rich_menus WHERE id=$1`, [id]);
      if (rows.length === 0) return jsonErr(res, 404, 'not_found');
      const startAt = body.start_at ? new Date(body.start_at) : null;
      const endAt = body.end_at ? new Date(body.end_at) : null;
      if ((startAt && isNaN(startAt)) || (endAt && isNaN(endAt))) return jsonErr(res, 400, 'bad_time', { detail: '時間格式不對' });
      if (startAt && endAt && endAt <= startAt) return jsonErr(res, 400, 'bad_time', { detail: '下架時間要在上架時間之後' });
      if ((startAt || endAt) && !rows[0].line_rich_menu_id) {
        return jsonErr(res, 400, 'not_published', { detail: '先發布這個選單，才能排上下架時間' });
      }
      let endMenuId = Number(body.end_menu_id) || null;
      if (endAt && endMenuId) {
        const { rows: em } = await query(`SELECT line_rich_menu_id FROM rich_menus WHERE id=$1`, [endMenuId]);
        if (!em.length || !em[0].line_rich_menu_id) {
          return jsonErr(res, 400, 'bad_end_menu', { detail: '下架後要顯示的選單還沒發布' });
        }
      }
      if (!endAt) endMenuId = null;
      const state = (!startAt && !endAt) ? null : (startAt && startAt > new Date() ? 'pending' : (endAt ? 'live' : null));
      await query(
        `UPDATE rich_menus SET schedule_start_at=$2, schedule_end_at=$3, schedule_end_menu_id=$4,
                schedule_state=$5, updated_at=now() WHERE id=$1`,
        [id, startAt, endAt, endMenuId, state]);
      res.json({ ok: true, state });
    } catch (err) {
      console.error('richmenu schedule error:', err && err.message);
      jsonErr(res, 500, 'schedule_failed', { detail: String(err && err.message || '').slice(0, 200) });
    }
  });

  // 排程執行（Netlify Scheduled Function 每 5 分鐘打一次；跟群發共用同一把 secret）
  app.post('/admin/richmenu/run-schedule', async (req, res) => {
    try {
      const secret = process.env.SCHEDULED_RUNNER_SECRET || '';
      if (!secret || req.get('X-Scheduler-Secret') !== secret) {
        return jsonErr(res, 403, 'forbidden');
      }
      const done = [];
      // 到點上架：設為所有人看到的
      const { rows: toStart } = await query(
        `SELECT id, name, line_rich_menu_id FROM rich_menus
          WHERE schedule_state='pending' AND schedule_start_at IS NOT NULL AND schedule_start_at <= now()
            AND line_rich_menu_id IS NOT NULL LIMIT 10`);
      for (const r of toStart) {
        try {
          await rm.setDefault(r.line_rich_menu_id);
          await query(`UPDATE rich_menus SET is_default = (id = $1) WHERE true`, [r.id]);
          await query(
            `UPDATE rich_menus SET schedule_state = CASE WHEN schedule_end_at IS NOT NULL THEN 'live' ELSE 'done' END,
                    updated_at=now() WHERE id=$1`, [r.id]);
          done.push({ id: r.id, action: 'start' });
        } catch (e) { console.error('richmenu schedule start failed:', r.id, e.message); }
      }
      // 到點下架：換成指定選單，或不顯示
      const { rows: toEnd } = await query(
        `SELECT id, name, schedule_end_menu_id FROM rich_menus
          WHERE schedule_state='live' AND schedule_end_at IS NOT NULL AND schedule_end_at <= now() LIMIT 10`);
      for (const r of toEnd) {
        try {
          if (r.schedule_end_menu_id) {
            const { rows: em } = await query(`SELECT line_rich_menu_id FROM rich_menus WHERE id=$1`, [r.schedule_end_menu_id]);
            if (em.length && em[0].line_rich_menu_id) {
              await rm.setDefault(em[0].line_rich_menu_id);
              await query(`UPDATE rich_menus SET is_default = (id = $1) WHERE true`, [r.schedule_end_menu_id]);
            }
          } else {
            await rm.clearDefault();
            await query(`UPDATE rich_menus SET is_default=false WHERE true`);
          }
          await query(`UPDATE rich_menus SET schedule_state='done', updated_at=now() WHERE id=$1`, [r.id]);
          done.push({ id: r.id, action: 'end' });
        } catch (e) { console.error('richmenu schedule end failed:', r.id, e.message); }
      }
      res.json({ ok: true, done });
    } catch (err) {
      console.error('richmenu run-schedule error:', err && err.message);
      jsonErr(res, 500, 'run_failed', { detail: String(err && err.message || '').slice(0, 200) });
    }
  });

  // ── 名單專屬選單（用名單庫當「用戶標籤」）────────────────────
  app.post('/admin/richmenu/api/audience', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const id = Number(body.id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      const { rows } = await query(
        `SELECT line_rich_menu_id, audience_list_id FROM rich_menus WHERE id=$1`, [id]);
      if (rows.length === 0) return jsonErr(res, 404, 'not_found');
      const row = rows[0];
      const listId = Number(body.list_id) || null;

      const memberUids = async (lid) => {
        const { rows: ms } = await query(
          `SELECT line_user_id FROM admin_recipient_list_members WHERE list_id=$1 LIMIT 20000`, [lid]);
        return ms.map(x => String(x.line_user_id || '').trim()).filter(u => /^U[0-9a-f]{32}$/i.test(u));
      };

      if (!listId) {
        // 取消名單專屬：把原名單成員解除綁定（回到所有人看到的）
        if (row.audience_list_id) {
          const uids = await memberUids(row.audience_list_id);
          if (uids.length) await rm.bulkUnlink(uids);
        }
        await query(`UPDATE rich_menus SET audience_list_id=NULL, audience_applied_at=NULL,
                     audience_applied_count=NULL, updated_at=now() WHERE id=$1`, [id]);
        return res.json({ ok: true, cleared: true });
      }

      if (!row.line_rich_menu_id) return jsonErr(res, 400, 'not_published', { detail: '先發布這個選單，才能指定名單' });
      const uids = await memberUids(listId);
      if (!uids.length) return jsonErr(res, 400, 'empty_list', { detail: '這份名單沒有可用的成員' });
      // 換名單時，先把舊名單裡「不在新名單」的人解除
      if (row.audience_list_id && row.audience_list_id !== listId) {
        const oldUids = await memberUids(row.audience_list_id);
        const keep = new Set(uids);
        const drop = oldUids.filter(u => !keep.has(u));
        if (drop.length) await rm.bulkUnlink(drop);
      }
      await rm.bulkLink(row.line_rich_menu_id, uids);
      await query(`UPDATE rich_menus SET audience_list_id=$2, audience_applied_at=now(),
                   audience_applied_count=$3, updated_at=now() WHERE id=$1`, [id, listId, uids.length]);
      res.json({ ok: true, applied: uids.length });
    } catch (err) {
      console.error('richmenu audience error:', err && err.message);
      jsonErr(res, 500, 'audience_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });

  // ── 傳到測試手機：發布前只給測試人員看（清單跟群發共用）──────
  //    掛的是「個人專屬選單」，其他用戶完全不受影響；結束預覽就解除、回到原本的選單。
  app.post('/admin/richmenu/api/preview', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const id = Number(body.id);
      const stop = body.stop === true;
      const { rows: testers } = await query(
        `SELECT label, line_user_id FROM admin_test_recipients ORDER BY id ASC`);
      const uids = testers.map(t => String(t.line_user_id || '').trim())
        .filter(u => /^U[0-9a-f]{32}$/i.test(u));
      if (!uids.length) {
        return jsonErr(res, 400, 'no_testers', {
          detail: '測試人員清單是空的。到「群發訊息」頁面把自己加進測試人員，回來再按。' });
      }
      if (stop) {
        await rm.bulkUnlink(uids);
        return res.json({ ok: true, stopped: true, count: uids.length });
      }
      if (!id) return jsonErr(res, 400, 'bad_id');
      const { rows } = await query(`SELECT line_rich_menu_id FROM rich_menus WHERE id=$1`, [id]);
      if (rows.length === 0) return jsonErr(res, 404, 'not_found');
      if (!rows[0].line_rich_menu_id) {
        return jsonErr(res, 400, 'not_published', { detail: '先發布（可以不設為所有人看到的），才能傳到測試手機。' });
      }
      await rm.bulkLink(rows[0].line_rich_menu_id, uids);
      res.json({ ok: true, count: uids.length,
                 names: testers.map(t => t.label).filter(Boolean).slice(0, 10) });
    } catch (err) {
      console.error('richmenu preview error:', err && err.message);
      jsonErr(res, 500, 'preview_failed', { detail: String(err && err.message || '').slice(0, 300) });
    }
  });

  // ── 成效：每一格被按幾次 ─────────────────────────────────────
  app.get('/admin/richmenu/api/stats', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.query.id);
      if (!id) return jsonErr(res, 400, 'bad_id');
      const { rows } = await query(
        `SELECT tab, cell, kind, label,
                COUNT(*)::int AS taps,
                COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS taps_7d,
                COUNT(DISTINCT line_user_id) FILTER (WHERE line_user_id IS NOT NULL)::int AS people
           FROM rich_menu_taps WHERE menu_id=$1
          GROUP BY tab, cell, kind, label
          ORDER BY tab, cell NULLS LAST`, [id]);
      res.json({ ok: true, stats: rows });
    } catch (err) {
      console.error('richmenu stats error:', err && err.message);
      jsonErr(res, 500, 'stats_failed', { detail: String(err && err.message || '').slice(0, 200) });
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
