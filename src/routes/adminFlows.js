/**
 * 自動化流程 routes（階段 2 cron + 階段 3 編輯器 CRUD）
 *
 * 頁面：
 *   GET    /admin/flows                    流程列表 + 編輯器
 * API：
 *   GET    /admin/flows/api/options        下拉用：訊息庫 / 名單 / 活動 / 常見事件
 *   GET    /admin/flows/api/list           流程列表（含進行中人數）
 *   GET    /admin/flows/api/:id            單一流程（節點還原成步驟樹）
 *   POST   /admin/flows/api                新增
 *   PUT    /admin/flows/api/:id            更新（重寫節點）
 *   POST   /admin/flows/api/:id/status     啟用 / 暫停 / 轉草稿
 *   DELETE /admin/flows/api/:id            刪除
 * cron：
 *   POST   /admin/flows/run                每分鐘排程推進
 *   POST   /admin/flows/run-now            admin 手動推進一次（測試）
 *
 * 步驟樹 ←→ 節點：
 *   steps: [ {type:'send',message_id} | {type:'wait',amount,unit}
 *            | {type:'branch',condition,yes:[...],no:[...]} ]
 *   分支限制在主序列，yes/no 內只放 send/wait（中版，員工好懂）。
 */

const { recordRestaurantClick } = require('../core/restaurantLinkParse');
const { normalizeTabs } = require('../core/lineRichMenu');
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');

const CAMPAIGN_SOURCES = ['richmenu', 'broadcast', 'welcome', 'other'];

// 「流程觸發事件」下拉：使用者在好康地圖活動頁做的動作。
// 同時用在兩個地方 —— 觸發條件「活動頁互動」的事件選單，以及條件分支裡的「做了某動作」選單。
//
// 活動頁改版後動作名稱整批換過，舊名稱最後一次有紀錄的日期：
//   submit_draw 07-08、result_shown 07-08、restaurant_click 06-18
//   （redraw、ad_shown 也一起停了，但這兩個本來就沒放進選單，所以不列）
// 也就是說，用舊名稱建立的流程從那天起就再也不會被觸發，數字永遠是 0。
//
// 排序：現行的排前面（員工預設會選到對的）；舊的留在最後並標「已停用」。
// 為什麼不直接刪掉舊的三筆：後台可能已經有流程（或分支條件）存著這些值，
// 選項一消失，下拉會找不到對應項而顯示空白，員工只要再按一次儲存就會把原本的設定洗掉。
// 等確認沒有任何流程還在用這三個值之後，才可以安全移除。
const KNOWN_EVENTS = [
  // 現行（活動頁還在持續產生）
  { value: 'map_booking_click', label: '點了訂位' },
  { value: 'map_pin_click', label: '點了地圖上的餐廳' },
  { value: 'map_restaurant_view', label: '看了餐廳的詳細內容' },
  { value: 'map_decide_click', label: '按了「幫我決定」' },
  { value: 'map_decide_result', label: '抽到一間餐廳' },
  { value: 'map_favorite_toggle', label: '收藏了餐廳' },
  { value: 'map_share_click', label: '按了分享' },
  { value: 'app_open', label: '開啟活動頁' },
  // 舊版（活動頁改版後就不會再發生，只保留給既有流程顯示用）
  { value: 'submit_draw', label: '抽了一次餐廳（已停用，不會再觸發）' },
  { value: 'result_shown', label: '看到抽籤結果（已停用，不會再觸發）' },
  { value: 'restaurant_click', label: '點了餐廳訂位（已停用，不會再觸發）' }
];

// 觸發條件「點了訊息裡的餐廳連結」可選的餐廳種類白名單（與餐廳目錄 restaurant_catalog.cuisine 一致）。
// 注意：這個觸發條件代號剛好也叫 restaurant_click，但它跟上面那個已停用的活動頁動作無關 ——
// 它看的是「使用者點了我們自己發出去的餐廳連結」（user_restaurant_clicks），現在仍正常運作，不要一起改掉。
const FLOW_CUISINES = ['日式', '韓式', '台菜中式', '港式', '泰式東南亞', '義式', '美式', '火鍋', '燒肉', '甜點咖啡', '早午餐', '其他'];

function registerAdminFlowsRoutes(app, deps) {
  const { query, pool, flowEngine, authCore } = deps;
  const requireAdmin = authCore && authCore.requireAdmin;
  const verifyCampaignToken = deps.verifyLiffIdToken || verifyLiffIdToken;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }
  function isPosInt(s) { return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0; }
  function gamesLiffId() {
    return process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';
  }
  function siteBase() {
    return String(process.env.PUBLIC_SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');
  }
  function liffIdFromUrl(uri) {
    const m = /^https:\/\/liff\.line\.me\/([^/?#]+)/i.exec(String(uri || ''));
    return m ? m[1] : '';
  }
  function cleanHttpsUrl(raw) {
    const s = String(raw || '').trim();
    if (!s || s.length > 2048) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' || u.username || u.password) return '';
      return u.toString();
    } catch (_) { return ''; }
  }
  function campaignTarget(flow) {
    const cfg = flow && flow.trigger_config && typeof flow.trigger_config === 'object' ? flow.trigger_config : {};
    const target = cleanHttpsUrl(cfg.target_url);
    if (!target) return null;
    const targetLiffId = liffIdFromUrl(target);
    let browserTarget = target;
    if (targetLiffId && siteBase()) {
      const m = /^https:\/\/liff\.line\.me\/[^/?#]+(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(target);
      if (m) browserTarget = siteBase() + '/games' + (m[1] || '') + (m[2] || '') + (m[3] || '');
    }
    return {
      target,
      browserTarget,
      liffId: targetLiffId || gamesLiffId(),
      label: String(cfg.campaign_name || flow.name || '活動').trim().slice(0, 100)
    };
  }
  function campaignTrackingLinks(flow) {
    const hit = campaignTarget(flow);
    if (!hit || !hit.liffId) return {};
    const base = 'https://liff.line.me/' + hit.liffId + '/ce/' + flow.id + '/';
    return Object.fromEntries(CAMPAIGN_SOURCES.map(source => [source, base + source]));
  }

  // ---------- 公開：流程訊息點擊中轉（記點擊 + 302 導向真連結） ----------
  app.get('/rf/:enrollmentId(\\d+)/:messageId(\\d+)', async (req, res) => {
    const eid = Number(req.params.enrollmentId);
    const mid = Number(req.params.messageId);
    try {
      const rs = await query(`SELECT message_config FROM admin_message_templates WHERE id = $1`, [mid]);
      const cfg = rs.rows[0] && rs.rows[0].message_config;
      let target = (cfg && cfg.mode === 'template' && cfg.template && cfg.template.ctaUrl) ? String(cfg.template.ctaUrl).trim() : '';
      if (!/^https?:\/\//i.test(target)) return res.status(404).type('text/plain').send('Not found');
      // 點擊追蹤必須在 302 之前寫完：serverless 在回應送出後會凍結，
      // 沒 await 的 INSERT 可能永遠沒進 DB → 「點了連結」分支永遠走不到
      try {
        await query(
          `INSERT INTO admin_flow_clicks (enrollment_id, line_user_id, message_id, target_url)
           SELECT $1, e.line_user_id, $2, $3 FROM admin_flow_enrollments e WHERE e.id = $1`,
          [eid, mid, target]
        );
      } catch (err) { console.error('flow click log failed:', err.message); }
      try {
        const r = await query(`SELECT line_user_id FROM admin_flow_enrollments WHERE id = $1`, [eid]);
        const luid = r.rows[0] && r.rows[0].line_user_id;
        if (luid) await recordRestaurantClick(query, { lineUserId: luid, url: target, source: 'flow' });
      } catch (err) { console.error('restaurant click (flow) failed:', err.message); }
      return res.redirect(302, target);
    } catch (err) {
      console.error('flow click redirect error:', err && err.message);
      return res.status(500).type('text/plain').send('Server error');
    }
  });

  // ---------- 公開：跨入口活動追蹤 ----------
  // 圖文選單、推播與歡迎訊息都使用同一條 flow 的不同來源網址。網址只含 flow id，
  // 真正目的地一律回 DB 查，避免成為任意轉址器。驗證或記錄失敗都不能阻擋用戶進活動。
  const campaignSeen = new Map();
  const campaignBouncePaths = ['/ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)',
                               '/games/ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)'];
  campaignBouncePaths.forEach(pth => app.get(pth, async (req, res) => {
    const fallback = 'https://www.openrice.com';
    try {
      const rs = await query(
        `SELECT id, name, status, trigger_type, trigger_config FROM admin_flows
          WHERE id = $1 AND trigger_type = 'campaign_open' LIMIT 1`,
        [Number(req.params.id)]
      );
      const flow = rs.rows[0];
      const hit = campaignTarget(flow);
      if (!hit) return res.redirect(fallback);
      res.setHeader('Cache-Control', 'no-store');
      return res.render('tap_bounce', {
        target: hit.browserTarget,
        liffId: hit.liffId,
        recordUrl: '/ce/' + flow.id + '/' + req.params.source + '/hit'
      });
    } catch (err) {
      console.error('campaign bounce error:', err && err.message);
      return res.redirect(fallback);
    }
  }));

  const campaignHitPaths = ['/ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)/hit',
                            '/games/ce/:id(\\d+)/:source(richmenu|broadcast|welcome|other)/hit'];
  campaignHitPaths.forEach(pth => app.post(pth, async (req, res) => {
    try {
      const flowId = Number(req.params.id);
      const source = String(req.params.source || 'other');
      const rs = await query(
        `SELECT id, name, status, trigger_type, trigger_config FROM admin_flows
          WHERE id = $1 AND trigger_type = 'campaign_open' LIMIT 1`,
        [flowId]
      );
      const flow = rs.rows[0];
      const hit = campaignTarget(flow);
      if (!hit || !hit.liffId) return res.json({ ok: true, skipped: true });
      const idToken = String((req.body || {}).id_token || '').trim();
      const verified = await verifyCampaignToken(idToken, channelIdFromLiffId(hit.liffId));
      const uid = verified && verified.ok && /^U[0-9a-f]{32}$/i.test(String(verified.sub || ''))
        ? String(verified.sub) : null;
      if (!uid) return res.status(401).json({ ok: false, error: 'identity_verification_failed' });

      const key = flowId + ':' + source + ':' + uid;
      const now = Date.now();
      const last = campaignSeen.get(key);
      if (last && now - last <= 60 * 1000) return res.json({ ok: true, deduped: true });
      campaignSeen.set(key, now);
      if (campaignSeen.size > 5000) {
        for (const [k, v] of campaignSeen) if (now - v > 60 * 1000) campaignSeen.delete(k);
      }

      await query(
        `INSERT INTO message_taps (source, ref_id, label, target_url, line_user_id)
         VALUES ('campaign', $1, $2, $3, $4)`,
        [String(flowId) + '_' + source, hit.label, hit.target, uid]
      );
      if (flowEngine && typeof flowEngine.triggerCampaignOpen === 'function') {
        await flowEngine.triggerCampaignOpen({ flowId, lineUserId: uid, source });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('campaign hit error:', err && err.message);
      return res.json({ ok: true });
    }
  }));

  // ---------- 步驟樹 → 節點 ----------
  function flattenSteps(steps) {
    let counter = 0;
    const nodes = [];
    function newKey() { counter++; return 'n' + counter; }
    function build(stepList) {
      if (!Array.isArray(stepList) || stepList.length === 0) return null;
      let firstKey = null;
      let prev = null;
      for (const step of stepList) {
        if (!step || !step.type) continue;
        const key = newKey();
        const node = {
          node_key: key, type: step.type, config: {},
          next_key: null, branch_true_key: null, branch_false_key: null,
          is_entry: false, position: nodes.length
        };
        if (step.type === 'send') {
          node.config = { message_id: Number(step.message_id) || null };
        } else if (step.type === 'wait') {
          node.config = { amount: Number(step.amount) || 0, unit: step.unit || 'days' };
        } else if (step.type === 'add_to_list') {
          node.config = { list_id: Number(step.list_id) || null };
        } else if (step.type === 'branch') {
          node.config = { condition: step.condition || {} };
        } else {
          continue;
        }
        nodes.push(node);
        if (!firstKey) firstKey = key;
        if (prev) prev.next_key = key;
        if (step.type === 'branch') {
          node.branch_true_key = build(step.yes);
          node.branch_false_key = build(step.no);
          prev = null; // 分支為主序列終點
          break;
        }
        prev = node;
      }
      return firstKey;
    }
    const entryKey = build(steps);
    const entry = nodes.find(n => n.node_key === entryKey);
    if (entry) entry.is_entry = true;
    return { nodes, entryKey };
  }

  // ---------- 節點 → 步驟樹 ----------
  function unflattenNodes(nodes) {
    const byKey = {};
    nodes.forEach(n => { byKey[n.node_key] = n; });
    const entry = nodes.find(n => n.is_entry) || nodes[0];
    function walk(startKey) {
      const steps = [];
      let key = startKey;
      const seen = new Set();
      while (key && byKey[key] && !seen.has(key)) {
        seen.add(key);
        const n = byKey[key];
        if (n.type === 'send') {
          steps.push({ type: 'send', message_id: n.config && n.config.message_id });
          key = n.next_key;
        } else if (n.type === 'wait') {
          steps.push({ type: 'wait', amount: n.config && n.config.amount, unit: n.config && n.config.unit });
          key = n.next_key;
        } else if (n.type === 'add_to_list') {
          steps.push({ type: 'add_to_list', list_id: n.config && n.config.list_id });
          key = n.next_key;
        } else if (n.type === 'branch') {
          steps.push({
            type: 'branch',
            condition: n.config && n.config.condition,
            yes: walk(n.branch_true_key),
            no: walk(n.branch_false_key)
          });
          key = null;
        } else {
          key = n.next_key;
        }
      }
      return steps;
    }
    return walk(entry ? entry.node_key : null);
  }

  function validateFlow(body) {
    const name = String(body.name || '').trim();
    if (!name) return { ok: false, error: 'name_required' };
    const trigger = body.trigger || {};
    const tType = trigger.type;
    if (!['follow', 'list_join', 'event', 'schedule', 'game_play', 'broadcast_click', 'restaurant_click', 'inactivity', 'streak_risk', 'rich_menu_tap', 'campaign_open'].includes(tType)) return { ok: false, error: 'invalid_trigger_type' };
    const tCfg = trigger.config || {};
    const rawUserLimit = tCfg.user_limit;
    if (rawUserLimit && typeof rawUserLimit === 'object' && rawUserLimit.max !== '' && rawUserLimit.max != null) {
      const max = Math.round(Number(rawUserLimit.max));
      if (!Number.isFinite(max) || max < 1 || max > 1000) return { ok: false, error: 'invalid_user_trigger_limit' };
      const window = ['lifetime', 'day', '7d', '30d'].includes(rawUserLimit.window)
        ? rawUserLimit.window
        : 'lifetime';
      tCfg.user_limit = { max, window };
    } else {
      delete tCfg.user_limit;
    }
    if (tType === 'list_join' && !(Number(tCfg.list_id) > 0)) return { ok: false, error: 'list_join_needs_list' };
    if (tType === 'rich_menu_tap') {
      if (!(Number(tCfg.menu_id) > 0)) return { ok: false, error: 'rich_menu_tap_needs_menu' };
      tCfg.menu_id = Number(tCfg.menu_id);
      tCfg.match = tCfg.match === 'selected' ? 'selected' : 'any';
      const seen = new Set();
      tCfg.buttons = (Array.isArray(tCfg.buttons) ? tCfg.buttons : []).map(b => ({
        tab: Math.max(0, Math.round(Number(b && b.tab) || 0)),
        cell: Math.max(0, Math.round(Number(b && b.cell) || 0))
      })).filter(b => {
        const key = b.tab + ':' + b.cell;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 20);
      if (tCfg.match === 'selected' && tCfg.buttons.length === 0) {
        return { ok: false, error: 'rich_menu_tap_needs_button' };
      }
    }
    if (tType === 'campaign_open') {
      const campaignName = String(tCfg.campaign_name || '').trim().slice(0, 100);
      const targetUrl = cleanHttpsUrl(tCfg.target_url);
      if (!campaignName) return { ok: false, error: 'campaign_open_needs_name' };
      if (!targetUrl) return { ok: false, error: 'campaign_open_needs_url' };
      tCfg.campaign_name = campaignName;
      tCfg.target_url = targetUrl;
      if (Number(tCfg.activity_id) > 0) tCfg.activity_id = Number(tCfg.activity_id);
      else delete tCfg.activity_id;
    }
    if (tType === 'event' && !String(tCfg.event_name || '').trim()) return { ok: false, error: 'event_needs_name' };
    if (tType === 'follow') {
      // 來源代號：空 = 通用流程（對所有新好友觸發）；有值 = 只對該來源的新好友觸發。
      // 必須嚴格擋下「非空但含不合法字元」（例如填中文）：若靜默過濾成空字串，
      // 這條「某活動專屬」流程會悄悄變成通用流程 → 對每個新好友都發，
      // 直接違反「無來源者不發歡迎訊息」的設定，且後台完全沒有提示。
      const raw = String(tCfg.source_key || '').trim();
      if (raw) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(raw)) return { ok: false, error: 'follow_source_invalid' };
        tCfg.source_key = raw.toLowerCase();
      } else {
        delete tCfg.source_key;
      }
    }
    // game_play / broadcast_click：無必填設定（活動可選任一、推播點擊任意）
    if (tType === 'restaurant_click') {
      // cuisine 白名單正規化（空值 = 不限種類，任何餐廳都觸發）
      const cz = String(tCfg.cuisine || '').trim();
      if (FLOW_CUISINES.includes(cz)) tCfg.cuisine = cz; else delete tCfg.cuisine;
    }
    if (tType === 'inactivity') {
      const d = Math.round(Number(tCfg.days));
      if (!Number.isFinite(d) || d < 7) return { ok: false, error: 'inactivity_needs_days' };
      tCfg.days = Math.min(3650, d);
      const bl = Math.round(Number(tCfg.batch_limit));
      tCfg.batch_limit = Number.isFinite(bl) && bl > 0 ? Math.min(500, bl) : 50;
      // 沉睡者在流程跑完後通常仍符合「沉睡」條件；若允許重入，排程會反覆轟炸。
      tCfg.user_limit = { max: 1, window: 'lifetime' };
    }
    if (tType === 'streak_risk') {
      const ms = Math.round(Number(tCfg.min_streak));
      tCfg.min_streak = Number.isFinite(ms) && ms >= 2 ? Math.min(30, ms) : 2;
      const bl2 = Math.round(Number(tCfg.batch_limit));
      tCfg.batch_limit = Number.isFinite(bl2) && bl2 > 0 ? Math.min(500, bl2) : 50;
      tCfg.hour_start = 19; tCfg.hour_end = 21; // 固定晚間提醒時窗，UI 不開放（保持簡單）
    }
    if (tType === 'schedule') {
      if (!Number.isFinite(Number(tCfg.hour))) return { ok: false, error: 'schedule_needs_hour' };
      // 正規化：對齊 */5 cron、避開 23:56-23:59 死區、夾正範圍
      tCfg.hour = Math.min(23, Math.max(0, Math.round(Number(tCfg.hour))));
      const mm = Number.isFinite(Number(tCfg.minute)) ? Number(tCfg.minute) : 0;
      tCfg.minute = Math.min(55, Math.max(0, Math.round(mm / 5) * 5));
      if (tCfg.freq === 'monthly') tCfg.dom = Math.min(31, Math.max(1, Math.round(Number(tCfg.dom) || 1)));
      if (tCfg.freq === 'weekly') {
        const dow = Number(tCfg.dow);
        tCfg.dow = Number.isFinite(dow) ? ((Math.round(dow) % 7) + 7) % 7 : 1;
      }
    }
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (steps.length === 0) return { ok: false, error: 'need_at_least_one_step' };
    // 至少要有一個動作（發訊息 或 加入名單）
    function hasAction(list) {
      return (list || []).some(s => s.type === 'send' || s.type === 'add_to_list' || (s.type === 'branch' && (hasAction(s.yes) || hasAction(s.no))));
    }
    if (!hasAction(steps)) return { ok: false, error: 'need_at_least_one_action' };
    // branch 只能是主序列最後一步（flattenSteps 遇 branch 會 break，後面的步驟會被丟棄）
    const branchIdx = steps.findIndex(s => s && s.type === 'branch');
    if (branchIdx !== -1 && branchIdx !== steps.length - 1) return { ok: false, error: 'branch_must_be_last' };
    // branch 的 yes/no 內只允許 send/wait（與 flatten/unflatten 假設一致）
    for (const s of steps) {
      if (s && s.type === 'branch') {
        const subOk = list => (list || []).every(x => x && (x.type === 'send' || x.type === 'wait'));
        if (!subOk(s.yes) || !subOk(s.no)) return { ok: false, error: 'branch_sub_only_send_wait' };
      }
    }
    // 所有 send 步驟（含 branch 內）都必須綁訊息，否則執行時會靜默跳過
    let sendMissing = false;
    (function eachSend(list) {
      (list || []).forEach(s => {
        if (!s) return;
        if (s.type === 'send') { if (!(Number(s.message_id) > 0)) sendMissing = true; }
        else if (s.type === 'branch') { eachSend(s.yes); eachSend(s.no); }
      });
    })(steps);
    if (sendMissing) return { ok: false, error: 'send_needs_message' };
    // 「加入名單」沒選名單一樣是靜默空轉，比照 send 檢查
    if (steps.some(s => s && s.type === 'add_to_list' && !(Number(s.list_id) > 0))) {
      return { ok: false, error: 'add_to_list_needs_list' };
    }
    // 有設定週期上限，或上限大於一次時，必須允許前一輪結束後再進入；
    // 真正的次數仍由 flowEngine 的 user_limit 擋住。
    const userLimit = tCfg.user_limit;
    const reEnroll = userLimit
      ? (userLimit.window !== 'lifetime' || userLimit.max > 1)
      : !!body.re_enroll;
    return { ok: true, name, trigger: { type: tType, config: tCfg }, steps, re_enroll: reEnroll };
  }

  async function writeNodes(client, flowId, steps) {
    await client.query('DELETE FROM admin_flow_nodes WHERE flow_id = $1', [flowId]);
    const { nodes } = flattenSteps(steps);
    for (const n of nodes) {
      await client.query(
        `INSERT INTO admin_flow_nodes
           (flow_id, node_key, type, config, next_key, branch_true_key, branch_false_key, is_entry, position)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
        [flowId, n.node_key, n.type, JSON.stringify(n.config), n.next_key, n.branch_true_key, n.branch_false_key, n.is_entry, n.position]
      );
    }
  }

  // ---------- 頁面 ----------
  app.get('/admin/flows', requireAdmin, (req, res) => {
    res.render('admin_flows', {
      title: '自動化流程',
      bodyClass: 'admin-shell flows-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // ---------- options（下拉資料） ----------
  app.get('/admin/flows/api/options', requireAdmin, async (_req, res) => {
    try {
      const [msgs, lists, acts, menus] = await Promise.all([
        query(`SELECT id, name FROM admin_message_templates WHERE COALESCE(channel, 'line') = 'line' ORDER BY id DESC`),
        query(`SELECT id, name FROM admin_recipient_lists ORDER BY id DESC`),
        query(`SELECT id, name, slug, game_type, status, liff_id_override FROM activities ORDER BY id DESC`),
        query(`SELECT id, name, status, published_at, published_config
               FROM rich_menus WHERE status = 'published' AND published_config IS NOT NULL
               ORDER BY is_default DESC, published_at DESC NULLS LAST, id DESC`)
      ]);
      const richMenus = menus.rows.map(m => ({
        id: m.id,
        name: m.name,
        status: m.status,
        published_at: m.published_at,
        buttons: normalizeTabs(m.published_config || {}).flatMap((tab, tabIndex) =>
          (tab.buttons || []).map((button, cellIndex) => ({
            tab: tabIndex,
            cell: cellIndex,
            label: String((button && button.label) || ('第 ' + (cellIndex + 1) + ' 顆按鈕')),
            action_type: button && button.action && button.action.type,
            // 不能只看舊版數字：過去曾出現 version 已增加、但只有部分按鈕有包裝的資料。
            // 只有這個明確模式標記才代表所有 URI 都已走安全跳板。
            needs_republish: !!(button && button.action && button.action.type === 'uri' &&
              m.published_config.tap_tracking_mode !== 'all_verified_v1')
          })).filter(b => b.action_type === 'uri' || b.action_type === 'message')
        )
      }));
      return res.json({
        ok: true,
        messages: msgs.rows,
        lists: lists.rows,
        activities: acts.rows.map(a => {
          const lid = String(a.liff_id_override || gamesLiffId() || '').trim();
          return {
            id: a.id, name: a.name, slug: a.slug, game_type: a.game_type, status: a.status,
            target_url: lid
              ? ('https://liff.line.me/' + lid + '/' + a.game_type + '/' + encodeURIComponent(a.slug))
              : (siteBase() ? siteBase() + '/games/' + encodeURIComponent(a.game_type) + '/' + encodeURIComponent(a.slug) : '')
          };
        }),
        rich_menus: richMenus,
        events: KNOWN_EVENTS,
        tracking_liff_id: gamesLiffId()
      });
    } catch (err) {
      return jsonErr(res, 500, 'options_failed', { detail: err && err.message });
    }
  });

  // ---------- 列表 ----------
  app.get('/admin/flows/api/list', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT f.id, f.name, f.status, f.trigger_type, f.trigger_config, f.re_enroll, f.updated_at,
                (SELECT COUNT(*) FROM admin_flow_enrollments e WHERE e.flow_id = f.id AND e.status = 'active')::int AS active_count,
                (SELECT COUNT(*) FROM admin_flow_enrollments e WHERE e.flow_id = f.id)::int AS total_count
         FROM admin_flows f ORDER BY f.id DESC`
      );
      return res.json({ ok: true, flows: rs.rows });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  // ---------- 健康狀態（讓 GM 看得到「漏人」） ----------
  // 卡住定義：active 但 next_run_at 已過期很久（預設超過 30 分鐘 = cron 跑 6 次都沒推進）。
  const STUCK_OVERDUE_MINUTES = 30;
  // node.type → 人話（讓 GM 看得懂卡在哪一步，不用懂 node_key）
  function nodeTypeLabel(type) {
    return ({ send: '發訊息', wait: '等待', branch: '條件分支', add_to_list: '加入名單', end: '結束' })[type] || (type || '未知步驟');
  }
  app.get('/admin/flows/api/health', requireAdmin, async (_req, res) => {
    try {
      // 各流程：失敗數 + 卡住數（active 且過期超過門檻）
      const summary = await query(
        `SELECT f.id, f.name,
                COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed_count,
                COUNT(*) FILTER (
                  WHERE e.status = 'active'
                    AND e.next_run_at < now() - make_interval(mins => $1)
                )::int AS stuck_count
         FROM admin_flows f
         LEFT JOIN admin_flow_enrollments e ON e.flow_id = f.id
         GROUP BY f.id, f.name
         ORDER BY f.id DESC`,
        [STUCK_OVERDUE_MINUTES]
      );
      // 近期 failed 清單（最多 50 筆）：流程名、用戶（暱稱優先）、卡在哪步、錯誤、重試次數
      const recent = await query(
        `SELECT e.id, e.flow_id, f.name AS flow_name, e.line_user_id,
                COALESCE(NULLIF(BTRIM(u.line_display_name), ''), NULLIF(BTRIM(u.username), '')) AS display_name,
                e.current_node_key, n.type AS node_type,
                e.retry_count, e.last_error, e.updated_at
         FROM admin_flow_enrollments e
         JOIN admin_flows f ON f.id = e.flow_id
         LEFT JOIN users u ON u.line_user_id = e.line_user_id
         LEFT JOIN admin_flow_nodes n ON n.flow_id = e.flow_id AND n.node_key = e.current_node_key
         WHERE e.status = 'failed'
         ORDER BY e.updated_at DESC NULLS LAST, e.id DESC
         LIMIT 50`
      );
      const recentRows = recent.rows.map(r => ({
        id: r.id,
        flow_id: r.flow_id,
        flow_name: r.flow_name,
        user: r.display_name || r.line_user_id || '（未知用戶）',
        step_label: nodeTypeLabel(r.node_type),
        retry_count: Number(r.retry_count) || 0,
        last_error: r.last_error || '',
        updated_at: r.updated_at
      }));
      return res.json({ ok: true, flows: summary.rows, recentFailed: recentRows, stuckOverdueMinutes: STUCK_OVERDUE_MINUTES });
    } catch (err) {
      return jsonErr(res, 500, 'health_failed', { detail: err && err.message });
    }
  });

  // ---------- 重試這個流程的所有 failed ----------
  // 把 failed 的 enrollment 設回 active、next_run_at = now()、retry_count 歸 0、清 last_error。
  // 下個 cron tick（或按「手動推進一次」）就會重新嘗試發送。
  app.post('/admin/flows/api/:id/retry-failed', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const rs = await query(
        `UPDATE admin_flow_enrollments
         SET status = 'active', next_run_at = now(), retry_count = 0, last_error = NULL, updated_at = now()
         WHERE flow_id = $1 AND status = 'failed'
         RETURNING id`,
        [Number(idStr)]
      );
      return res.json({ ok: true, retried: rs.rowCount });
    } catch (err) {
      return jsonErr(res, 500, 'retry_failed_failed', { detail: err && err.message });
    }
  });

  // ---------- 單一 ----------
  app.get('/admin/flows/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const fr = await query(`SELECT * FROM admin_flows WHERE id = $1`, [Number(idStr)]);
      if (fr.rowCount === 0) return jsonErr(res, 404, 'not_found');
      const nr = await query(`SELECT * FROM admin_flow_nodes WHERE flow_id = $1 ORDER BY position ASC`, [Number(idStr)]);
      const flow = fr.rows[0];
      let sourceCounts = [];
      if (flow.trigger_type === 'campaign_open') {
        const sc = await query(
          `SELECT COALESCE(NULLIF(context->>'source', ''), 'direct') AS source, COUNT(*)::int AS count
             FROM admin_flow_enrollments WHERE flow_id = $1
            GROUP BY 1 ORDER BY count DESC, source ASC`,
          [Number(idStr)]
        );
        sourceCounts = sc.rows;
      }
      return res.json({
        ok: true,
        flow: {
          id: flow.id, name: flow.name, status: flow.status, re_enroll: flow.re_enroll,
          trigger: { type: flow.trigger_type, config: flow.trigger_config },
          steps: unflattenNodes(nr.rows),
          tracking_links: campaignTrackingLinks(flow),
          source_counts: sourceCounts
        }
      });
    } catch (err) {
      return jsonErr(res, 500, 'get_failed', { detail: err && err.message });
    }
  });

  // ---------- 新增 ----------
  app.post('/admin/flows/api', requireAdmin, async (req, res) => {
    const v = validateFlow(req.body || {});
    if (!v.ok) return jsonErr(res, 400, v.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const createdBy = (req.authUser && req.authUser.un) || 'admin';
      const fr = await client.query(
        `INSERT INTO admin_flows (name, status, trigger_type, trigger_config, re_enroll, created_by)
         VALUES ($1, 'draft', $2, $3::jsonb, $4, $5) RETURNING id`,
        [v.name, v.trigger.type, JSON.stringify(v.trigger.config), v.re_enroll, createdBy]
      );
      const flowId = fr.rows[0].id;
      await writeNodes(client, flowId, v.steps);
      await client.query('COMMIT');
      return res.json({ ok: true, id: flowId });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return jsonErr(res, 500, 'create_failed', { detail: err && err.message });
    } finally {
      client.release();
    }
  });

  // ---------- 更新 ----------
  app.put('/admin/flows/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    const v = validateFlow(req.body || {});
    if (!v.ok) return jsonErr(res, 400, v.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const up = await client.query(
        `UPDATE admin_flows SET name = $2, trigger_type = $3, trigger_config = $4::jsonb, re_enroll = $5, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [Number(idStr), v.name, v.trigger.type, JSON.stringify(v.trigger.config), v.re_enroll]
      );
      if (up.rowCount === 0) { await client.query('ROLLBACK'); return jsonErr(res, 404, 'not_found'); }
      await writeNodes(client, Number(idStr), v.steps);
      await client.query('COMMIT');
      return res.json({ ok: true, id: Number(idStr) });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return jsonErr(res, 500, 'update_failed', { detail: err && err.message });
    } finally {
      client.release();
    }
  });

  // ---------- 狀態（啟用/暫停/草稿） ----------
  app.post('/admin/flows/api/:id/status', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    const status = (req.body && req.body.status) || '';
    if (!['draft', 'active', 'paused'].includes(status)) return jsonErr(res, 400, 'invalid_status');
    try {
      // 啟用前確認有節點
      if (status === 'active') {
        const nc = await query(`SELECT COUNT(*)::int AS n FROM admin_flow_nodes WHERE flow_id = $1`, [Number(idStr)]);
        if (Number(nc.rows[0].n) === 0) return jsonErr(res, 400, 'flow_has_no_steps');
      }
      const rs = await query(
        `UPDATE admin_flows SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status`,
        [Number(idStr), status]
      );
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, status: rs.rows[0].status });
    } catch (err) {
      return jsonErr(res, 500, 'status_failed', { detail: err && err.message });
    }
  });

  // ---------- 刪除 ----------
  app.delete('/admin/flows/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const existing = await query(`SELECT trigger_type, status FROM admin_flows WHERE id = $1`, [Number(idStr)]);
      if (existing.rows[0] && existing.rows[0].trigger_type === 'campaign_open' && existing.rows[0].status !== 'draft') {
        return jsonErr(res, 400, 'campaign_flow_use_pause', {
          detail: '這個流程的入口網址可能已放在對外訊息中。請改用「暫停」，避免舊網址失效。'
        });
      }
      const rs = await query(`DELETE FROM admin_flows WHERE id = $1 RETURNING id`, [Number(idStr)]);
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, deletedId: Number(idStr) });
    } catch (err) {
      return jsonErr(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // ---------- 乾跑測試（啟用前用自己的 LINE 試走一遍） ----------
  // body { test_line_user_id }：依該流程節點同步走一遍，實際發訊息「給測試者本人」，
  // 回傳逐步報告。全程不建 enrollment、不寫 cursor、不改任何狀態。
  app.post('/admin/flows/api/:id/dry-run', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    const testLineUserId = String((req.body && req.body.test_line_user_id) || '').trim();
    if (!testLineUserId) return jsonErr(res, 400, 'dryrun_needs_test_user');
    try {
      const result = await flowEngine.dryRunFlow({ flowId: Number(idStr), testLineUserId });
      return res.json({ ok: true, ...result });
    } catch (err) {
      // 設定類錯誤（流程不存在、沒步驟）→ 回 400 給前端顯示人話
      if (err && err.permanent) return jsonErr(res, 400, err.message || 'dryrun_failed');
      return jsonErr(res, 500, 'dryrun_failed', { detail: err && err.message });
    }
  });

  // ---------- cron 推進 ----------
  app.post('/admin/flows/run', async (req, res) => {
    const expectedSecret = process.env.SCHEDULED_RUNNER_SECRET || '';
    const providedSecret = req.get('x-scheduler-secret') || '';
    if (!expectedSecret || providedSecret !== expectedSecret) return jsonErr(res, 403, 'forbidden');
    try {
      const result = await flowEngine.run();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('flows run error:', err && (err.stack || err.message));
      return jsonErr(res, 500, 'run_failed', { detail: err && err.message });
    }
  });

  // ---------- admin 手動推進（測試） ----------
  if (requireAdmin) {
    app.post('/admin/flows/run-now', requireAdmin, async (_req, res) => {
      try {
        const result = await flowEngine.run();
        return res.json({ ok: true, ...result });
      } catch (err) {
        return jsonErr(res, 500, 'run_failed', { detail: err && err.message });
      }
    });
  }
}

module.exports = { registerAdminFlowsRoutes };
