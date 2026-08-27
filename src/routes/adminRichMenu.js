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
const { findUriButton, listUriButtons, isOwnLiff } = require('../core/messageTapTracking');

function registerAdminRichMenuRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin, requireOwner } = authCore;
  const rm = createLineRichMenuService({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
  });
  const jsonErr = (res, s, e, extra = {}) => res.status(s).json({ ok: false, error: e, ...extra });

  const gamesLiffId = () =>
    process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';

  /** 這份程式是哪一版（建置時寫進 build-info.json；本機沒有就顯示「本機」） */
  let _build = null;
  const buildId = () => {
    if (_build !== null) return _build;
    try { _build = (require('../build-info.json').build || '').slice(0, 7) || '本機'; }
    catch (e) { _build = String(process.env.COMMIT_REF || '').slice(0, 7) || '本機'; }
    return _build;
  };

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
        wallet_url: gamesLiffId() ? ('https://liff.line.me/' + gamesLiffId() + '/wallet') : '',
        // 版本代號：出問題時第一個要問的是「你手上這頁是哪一版」，讓它直接看得到。
        // COMMIT_REF 只有建置階段讀得到，所以建置時寫進檔案，這裡再讀出來。
        build: buildId()
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
  function withTrackingLinks(config, rowId, ownIds) {
    const base = baseUrl();
    if (!base) return config; // 本機沒有站台網址就直接用原始連結
    const liff = gamesLiffId();
    const clone = JSON.parse(JSON.stringify(config));
    const tabs = Array.isArray(clone.tabs) && clone.tabs.length ? clone.tabs : null;
    const wrap = (buttons, tabIdx) => (buttons || []).forEach((b, ci) => {
      if (b && b.action && b.action.type === 'uri' && /^https:\/\//.test(String(b.action.uri || ''))) {
        // 指向自家活動頁的按鍵不走「記名跳板」：那些頁面本身就認得出是誰
        // （活動頁自己有紀錄），多包一層 LIFF 跳板只是多等一秒還可能影響開啟。
        // 但一般轉址（只算次數）要保留——不然最常見的活動按鍵會整列從成效表消失。
        const own = isOwnLiff(b.action.uri, ownIds);
        // 勾了「記錄是誰點的」→ 走 LIFF 跳板（拿得到身分，可以貼標籤）；
        // 沒勾就走一般轉址（只算次數，但快）。沒設 LIFF ID 時只能走一般轉址。
        const named = b.identify === true && !!liff && !own;
        b.action = { ...b.action, uri: named
          ? ('https://liff.line.me/' + liff + '/t/' + rowId + '/' + tabIdx + '/' + ci)
          : (base + '/r/' + rowId + '/' + tabIdx + '/' + ci) };
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
        `SELECT id, name, config, line_rich_menu_id, line_rich_menu_ids, is_default, audience_list_id,
                published_config, status, published_at, audience_applied_at
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
      // 活動可以各自指定 LIFF 編號，那些也算「自家活動頁」
      let ownLiffExtra = [];
      try {
        const { rows: la } = await query(
          `SELECT DISTINCT liff_id_override FROM activities WHERE liff_id_override IS NOT NULL`);
        ownLiffExtra = la.map(x => x.liff_id_override).filter(Boolean);
      } catch (e) { /* 查不到就只用預設編號，不影響發布 */ }
      const trackedConfig = withTrackingLinks(cleanConfig, id, ownLiffExtra);

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

      // 3) 分頁別名指到新選單（切換靠這個）。失敗＝全數退回：
      //    刪掉這次建的、DB 復原舊版、別名指回舊選單——用戶看到的完全不變。
      //    不能停在「DB 指新版、別名指舊版」的半套狀態：那時候按重試或清理，
      //    會把正在被所有人看到的舊版誤刪，全體用戶的分頁直接斷掉。
      if (tabs.length > 1) {
        try {
          for (let t = 0; t < tabs.length; t++) await rm.upsertAlias(aliasIds[t], newIds[t]);
        } catch (e) {
          for (const nid of newIds) await rm.deleteRichMenu(nid).catch(() => {});
          if (Array.isArray(row.line_rich_menu_ids)) {
            for (const x of row.line_rich_menu_ids) {
              if (x && x.alias && x.id) await rm.upsertAlias(x.alias, x.id).catch(() => {});
            }
          }
          await query(
            `UPDATE rich_menus SET line_rich_menu_id=$2, line_rich_menu_ids=$3::jsonb,
                    published_config=$4::jsonb, status=$5, published_at=$6, audience_applied_at=$7,
                    updated_at=now() WHERE id=$1`,
            [id, row.line_rich_menu_id, JSON.stringify(row.line_rich_menu_ids),
             JSON.stringify(row.published_config), row.status, row.published_at, row.audience_applied_at]
          ).catch(() => {});
          return jsonErr(res, 500, 'alias_failed', {
            detail: '分頁切換沒接好，這次發布已整批退回，大家看到的還是原本的選單。再按一次發布重試。' });
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
        // 手動換選單＝接管：別的選單殘留的「已上架、等下架」排程從此失效，
        // 不然那個排程到點會把現在手動設好的選單收掉
        await query(`UPDATE rich_menus SET schedule_state='done', updated_at=now()
                      WHERE schedule_state='live' AND line_rich_menu_id IS DISTINCT FROM $1`, [lineId]);
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

  // 讓所有人都看不到選單。實測確認：這會把「目前生效的預設選單」整個取消，
  // 不管那是 CRM 設的還是 LINE 官方後台設的長青選單——而且官方後台那個不會自動回來，
  // 要有人進官方後台重新啟用。所以是老闆帳號限定，而且要明講「我知道」。
  app.post('/admin/richmenu/api/clear-default', requireOwner, async (req, res) => {
    try {
      if ((req.body || {}).confirm !== true) {
        return jsonErr(res, 400, 'need_confirm', {
          detail: '這會讓全體用戶的圖文選單消失，包含你在 LINE 官方後台設的長青選單，而且不會自動回來。確定的話再按一次。' });
      }
      await rm.clearDefault();
      await query(`UPDATE rich_menus SET is_default=false`);
      // 手動收掉選單＝接管：殘留的「已上架、等下架」排程一併失效
      await query(`UPDATE rich_menus SET schedule_state='done', updated_at=now()
                    WHERE schedule_state='live'`);
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
        const { rows } = await query(
          `SELECT line_rich_menu_id, line_rich_menu_ids, status,
                  audience_list_id, audience_applied_at, audience_applied_count
             FROM rich_menus WHERE id=$1`, [rowId]);
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
        // 名單專屬還掛在人身上：不能不聲不響就刪——那些人的專屬選單會無預警消失。
        // 前端拿到這個錯誤會照實再問一次，確認才帶 confirm_audience 重送。
        const audienceAttached = !!(r.audience_applied_at && Number(r.audience_applied_count) > 0);
        if (audienceAttached && body.confirm_audience !== true) {
          return jsonErr(res, 400, 'audience_attached', {
            detail: '這個選單是 ' + Number(r.audience_applied_count) + ' 位名單成員的專屬選單。刪掉之後他們會立刻退回一般選單。確定要刪，再按一次確認。',
            applied_count: Number(r.audience_applied_count) });
        }
        if (allIds.length) {
          // 已發布：要動 LINE 上的東西 → 升級成 owner 檢查；分頁別名一併清掉
          const aliases = Array.isArray(r.line_rich_menu_ids)
            ? r.line_rich_menu_ids.map(x => x && x.alias).filter(Boolean) : [];
          return requireOwner(req, res, async () => {
            try {
              // 先把名單成員安置好：在別的名單裡的人轉掛過去，其他人回一般選單
              if (audienceAttached && r.audience_list_id) {
                const { rows: ms } = await query(
                  `SELECT line_user_id FROM admin_recipient_list_members WHERE list_id=$1 LIMIT 20000`,
                  [r.audience_list_id]);
                const uids = ms.map(x => String(x.line_user_id || '').trim()).filter(u => /^U[0-9a-f]{32}$/i.test(u));
                if (uids.length) await unlinkOrRelink(uids, rowId).catch(e =>
                  console.error('richmenu delete relink failed:', e && e.message));
              }
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
  // 這是公開端點：只有真的解析到選單上的按鍵才記點擊，亂湊的編號一律只跳轉不入庫，
  // 否則任何人都能用腳本灌假點擊，把成效報表灌到不能看。
  // 同一人連點同一格 60 秒內只記一筆（每台伺服器各自算，夠擋手滑與粗暴的灌水迴圈）。
  const rTapSeen = new Map();
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
      if (uri) {
        const ip = String((req.headers && req.headers['x-forwarded-for']) || req.ip || '').split(',')[0].trim();
        const key = id + ':' + tab + ':' + cell + ':' + ip;
        const now = Date.now();
        const last = rTapSeen.get(key);
        if (!last || now - last > 60 * 1000) {
          rTapSeen.set(key, now);
          if (rTapSeen.size > 5000) {
            for (const [k, v] of rTapSeen) { if (now - v > 60 * 1000) rTapSeen.delete(k); }
          }
          // 記錄失敗不能擋跳轉——用戶體驗優先
          await query(
            `INSERT INTO rich_menu_taps (menu_id, tab, cell, kind, label) VALUES ($1,$2,$3,'link',$4)`,
            [id, tab, cell, label]).catch(() => {});
        }
      }
      res.redirect(uri || FALLBACK);
    } catch (e) {
      res.redirect(FALLBACK);
    }
  });

  // ── 記名追蹤跳板：/t/:id/:tab/:cell ──────────────────────────
  // 「開啟網址」的按鍵本身不帶 LINE 身分，所以直接轉址永遠不知道是誰按的。
  // 勾了「記錄是誰點的」的按鍵，發布時網址會改指到這裡（LIFF 頁）：
  // 用 LIFF 拿到身分、記一筆、再跳到真正的目的地。代價是多約 1 秒，
  // 所以只有要拿來貼標籤／分眾的按鍵才勾。
  function cellTarget(cfg, tab, cell) {
    if (!cfg) return null;
    const tabs = normalizeTabs(cfg);
    const b = tabs[tab] && tabs[tab].buttons ? tabs[tab].buttons[cell] : null;
    if (b && b.action && b.action.type === 'uri' && /^https:\/\//.test(String(b.action.uri || ''))) {
      return { uri: b.action.uri, label: b.label || null };
    }
    return null;
  }

  // 這個 LIFF 的網頁位置設定在 /games 底下，所以從 LINE 進來的網址會是 /games/t/...；
  // 直接貼網址測試時則是 /t/...。兩個都註冊，少一個就會看到「Cannot GET」。
  const tapBouncePaths = ['/t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)',
                          '/games/t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)'];
  tapBouncePaths.forEach(pth => app.get(pth, async (req, res) => {
    const FALLBACK = 'https://www.openrice.com';
    try {
      const id = Number(req.params.id), tab = Number(req.params.tab), cell = Number(req.params.cell);
      const { rows } = await query(`SELECT published_config FROM rich_menus WHERE id=$1`, [id]);
      const hit = cellTarget(rows.length ? rows[0].published_config : null, tab, cell);
      res.render('tap_bounce', {
        target: hit ? hit.uri : FALLBACK,
        liffId: gamesLiffId(),
        recordUrl: '/t/' + id + '/' + tab + '/' + cell + '/hit'
      });
    } catch (e) {
      console.error('tap bounce error:', e && e.message);
      res.redirect(FALLBACK);
    }
  }));

  // 跳板回報「是誰按的」。公開端點：只認選單上真的存在的按鍵，
  // 而且同一人同一格 60 秒只記一筆（跟 /r 同一套防灌水規矩）。
  const tapSeen = new Map();
  const tapHitPaths = ['/t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)/hit',
                       '/games/t/:id(\\d+)/:tab(\\d+)/:cell(\\d+)/hit'];
  tapHitPaths.forEach(pth => app.post(pth, async (req, res) => {
    try {
      const id = Number(req.params.id), tab = Number(req.params.tab), cell = Number(req.params.cell);
      const raw = String((req.body || {}).line_user_id || '').trim();
      const uid = /^U[0-9a-f]{32}$/i.test(raw) ? raw : null;
      const { rows } = await query(`SELECT published_config FROM rich_menus WHERE id=$1`, [id]);
      const hit = cellTarget(rows.length ? rows[0].published_config : null, tab, cell);
      if (!hit) return res.json({ ok: true, skipped: true });
      const ip = String((req.headers && req.headers['x-forwarded-for']) || req.ip || '').split(',')[0].trim();
      const key = id + ':' + tab + ':' + cell + ':' + (uid || ip);
      const now = Date.now();
      const last = tapSeen.get(key);
      if (last && now - last <= 60 * 1000) return res.json({ ok: true, deduped: true });
      tapSeen.set(key, now);
      if (tapSeen.size > 5000) {
        for (const [k, v] of tapSeen) { if (now - v > 60 * 1000) tapSeen.delete(k); }
      }
      await query(
        `INSERT INTO rich_menu_taps (menu_id, tab, cell, kind, label, line_user_id) VALUES ($1,$2,$3,'link',$4,$5)`,
        [id, tab, cell, hit.label, uid]);
      res.json({ ok: true });
    } catch (e) {
      console.error('tap hit error:', e && e.message);
      res.json({ ok: true });   // 記錄失敗絕不擋用戶
    }
  }));

  // ── 檢查連結：這個網址點下去到底會到哪 ──────────────────────
  // 打錯路徑的網站多半不會回 404，而是默默把人導回首頁（OpenRice 就是這樣），
  // 所以「有回應」不等於「是對的」。這裡跟著跳轉走一遍，把最後的落點講出來，
  // 並在「看起來只是回到首頁」時明講。
  app.post('/admin/richmenu/api/check-link', requireAdmin, async (req, res) => {
    const raw = String((req.body || {}).url || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return jsonErr(res, 400, 'bad_url', { detail: '網址要以 https:// 開頭' });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let resp;
      try {
        resp = await fetch(raw, { redirect: 'follow', signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
      } finally { clearTimeout(timer); }
      const finalUrl = resp.url || raw;
      const status = resp.status;

      let u1, u2;
      try { u1 = new URL(raw); u2 = new URL(finalUrl); } catch (e) { u1 = u2 = null; }
      // 「被導回首頁」的判斷：原本有指定路徑，最後卻落在很淺的路徑上
      const startPath = u1 ? u1.pathname.replace(/\/+$/, '') : '';
      const endPath = u2 ? u2.pathname.replace(/\/+$/, '') : '';
      const endDepth = endPath.split('/').filter(Boolean).length;
      const landedShallow = startPath.split('/').filter(Boolean).length >= 1 &&
                            endDepth <= 2 && endPath !== startPath && !u2.search;
      const changedHost = u1 && u2 && u1.hostname !== u2.hostname;

      let verdict, note;
      if (status >= 400) {
        verdict = 'bad';
        note = '這個網址打不開（伺服器回 ' + status + '）。檢查有沒有打錯字。';
      } else if (landedShallow) {
        verdict = 'suspect';
        note = '打得開，但最後停在「' + endPath + '」——看起來是被導回首頁了，' +
               '通常表示原本那個路徑不存在。用戶按了不會看到你要的內容。';
      } else if (changedHost || endPath !== startPath) {
        verdict = 'ok';
        note = '可以開，中間會轉一次，最後到「' + (u2 ? u2.host + endPath : finalUrl) + '」。確認一下這是你要的頁面。';
      } else {
        verdict = 'ok';
        note = '可以正常開啟。';
      }
      res.json({ ok: true, verdict, note, status, final_url: finalUrl });
    } catch (e) {
      const msg = String((e && e.message) || e);
      res.json({ ok: true, verdict: 'bad',
        note: /abort/i.test(msg) ? '等太久沒有回應（超過八秒），這個網址可能有問題。'
                                 : '連不上這個網址。檢查有沒有打錯字。',
        status: 0, final_url: null });
    }
  });

  // ── App 下載：自動分辨手機系統 ────────────────────────────
  // OpenRice 沒有「一個網址通吃」的下載頁（/download-app 這種路徑會被導回首頁），
  // 選單只能放一個網址，選 iPhone 的話 Android 用戶點了會很怪。
  // 這支看使用者的手機決定跳哪一家商店，選單放這一個就好。
  const APP_IOS = 'https://apps.apple.com/tw/app/id310663323';
  const APP_ANDROID = 'https://play.google.com/store/apps/details?id=com.openrice.android';
  app.get('/go/app', async (req, res) => {
    const ua = String((req.headers && req.headers['user-agent']) || '');
    const isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && /mobile/i.test(ua));
    const target = isIOS ? APP_IOS : APP_ANDROID;
    // 記一筆「有人要下載 App」（電腦上打開也算，只是分不出系統）
    try {
      await query(
        `INSERT INTO message_taps (source, ref_id, label, target_url, line_user_id) VALUES ('app', $1, 'App 下載', $2, NULL)`,
        [isIOS ? 'ios' : 'android', target]);
    } catch (e) { /* 記錄失敗絕不擋跳轉 */ }
    res.redirect(target);
  });

  // ── 訊息裡按鈕的記名追蹤：/t/m/:source/:refId ─────────────────
  // 關鍵字回覆、活動卡片這些訊息的按鈕，本來直接指向目的地，點了誰都不知道。
  // 改成先過這個跳板（跟圖文選單同一套：LIFF 拿身分 → 記一筆 → 跳走）。
  // 目的地不從網址帶（不然變成任何人都能拿它當轉址跳板），一律回頭查設定。
  // refId 形狀是「編號_第幾顆按鈕」（例如 12_0）：一則訊息可能有好幾顆按鈕，
  // 要分得出來按的是哪一顆。目的地一律回頭查設定，不從網址帶。
  async function messageTapTarget(source, refIdRaw) {
    try {
      const [idPart, idxPart] = String(refIdRaw || '').split('_');
      const idx = Number(idxPart || 0);
      let cfg = null;
      if (source === 'keyword') {
        const { rows } = await query(
          `SELECT t.message_config FROM admin_keyword_replies k
             JOIN admin_message_templates t ON t.id = k.message_template_id
            WHERE k.id = $1`, [Number(idPart) || 0]);
        cfg = rows[0] && rows[0].message_config;
      }
      if (!cfg) return null;
      const b = findUriButton(cfg, idx);
      return b ? { uri: b.uri, label: b.label } : null;
    } catch (e) { console.error('message tap target failed:', e && e.message); }
    return null;
  }

  const msgBouncePaths = ['/t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)',
                          '/games/t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)'];
  msgBouncePaths.forEach(pth => app.get(pth, async (req, res) => {
    const FALLBACK = 'https://www.openrice.com';
    try {
      const hit = await messageTapTarget(req.params.source, req.params.refId);
      if (!hit) return res.redirect(FALLBACK);
      res.render('tap_bounce', {
        target: hit.uri,
        liffId: gamesLiffId(),
        recordUrl: '/t/m/' + req.params.source + '/' + req.params.refId + '/hit'
      });
    } catch (e) {
      console.error('message tap bounce error:', e && e.message);
      res.redirect(FALLBACK);
    }
  }));

  const msgTapSeen = new Map();
  const msgHitPaths = ['/t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)/hit',
                       '/games/t/m/:source([a-z]+)/:refId([A-Za-z0-9_-]+)/hit'];
  msgHitPaths.forEach(pth => app.post(pth, async (req, res) => {
    try {
      const source = req.params.source, refId = req.params.refId;
      const raw = String((req.body || {}).line_user_id || '').trim();
      const uid = /^U[0-9a-f]{32}$/i.test(raw) ? raw : null;
      const hit = await messageTapTarget(source, refId);
      if (!hit) return res.json({ ok: true, skipped: true });
      const ip = String((req.headers && req.headers['x-forwarded-for']) || req.ip || '').split(',')[0].trim();
      const key = source + ':' + refId + ':' + (uid || ip);
      const now = Date.now();
      const last = msgTapSeen.get(key);
      if (last && now - last <= 60 * 1000) return res.json({ ok: true, deduped: true });
      msgTapSeen.set(key, now);
      if (msgTapSeen.size > 5000) {
        for (const [k, v] of msgTapSeen) { if (now - v > 60 * 1000) msgTapSeen.delete(k); }
      }
      await query(
        `INSERT INTO message_taps (source, ref_id, label, target_url, line_user_id) VALUES ($1,$2,$3,$4,$5)`,
        [source, String(refId), hit.label, hit.uri, uid]);
      res.json({ ok: true });
    } catch (e) {
      console.error('message tap hit error:', e && e.message);
      res.json({ ok: true });   // 記錄失敗絕不擋用戶
    }
  }));

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
      const { rows } = await query(`SELECT line_rich_menu_id, line_rich_menu_ids FROM rich_menus WHERE id=$1`, [id]);
      if (rows.length === 0) return jsonErr(res, 404, 'not_found');
      const startAt = body.start_at ? new Date(body.start_at) : null;
      const endAt = body.end_at ? new Date(body.end_at) : null;
      if ((startAt && isNaN(startAt)) || (endAt && isNaN(endAt))) return jsonErr(res, 400, 'bad_time', { detail: '時間格式不對' });
      if (startAt && endAt && endAt <= startAt) return jsonErr(res, 400, 'bad_time', { detail: '下架時間要在上架時間之後' });
      // 過去的上架時間會讓排程永遠不執行，卻被標成「已上架」——寧可當場擋下講清楚
      if (startAt && startAt <= new Date()) {
        return jsonErr(res, 400, 'bad_time', { detail: '上架時間要選未來的時間。想現在就上，直接按「設為所有人看到的」就好。' });
      }
      if (endAt && endAt <= new Date()) {
        return jsonErr(res, 400, 'bad_time', { detail: '下架時間要選未來的時間。' });
      }
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
      // 只排下架（沒排上架）＝「現在檯面上這個選單，到時候收掉」——
      // 那它得真的是所有人看到的那個，否則「已排上架」的狀態是在騙人，
      // 到點還會把別人正在線上的選單收掉
      if (endAt && !startAt) {
        const allIds = new Set([rows[0].line_rich_menu_id].filter(Boolean));
        if (Array.isArray(rows[0].line_rich_menu_ids)) {
          rows[0].line_rich_menu_ids.forEach(x => { if (x && x.id) allIds.add(x.id); });
        }
        let cur = null;
        try { cur = (await rm.getDefaultRichMenu()).id; } catch (e) { /* 查不到就照舊放行 */ }
        if (cur && !allIds.has(cur)) {
          return jsonErr(res, 400, 'not_live', {
            detail: '這個選單現在不是所有人看到的，沒有「下架」可排。想讓它之後自動上架，把上架時間也填上。' });
        }
      }
      // 沒指定接手的選單＝到點把預設選單整個取消。實測確認：這會連 LINE 官方後台
      // 設的長青選單一起關掉，而且不會自動回來，要有人手動去官方後台重開。
      // 前端會先問一次，這裡是後端的第二道：沒有明講「我知道」就不給排。
      if (endAt && !endMenuId && body.confirm_no_menu !== true) {
        return jsonErr(res, 400, 'no_end_menu', {
          detail: '沒有指定接手的選單。到了下架時間，全體用戶的圖文選單會直接消失（包含官方後台設的長青選單），而且不會自動回來。要嘛指定一個選單接手，要嘛再確認一次。' });
      }
      const state = (!startAt && !endAt) ? null : (startAt ? 'pending' : 'live');
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
      // 順序鐵則：先下架、再上架。
      // 反過來的話，同一個 tick 內換檔（舊選單下架＋新選單上架同時到點）
      // 會先把新選單設上去、再被舊選單的下架動作清掉——所有人選單直接消失。
      //
      // 到點下架：換成指定選單，或不顯示。
      // 動手前先跟 LINE 確認「檯面上的預設選單真的還是我」——中途有人手動換過選單
      // 的話，過期排程不可以把別人正在線上的選單收掉；只把自己標結束、不動 LINE。
      const { rows: toEnd } = await query(
        `SELECT id, name, line_rich_menu_id, line_rich_menu_ids, schedule_end_menu_id FROM rich_menus
          WHERE schedule_state='live' AND schedule_end_at IS NOT NULL AND schedule_end_at <= now() LIMIT 10`);
      for (const r of toEnd) {
        try {
          const myIds = new Set([r.line_rich_menu_id].filter(Boolean));
          if (Array.isArray(r.line_rich_menu_ids)) {
            r.line_rich_menu_ids.forEach(x => { if (x && x.id) myIds.add(x.id); });
          }
          let cur = null;
          try { cur = (await rm.getDefaultRichMenu()).id; } catch (e) { /* 查不到就保守跳過動作 */ }
          const stillMine = !!(cur && myIds.has(cur));
          if (stillMine) {
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
          }
          await query(`UPDATE rich_menus SET schedule_state='done', updated_at=now() WHERE id=$1`, [r.id]);
          done.push({ id: r.id, action: stillMine ? 'end' : 'end_skipped_not_live' });
        } catch (e) { console.error('richmenu schedule end failed:', r.id, e.message); }
      }
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
      res.json({ ok: true, done });
    } catch (err) {
      console.error('richmenu run-schedule error:', err && err.message);
      jsonErr(res, 500, 'run_failed', { detail: String(err && err.message || '').slice(0, 200) });
    }
  });

  // ── 名單專屬選單（用名單庫當「用戶標籤」）────────────────────

  // 解除一批人的專屬選單。有人同時也在「別的選單」生效中的名單裡→改連到那個選單，
  // 不是一律退回預設——全域解除會把其他選單的名單專屬一併打掉（審查抓到的實錯）。
  // 同一人掛在多個名單時，以最近套用的那個選單為準。
  async function unlinkOrRelink(uids, exceptRowId) {
    if (!uids.length) return;
    const { rows: owned } = await query(
      `SELECT DISTINCT ON (m.line_user_id) m.line_user_id, r.line_rich_menu_id
         FROM rich_menus r
         JOIN admin_recipient_list_members m ON m.list_id = r.audience_list_id
        WHERE r.audience_applied_at IS NOT NULL AND r.line_rich_menu_id IS NOT NULL
          AND r.id <> $1 AND m.line_user_id = ANY($2)
        ORDER BY m.line_user_id, r.audience_applied_at DESC`,
      [exceptRowId || 0, uids]);
    const byMenu = new Map();
    for (const o of owned) {
      if (!byMenu.has(o.line_rich_menu_id)) byMenu.set(o.line_rich_menu_id, []);
      byMenu.get(o.line_rich_menu_id).push(o.line_user_id);
    }
    const keepSet = new Set(owned.map(o => o.line_user_id));
    const plain = uids.filter(u => !keepSet.has(u));
    if (plain.length) await rm.bulkUnlink(plain);
    for (const [mid, us] of byMenu) await rm.bulkLink(mid, us);
  }

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
      // 一次呼叫最多處理 4000 人（8 次 LINE API）。大名單分好幾次呼叫跑完，
      // 免得撞上 serverless 的 10 秒斷頭：斷在一半會變成「上千人已綁定、後台卻說沒套用」。
      const CHUNK = 4000;
      const offset = Math.max(0, Number(body.offset) || 0);

      const memberUids = async (lid) => {
        const { rows: ms } = await query(
          `SELECT line_user_id FROM admin_recipient_list_members WHERE list_id=$1 ORDER BY line_user_id LIMIT 20000`, [lid]);
        return ms.map(x => String(x.line_user_id || '').trim()).filter(u => /^U[0-9a-f]{32}$/i.test(u));
      };

      if (!listId) {
        // 取消名單專屬：把原名單成員解除綁定（在別的名單裡的人轉掛過去，其他人回到所有人看到的）
        if (row.audience_list_id) {
          const uids = await memberUids(row.audience_list_id);
          const slice = uids.slice(offset, offset + CHUNK);
          if (slice.length) await unlinkOrRelink(slice, id);
          if (offset + CHUNK < uids.length) {
            return res.json({ ok: true, partial: true, done: offset + CHUNK, total: uids.length, next_offset: offset + CHUNK });
          }
        }
        await query(`UPDATE rich_menus SET audience_list_id=NULL, audience_applied_at=NULL,
                     audience_applied_count=NULL, updated_at=now() WHERE id=$1`, [id]);
        return res.json({ ok: true, cleared: true });
      }

      if (!row.line_rich_menu_id) return jsonErr(res, 400, 'not_published', { detail: '先發布這個選單，才能指定名單' });
      const uids = await memberUids(listId);
      if (!uids.length) return jsonErr(res, 400, 'empty_list', { detail: '這份名單沒有可用的成員' });
      // 換名單時，第一批先把舊名單裡「不在新名單」的人解除（或轉掛到他所屬的其他選單）
      if (offset === 0 && row.audience_list_id && row.audience_list_id !== listId) {
        const oldUids = await memberUids(row.audience_list_id);
        const keep = new Set(uids);
        const drop = oldUids.filter(u => !keep.has(u));
        if (drop.length) await unlinkOrRelink(drop, id);
      }
      const slice = uids.slice(offset, offset + CHUNK);
      await rm.bulkLink(row.line_rich_menu_id, slice);
      const doneCount = Math.min(offset + CHUNK, uids.length);
      const finished = doneCount >= uids.length;
      await query(`UPDATE rich_menus SET audience_list_id=$2,
                   audience_applied_at = CASE WHEN $4 THEN now() ELSE audience_applied_at END,
                   audience_applied_count=$3, updated_at=now() WHERE id=$1`,
                  [id, listId, doneCount, finished]);
      if (!finished) {
        return res.json({ ok: true, partial: true, done: doneCount, total: uids.length, next_offset: doneCount });
      }
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
        // 不能一律 unlink：測試人員若本來就在某個「名單專屬選單」的名單裡，
        // 結束預覽要回到那個選單，不是退回所有人看到的
        await unlinkOrRelink(uids, 0);
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
