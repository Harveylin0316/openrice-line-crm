// 這次審查修掉的問題，一條一條鎖住：
//  1. 收訊差重送在「最後一次機會」時，要回原本抽到的結果，不是「次數已用完」
//  2. 重送時，優惠券發完的說明也要跟著回去
//  3. 邀請成功的通知要真的送出去才回應（serverless 回應後會凍結）
//  4. 排程：先下架再上架；檯面上的選單被人手動換過就不要亂動
//  5. 排程存檔：過去的時間要當場擋
//  6. 轉址：亂湊的編號不記點擊、同一人連點只記一筆
//  7. 名單解除：本來就在別份名單裡的人要轉掛過去，不是全部退回
//  8. 分頁接線失敗要整批退回
//  9. 大名單分批續跑
const path = require('path');
const { selectPrizeAndRecord, registerReferral } = require(path.join(__dirname, '..', 'src/core/gamePlayEngine'));
const { registerAdminRichMenuRoutes } = require(path.join(__dirname, '..', 'src/routes/adminRichMenu'));

process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
process.env.SCHEDULED_RUNNER_SECRET = 'sch-secret';
process.env.URL = 'https://example.netlify.app';
process.env.LIFF_TOKEN_ENFORCE = '0';

let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// ── 引擎：假的資料庫連線，可設定「這一把鑰匙已經有紀錄」與「次數已滿」 ──
function fakePool(opts) {
  const existing = opts.existingPlay || null;   // 同鑰匙已存在的紀錄
  const playedCount = opts.playedCount != null ? opts.playedCount : 0;
  const sqls = [];
  const client = {
    query: async (sql, params) => {
      const f = String(sql).replace(/\s+/g, ' ');
      sqls.push(f);
      if (/^BEGIN|^ROLLBACK|^COMMIT/.test(f)) return { rows: [] };
      if (/FROM activities WHERE slug/.test(f)) {
        return { rows: [{ id: 6, status: 'active', start_at: null, end_at: null,
          daily_plays_per_user: opts.dailyLimit || null, base_plays_per_user: 1,
          referral_bonus_per: 1, referral_bonus_max: 8, referral_invites_per_bonus: 1 }] };
      }
      // 同鑰匙查重：第一次（交易開頭）依 opts.dupVisibleAtStart 決定看不看得到
      if (/properties->>'play_key' = \$3/.test(f)) {
        const atStart = sqls.filter(x => /properties->>'play_key' = \$3/.test(x)).length === 1;
        if (atStart && !opts.dupVisibleAtStart) return { rows: [] };
        return { rows: existing ? [existing] : [] };
      }
      if (/COUNT\(\*\) AS c FROM activity_plays/.test(f)) {
        const isDaily = /played_at >= date_trunc/.test(f);
        return { rows: [{ c: String(isDaily ? (opts.dailyPlayed || 0) : playedCount) }] };
      }
      if (/FROM activity_referrals/.test(f)) return { rows: [{ c: '0' }] };
      if (/FROM activity_bonus_plays/.test(f)) return { rows: [{ c: '0' }] };
      if (/FROM activity_user_quotas/.test(f)) return { rows: [] };
      if (/FROM activity_prizes/.test(f)) {
        return { rows: [{ id: 11, name: '獎', description: '', probability_weight: 1,
          stock_total: null, stock_remaining: null, prize_type: 'none', prize_value: {},
          image_url: null, is_grand_prize: false, position: 0 }] };
      }
      if (/INSERT INTO activity_plays/.test(f)) return { rows: [{ id: 999 }] };
      return { rows: [] };
    },
    release() {}
  };
  return { pool: { connect: async () => client }, sqls };
}

(async () => {
  // 1) 最後一次機會＋重送：第一個請求已 commit（開頭看不到、複查時看得到）
  {
    const snap = { name: '$100 折價券', description: '', prize_type: 'coupon_code', position: 2 };
    const f = fakePool({ playedCount: 1, dupVisibleAtStart: false,
      existingPlay: { id: 777, prize_id: 11, prize_snapshot: snap, coupon_code: null } });
    const out = await selectPrizeAndRecord({ pool: f.pool, activitySlug: 'share-miles', gameType: 'wheel',
      lineUserId: 'U'.padEnd(33, 'a'), playKey: 'pk-same-key' });
    ok(out.ok === true && out.replayed === true && out.play_id === 777,
      '收訊差重送：回原本抽到的結果，不是「次數已用完」');
    // 2) 券發完的說明也要跟著回去
    ok(out.coupon_out_of_stock === true,
      '重送時「這份券剛好發完了」的說明有帶回去');
  }
  // 3) 沒帶鑰匙、次數真的用完 → 照樣擋
  {
    const f = fakePool({ playedCount: 1 });
    const out = await selectPrizeAndRecord({ pool: f.pool, activitySlug: 'share-miles', gameType: 'wheel',
      lineUserId: 'U'.padEnd(33, 'b') });
    ok(out.error && out.error.code === 'quota_exhausted', '真的用完次數還是擋得住');
  }
  // 4) 每日上限也一樣：帶著同一把鑰匙重送要回原結果
  {
    const snap = { name: '銘謝惠顧', prize_type: 'none', position: 0 };
    const f = fakePool({ playedCount: 0, dailyLimit: 1, dailyPlayed: 1, dupVisibleAtStart: false,
      existingPlay: { id: 555, prize_id: 11, prize_snapshot: snap, coupon_code: null } });
    const out = await selectPrizeAndRecord({ pool: f.pool, activitySlug: 'share-miles', gameType: 'wheel',
      lineUserId: 'U'.padEnd(33, 'c'), playKey: 'pk-daily' });
    ok(out.ok === true && out.play_id === 555, '碰到每日上限時，重送也回原結果');
    ok(out.coupon_out_of_stock === false, '沒中獎的重送不會誤報「券發完」');
  }

  // 5) 邀請通知必須在回應前送出（serverless 回應後會凍結）
  {
    const pushed = [];
    global.fetch = async (url, o) => {
      if (/\/v2\/bot\/message\/push/.test(String(url))) {
        await new Promise(r => setTimeout(r, 20));   // 推播比回應慢
        pushed.push(url);
      }
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };
    let usersLookups = 0;
    const query = async (sql) => {
      const f = String(sql).replace(/\s+/g, ' ');
      if (/FROM activities WHERE slug/.test(f)) return { rows: [{ id: 6, status: 'active', name: '分享超有哩',
        start_at: null, end_at: null, base_plays_per_user: 1, referral_bonus_per: 1,
        referral_bonus_max: 8, referral_invites_per_bonus: 1, daily_plays_per_user: null }] };
      if (/INSERT INTO activity_referrals/.test(f)) return { rows: [{ id: 1 }] };
      if (/AS was_existing/.test(f)) return { rows: [{ was_existing: false }] };
      if (/FROM users WHERE line_user_id/.test(f)) {
        // 第一次查的是邀請人（必須是現行會員），之後查的是被邀請人（新朋友＝查不到）
        usersLookups++;
        return { rows: usersLookups === 1 ? [{ '?column?': 1 }] : [] };
      }
      if (/COUNT/.test(f)) return { rows: [{ c: '1' }] };
      return { rows: [] };
    };
    await registerReferral({ query, activitySlug: 'share-miles', gameType: 'wheel',
      inviterId: 'U'.padEnd(33, 'd'), inviteeId: 'U'.padEnd(33, 'e') });
    ok(pushed.length === 1, '邀請成功的通知在回應前就送出去了（不會被 serverless 凍掉）');
  }

  // ── 圖文選單路由 ──
  function buildRm(opts) {
    opts = opts || {};
    const lineCalls = [], dbCalls = [], taps = [];
    global.fetch = async (url, o) => {
      const method = (o && o.method) || 'GET';
      lineCalls.push(method + ' ' + url);
      if (method === 'GET' && /user\/all\/richmenu$/.test(url)) {
        if (!opts.liveDefaultId) return { ok: false, status: 404, text: async () => '{}' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: opts.liveDefaultId }) };
      }
      if (method === 'POST' && /\/v2\/bot\/richmenu$/.test(url))
        return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-new1' }) };
      if (method === 'POST' && /richmenu\/alias/.test(url) && opts.aliasFails)
        return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'alias boom' }) };
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const routes = {};
    const app = { get: (p, ...h) => { routes['GET ' + p] = h; },
                  post: (p, ...h) => { routes['POST ' + p] = h; }, delete: () => {}, put: () => {} };
    const query = async (sql, params) => {
      const f = String(sql).replace(/\s+/g, ' ');
      dbCalls.push({ f, params });
      if (/INSERT INTO rich_menu_taps/.test(f)) { taps.push(params); return { rows: [] }; }
      if (/SELECT published_config FROM rich_menus/.test(f))
        return { rows: opts.publishedConfig === null ? [] : [{ published_config: opts.publishedConfig ||
          { size: 'large', cells: [{}], buttons: [{ label: '找餐廳', action: { type: 'uri', uri: 'https://www.openrice.com/x' } }] } }] };
      if (/schedule_state='pending'/.test(f)) return { rows: opts.pendingRows || [] };
      if (/schedule_state='live' AND schedule_end_at/.test(f)) return { rows: opts.liveRows || [] };
      if (/JOIN admin_recipient_list_members/.test(f)) return { rows: opts.ownedElsewhere || [] };
      if (/SELECT line_user_id FROM admin_recipient_list_members/.test(f))
        return { rows: (opts.members || []).map(u => ({ line_user_id: u })) };
      if (/SELECT line_rich_menu_id, audience_list_id FROM rich_menus/.test(f))
        return { rows: [{ line_rich_menu_id: 'richmenu-mine', audience_list_id: opts.audienceListId || null }] };
      if (/SELECT line_rich_menu_id, line_rich_menu_ids FROM rich_menus/.test(f))
        return { rows: [{ line_rich_menu_id: 'richmenu-mine', line_rich_menu_ids: null }] };
      if (/SELECT line_rich_menu_id FROM rich_menus WHERE id=/.test(f))
        return { rows: [{ line_rich_menu_id: 'richmenu-mine' }] };
      return { rows: [] };
    };
    const pass = (req, res, next) => next();
    registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
    return { routes, lineCalls, dbCalls, taps };
  }
  function res() { const o = { code: 200, body: null, redirected: null };
    o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; };
    o.render = () => o; o.redirect = u => { o.redirected = u; return o; }; return o; }
  async function run(routes, key, reqBody, extras) {
    const hs = routes[key]; const r = res();
    const req = { body: reqBody || {}, query: {}, params: {}, headers: {}, ip: '1.2.3.4',
                  authUser: { un: 'admin', adm: true },
                  get: (h) => (extras && extras.headers && extras.headers[h]) || '', ...(extras || {}) };
    for (let i = 0; i < hs.length; i++) {
      let called = false;
      await hs[i](req, r, () => { called = true; });
      if (!called) break;
    }
    return r;
  }

  // 6) 同一個 tick 換檔：先下架再上架，最後檯面上是新選單
  {
    const t = buildRm({ liveDefaultId: 'richmenu-old9',
      liveRows: [{ id: 1, name: '舊', line_rich_menu_id: 'richmenu-old9', line_rich_menu_ids: null, schedule_end_menu_id: null }],
      pendingRows: [{ id: 2, name: '新', line_rich_menu_id: 'richmenu-new9' }] });
    await run(t.routes, 'POST /admin/richmenu/run-schedule', {}, { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
    const clearAt = t.lineCalls.findIndex(c => /DELETE .*user\/all\/richmenu$/.test(c));
    const setAt = t.lineCalls.findIndex(c => /POST .*user\/all\/richmenu\/richmenu-new9$/.test(c));
    ok(setAt >= 0 && (clearAt === -1 || clearAt < setAt),
      '同一時間換檔：先收舊的再上新的，新選單不會被舊排程蓋掉');
  }
  // 7) 中途有人手動換過選單 → 過期的下架排程不去動它
  {
    const t = buildRm({ liveDefaultId: 'richmenu-someone-else',
      liveRows: [{ id: 1, name: '舊', line_rich_menu_id: 'richmenu-old9', line_rich_menu_ids: null, schedule_end_menu_id: null }] });
    const r = await run(t.routes, 'POST /admin/richmenu/run-schedule', {}, { headers: { 'X-Scheduler-Secret': 'sch-secret' } });
    ok(!t.lineCalls.some(c => /DELETE .*user\/all\/richmenu$/.test(c)),
      '別人手動換過選單後，過期排程不會把它收掉');
    ok(r.body.done[0].action === 'end_skipped_not_live', '這種情況會照實記成「跳過」');
  }
  // 8) 排程存檔：過去的時間當場擋
  {
    const t = buildRm({ liveDefaultId: 'richmenu-mine' });
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const r = await run(t.routes, 'POST /admin/richmenu/api/schedule',
      { id: 1, start_at: past, end_at: new Date(Date.now() + 7200 * 1000).toISOString() });
    ok(r.code === 400 && /未來/.test(r.body.detail || ''), '上架時間選到過去會被擋下並說清楚');
  }
  // 9) 只排下架、但這個選單根本不是檯面上那個 → 擋
  {
    const t = buildRm({ liveDefaultId: 'richmenu-someone-else' });
    const r = await run(t.routes, 'POST /admin/richmenu/api/schedule',
      { id: 1, end_at: new Date(Date.now() + 7200 * 1000).toISOString() });
    ok(r.code === 400 && r.body.error === 'not_live', '不是現在檯面上的選單，不給只排下架');
  }
  // 10) 轉址：亂湊的編號不記點擊
  {
    const t = buildRm({});
    await run(t.routes, 'GET /r/:id(\\d+)/:tab(\\d+)/:cell(\\d+)', null, { params: { id: '1', tab: '7', cell: '9' } });
    ok(t.taps.length === 0, '亂湊的按鍵位置不會被記成一筆點擊');
  }
  // 11) 轉址：同一人連點同一格，60 秒內只記一筆
  {
    const t = buildRm({});
    for (let i = 0; i < 3; i++)
      await run(t.routes, 'GET /r/:id(\\d+)/:tab(\\d+)/:cell(\\d+)', null,
        { params: { id: '1', tab: '0', cell: '0' }, headers: { 'x-forwarded-for': '9.9.9.9' } });
    ok(t.taps.length === 1, '同一人連按三次只記一筆（灌不了成效數字）');
  }
  // 12) 取消名單專屬：本來就在別份名單裡的人 → 轉掛過去，不是退回一般選單
  {
    const A = 'U' + '1'.repeat(32), B = 'U' + '2'.repeat(32);
    const t = buildRm({ audienceListId: 5, members: [A, B],
      ownedElsewhere: [{ line_user_id: B, line_rich_menu_id: 'richmenu-other' }] });
    await run(t.routes, 'POST /admin/richmenu/api/audience', { id: 1, list_id: null });
    const unlink = t.lineCalls.filter(c => /bulk\/unlink/.test(c));
    const relink = t.lineCalls.filter(c => /bulk\/link/.test(c));
    ok(unlink.length === 1 && relink.length === 1,
      '取消名單：一般成員解除、還在別份名單的人改掛他該看的選單');
  }
  // 13) 分頁接線失敗 → 整批退回（新建的刪掉、別名指回舊的）
  {
    const t = buildRm({ aliasFails: true });
    const TWO = { size: 'large', chat_bar_text: '選單', tabs: [
      { label: 'A', cells: [{ x: 0, y: 176, w: 2500, h: 1510 }], buttons: [{ label: 'a', action: { type: 'message', text: 'a' } }] },
      { label: 'B', cells: [{ x: 0, y: 176, w: 2500, h: 1510 }], buttons: [{ label: 'b', action: { type: 'message', text: 'b' } }] } ] };
    // 這一題要自己的資料樁（要回 published_config 等欄位）
    const routes = {}; const lineCalls = [];
    const app = { get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; },
                  delete: () => {}, put: () => {} };
    let created = 0;
    global.fetch = async (url, o) => {
      const method = (o && o.method) || 'GET';
      lineCalls.push(method + ' ' + url);
      if (method === 'GET' && /user\/all\/richmenu$/.test(url)) return { ok: false, status: 404, text: async () => '{}' };
      if (method === 'POST' && /\/v2\/bot\/richmenu$/.test(url)) { created++; return { ok: true, status: 200, text: async () => JSON.stringify({ richMenuId: 'richmenu-new' + created }) }; }
      if (method === 'POST' && /richmenu\/alias/.test(url)) return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'alias boom' }) };
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const dbCalls = [];
    const query = async (sql, params) => {
      const f = String(sql).replace(/\s+/g, ' '); dbCalls.push({ f, params });
      if (/SELECT id, name, config, line_rich_menu_id/.test(f))
        return { rows: [{ id: 1, name: '測試', config: TWO, line_rich_menu_id: 'richmenu-oldA',
          line_rich_menu_ids: [{ tab: 0, id: 'richmenu-oldA', alias: 'crm-r1-t0' }, { tab: 1, id: 'richmenu-oldB', alias: 'crm-r1-t1' }],
          is_default: false, audience_list_id: null, published_config: TWO, status: 'published',
          published_at: '2026-08-01T00:00:00Z', audience_applied_at: null }] };
      return { rows: [] };
    };
    const pass = (req, r2, next) => next();
    registerAdminRichMenuRoutes(app, { query, authCore: { requireAdmin: pass, requireOwner: pass } });
    const IMG = 'data:image/jpeg;base64,' + Buffer.from('fakejpg').toString('base64');
    const r = await run(routes, 'POST /admin/richmenu/api/publish', { id: 1, images: [IMG, IMG] });
    ok(r.code === 500 && /退回/.test(r.body.detail || ''), '分頁接線失敗會照實說「已整批退回」');
    ok(lineCalls.filter(c => /DELETE .*richmenu\/richmenu-new/.test(c)).length === 2, '這次新建的兩張都刪掉了');
    ok(lineCalls.some(c => /POST .*alias\/crm-r1-t0$/.test(c)), '別名指回舊選單');
    ok(dbCalls.some(c => /SET line_rich_menu_id=\$2/.test(c.f) && c.params[1] === 'richmenu-oldA'), '後台紀錄復原成舊版');
  }
  // 14) 大名單分批：一次呼叫跑不完會回「還沒跑完、從第幾個接著跑」
  {
    const many = Array.from({ length: 4500 }, (_, i) => 'U' + String(i).padStart(32, '0'));
    const t = buildRm({ members: many });
    const r = await run(t.routes, 'POST /admin/richmenu/api/audience', { id: 1, list_id: 5 });
    ok(r.body.partial === true && r.body.next_offset === 4000 && r.body.total === 4500,
      '名單超過一次能跑的量：回報進度讓後台接著跑（不會斷在半路沒紀錄）');
  }

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n這次修的問題全部鎖住了');
  process.exit(failed ? 1 : 0);
})();
