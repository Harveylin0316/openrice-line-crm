'use strict';
/**
 * 訊息成效（以「一則訊息」為一列）
 *
 * 指標定義（與頁面上的「指標定義」一致，改這裡要同步改頁面）
 *   收到人數   期間內送出、LINE 明確接受的不重複人數（同一人收到多次只算一次）。LINE 接受不代表已讀。
 *   點擊人數   收到的人當中，點過這則訊息「可追蹤連結」的不重複人數；同一人點多次、點多個連結只算一次。
 *   點擊次數   可追蹤連結被點的總次數（會重複算）。
 *   點擊率     點擊人數 ÷ 收到人數。沒有可追蹤連結 →「不適用」；還沒有人收到 →「尚無資料」。
 *   可追蹤連結 按鈕、卡片上的連結、滿版圖文的點擊區等「開啟網址」動作；傳送文字的按鈕不算。
 *              歡迎／自動化／關鍵字回覆另外也追蹤「文字訊息裡的網址」；群發與關鍵字 A/B 測試不追蹤文字裡的網址。
 *   時間       篩選「送出時間」（台灣時間，含起訖日）；這些訊息的點擊一路算到現在。
 *   計算依據   歡迎／自動化／關鍵字：經 LINE 驗證點擊者就是收件人才算。
 *              群發：依收件人專屬連結計算（與批次報表相同；連結被轉傳給別人點也會算進原收件人）。
 *              關鍵字 A/B 測試：依實驗設定，每人第一次成功回覆起的觀察期內才算。
 *
 * 一列＝同一來源、同一份內容（內容改過就是另一列）。A/B 的各版本放在 variants。
 */

const { parsePerformanceFilters } = require('./messagePerformance');
const { summarizeConfig, getBroadcastMessageIdentity } = require('./broadcastMessageSnapshot');
const { attributedClickWindow } = require('./keywordExperimentAttribution');
const { listBroadcastButtons } = require('./broadcastTemplates');

const TYPE_LABEL = { broadcast: '群發', keyword: '關鍵字回覆', welcome: '歡迎訊息', automation: '自動化' };
const MAX_ROWS = 300;

function rate(clickers, people, tracked) {
  if (!tracked) return null;
  if (!people) return null;
  return Math.round((clickers / people) * 1000) / 10;
}

/** 從訊息快照取一個看得懂的名稱、通知文字與縮圖 */
function describeSnapshot(cfg, origin) {
  let s = null;
  try { s = summarizeConfig(cfg || {}, { origin }); } catch (e) { s = null; }
  if (!s) return { title: '', notification: '', thumb: '', format: '' };
  const segs = Array.isArray(s.segments) ? s.segments : [];
  const pick = (k) => (s[k] || segs.map(x => x.summary && x.summary[k]).find(Boolean) || '');
  const firstText = (s.texts && s.texts[0]) || segs.map(x => x.summary && x.summary.texts && x.summary.texts[0]).find(Boolean) || '';
  const images = (s.images || []).concat(...segs.map(x => (x.summary && x.summary.images) || []));
  return {
    title: String(pick('title') || pick('notificationText') || firstText || '').slice(0, 120),
    notification: String(pick('notificationText') || '').slice(0, 200),
    thumb: images[0] || '',
    format: s.modeLabel || ''
  };
}

function baseRow(o) {
  const tracked = !!o.tracked;
  const people = Number(o.people || 0);
  const clickers = tracked ? Number(o.clickers || 0) : null;
  return {
    sends: Number(o.sends || 0),
    people,
    clickers,
    clicks: tracked ? Number(o.clicks || 0) : null,
    tracked,
    rate: rate(clickers || 0, people, tracked),
    failures: {
      rejected: Number(o.rejected || 0),
      uncertain: Number(o.uncertain || 0),
      skipped: Number(o.skipped || 0),
      pending: Number(o.pending || 0)
    }
  };
}

function sumRows(list) {
  const t = list.reduce((acc, r) => {
    acc.sends += r.sends; acc.people += r.people;
    if (r.tracked) { acc.trackedPeople += r.people; acc.clickers += r.clickers || 0; acc.clicks += r.clicks || 0; acc.tracked = true; }
    ['rejected', 'uncertain', 'skipped', 'pending'].forEach(k => { acc.failures[k] += r.failures[k] || 0; });
    return acc;
  }, { sends: 0, people: 0, trackedPeople: 0, clickers: 0, clicks: 0, tracked: false, failures: { rejected: 0, uncertain: 0, skipped: 0, pending: 0 } });
  return {
    sends: t.sends, people: t.people, tracked: t.tracked,
    clickers: t.tracked ? t.clickers : null, clicks: t.tracked ? t.clicks : null,
    rate: t.tracked && t.trackedPeople ? Math.round((t.clickers / t.trackedPeople) * 1000) / 10 : null,
    failures: t.failures
  };
}

function createMessagePerformanceList({ query }) {
  async function has(name) {
    const { rows } = await query('SELECT to_regclass($1) AS name', [name]);
    return !!(rows[0] && rows[0].name);
  }

  async function executionRows(f, origin) {
    if (f.source === 'broadcast' || !(await has('crm_message_executions'))) return [];
    const { rows } = await query(
      `SELECT e.source_type, e.source_id, e.revision,
              MIN(e.started_at) AS first_at, MAX(e.started_at) AS last_at,
              COUNT(*)::int AS sends,
              COUNT(*) FILTER (WHERE e.status = 'accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE e.status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE e.status IN ('uncertain', 'sending'))::int AS uncertain,
              COUNT(*) FILTER (WHERE e.status = 'skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE e.status = 'pending')::int AS pending,
              COUNT(DISTINCT e.recipient_key) FILTER (WHERE e.status = 'accepted')::int AS people,
              COUNT(DISTINCT e.recipient_key) FILTER (WHERE e.status = 'accepted' AND c.clicks > 0)::int AS clickers,
              COALESCE(SUM(c.clicks) FILTER (WHERE e.status = 'accepted'), 0)::int AS clicks,
              COALESCE(BOOL_OR(e.targets <> '[]'::jsonb AND COALESCE((e.targets->0->>'tracked')::boolean, false))
                       FILTER (WHERE e.status = 'accepted'), false) AS tracked,
              (ARRAY_AGG(e.message_snapshot ORDER BY e.id DESC))[1] AS snapshot
         FROM crm_message_executions e
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS clicks FROM crm_message_clicks k
            WHERE k.execution_id = e.id AND k.verified_identity = e.recipient_key
         ) c ON TRUE
        WHERE e.source_type <> 'broadcast' AND NOT e.test_only
          AND e.started_at >= $1::timestamptz AND e.started_at < $2::timestamptz
          AND ($3::text IS NULL OR e.source_type = $3)
        GROUP BY e.source_type, e.source_id, e.revision
        ORDER BY MAX(e.started_at) DESC
        LIMIT ${MAX_ROWS}`,
      [f.from, f.to, f.source]
    );
    const flowIds = [...new Set(rows.filter(r => r.source_type === 'automation').map(r => Number(r.source_id)))];
    const ruleIds = [...new Set(rows.filter(r => r.source_type === 'keyword').map(r => Number(r.source_id)))];
    const flows = {};
    const rules = {};
    if (flowIds.length) {
      try { (await query('SELECT id, name FROM admin_flows WHERE id = ANY($1::bigint[])', [flowIds])).rows.forEach(x => { flows[Number(x.id)] = x.name; }); } catch (e) { /* 名稱查不到就用編號 */ }
    }
    if (ruleIds.length) {
      try { (await query('SELECT id, keywords FROM admin_keyword_replies WHERE id = ANY($1::int[])', [ruleIds])).rows.forEach(x => { rules[Number(x.id)] = x.keywords; }); } catch (e) { /* 同上 */ }
    }
    return rows.map(r => {
      const d = describeSnapshot(r.snapshot, origin);
      const id = Number(r.source_id);
      const context = r.source_type === 'welcome' ? '加入好友時自動送出'
        : r.source_type === 'automation' ? '流程「' + (flows[id] || '#' + id) + '」'
        : r.source_type === 'keyword' ? '關鍵字「' + (rules[id] || '#' + id) + '」' : '';
      const link = r.source_type === 'welcome' ? '/admin/welcome-messages'
        : r.source_type === 'automation' ? '/admin/flows/' + id
        : r.source_type === 'keyword' ? '/admin/keyword-replies' : null;
      return Object.assign({
        key: [r.source_type, id, r.revision].join(':'),
        type: r.source_type, typeLabel: TYPE_LABEL[r.source_type], sourceId: id, revision: String(r.revision),
        title: d.title || '（沒有文字內容的訊息）', notification: d.notification, thumb: d.thumb, format: d.format,
        context, link, basis: 'verified', firstAt: r.first_at, lastAt: r.last_at, variants: []
      }, baseRow({ sends: r.sends, people: r.people, clickers: r.clickers, clicks: r.clicks, tracked: r.tracked,
        rejected: r.rejected, uncertain: r.uncertain, skipped: r.skipped, pending: r.pending }));
    });
  }

  async function broadcastRows(f, origin) {
    if (f.source && f.source !== 'broadcast') return [];
    const { rows: batches } = await query(
      `SELECT b.id, b.status, b.channel, b.is_ab_test, b.message_config, b.variant_b_message_config, b.audience_config,
              sent.first_at, sent.last_at
         FROM admin_broadcasts b
         JOIN LATERAL (
           SELECT MIN(r.pushed_at) AS first_at, MAX(r.pushed_at) AS last_at
             FROM admin_broadcast_recipients r WHERE r.broadcast_id = b.id
              AND r.pushed_at >= $1::timestamptz AND r.pushed_at < $2::timestamptz
              AND COALESCE(r.variant, 'a') IN ('a', 'b', 'c')
         ) sent ON sent.first_at IS NOT NULL
        WHERE COALESCE(b.channel, 'line') = 'line'
        ORDER BY sent.last_at DESC, b.id DESC LIMIT ${MAX_ROWS}`,
      [f.from, f.to]
    );
    if (!batches.length) return [];
    const ids = batches.map(b => Number(b.id));
    const { rows: stats } = await query(
      `SELECT r.broadcast_id, COALESCE(r.variant, 'a') AS variant,
              COUNT(*)::int AS sends,
              COUNT(*) FILTER (WHERE r.status = 'sent')::int AS accepted,
              COUNT(*) FILTER (WHERE r.status = 'failed')::int AS rejected,
              COUNT(*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE r.status IN ('pending', 'sending'))::int AS pending,
              COUNT(DISTINCT r.line_user_id) FILTER (WHERE r.status = 'sent')::int AS people,
              COUNT(DISTINCT r.line_user_id) FILTER (WHERE r.status = 'sent' AND c.clicks > 0)::int AS clickers,
              COALESCE(SUM(c.clicks) FILTER (WHERE r.status = 'sent'), 0)::int AS clicks
         FROM admin_broadcast_recipients r
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS clicks FROM admin_broadcast_clicks k
            WHERE k.broadcast_id = r.broadcast_id AND k.recipient_id = r.id
         ) c ON TRUE
        WHERE r.broadcast_id = ANY($1::bigint[])
          AND r.pushed_at >= $2::timestamptz AND r.pushed_at < $3::timestamptz
        GROUP BY r.broadcast_id, COALESCE(r.variant, 'a')`,
      [ids, f.from, f.to]
    );
    const byBatch = {};
    stats.forEach(s => { (byBatch[Number(s.broadcast_id)] = byBatch[Number(s.broadcast_id)] || []).push(s); });
    const out = [];
    for (const b of batches) {
      const list = (byBatch[Number(b.id)] || []).filter(s => ['a', 'b', 'c'].includes(s.variant)).sort((x, y) => x.variant.localeCompare(y.variant));
      if (!list.length) continue;
      const exp = b.audience_config && b.audience_config.experiment && b.audience_config.experiment.enabled === true ? b.audience_config.experiment : null;
      const cfgFor = (v) => (v === 'b' ? b.variant_b_message_config : v === 'c' ? exp && exp.variantCMessageConfig : b.message_config);
      let identity = {};
      try { identity = getBroadcastMessageIdentity(b, { origin }); } catch (e) { identity = {}; }
      const variants = list.map(s => {
        const cfg = cfgFor(s.variant) || b.message_config;
        let tracked = false;
        try { tracked = listBroadcastButtons(cfg, { heroImageBaseUrl: origin || 'https://example.invalid' }).length > 0; } catch (e) { tracked = false; }
        const d = describeSnapshot(cfg, origin);
        return Object.assign({ variant: s.variant, title: s.variant.toUpperCase() + ' 版', notification: d.notification, thumb: d.thumb },
          baseRow({ sends: s.sends, people: s.people, clickers: s.clickers, clicks: s.clicks, tracked,
            rejected: s.rejected, skipped: s.skipped, pending: s.pending }));
      });
      const first = describeSnapshot(b.message_config, origin);
      const multi = variants.length > 1 || !!b.is_ab_test || !!exp;
      out.push(Object.assign({
        key: 'broadcast:' + b.id, type: 'broadcast', typeLabel: TYPE_LABEL.broadcast, sourceId: Number(b.id),
        title: identity.title || first.title || '群發 #' + b.id,
        notification: identity.notificationText || first.notification, thumb: first.thumb, format: first.format,
        context: '批次 #' + b.id + (exp ? ' · Campaign Testing' : multi ? ' · A/B 測試' : ''),
        link: '/admin/broadcast/' + b.id, basis: 'recipient_link', firstAt: b.first_at, lastAt: b.last_at,
        variants: multi ? variants : []
      }, sumRows(variants)));
    }
    return out;
  }

  async function keywordExperimentRows(f, origin) {
    if ((f.source && f.source !== 'keyword') || !(await has('keyword_reply_experiments'))) return [];
    const { rows } = await query(
      `SELECT e.*, r.keywords FROM keyword_reply_experiments e
         LEFT JOIN admin_keyword_replies r ON r.id = e.rule_id
        WHERE e.start_at < $2::timestamptz AND e.end_at >= $1::timestamptz
        ORDER BY e.id DESC LIMIT 50`,
      [f.from, f.to]
    );
    const { experimentReport } = require('./keywordExperiments');
    const out = [];
    for (const exp of rows) {
      const rep = await experimentReport(query, exp);
      const variants = ['a', 'b'].map(v => {
        const x = rep.variants[v];
        const d = describeSnapshot(v === 'b' ? exp.variant_b_config : exp.variant_a_config, origin);
        return Object.assign({ variant: v, title: v.toUpperCase() + ' 版', notification: x.name || d.title, thumb: d.thumb },
          baseRow({ sends: x.triggers, people: x.reply_users, clickers: x.clickers, clicks: x.target_clicks, tracked: x.trackable,
            rejected: x.replies_failed, uncertain: x.replies_uncertain }));
      });
      const first = describeSnapshot(exp.variant_a_config, origin);
      out.push(Object.assign({
        key: 'keyword_ab:' + exp.id, type: 'keyword', typeLabel: TYPE_LABEL.keyword, sourceId: Number(exp.rule_id), experimentId: Number(exp.id),
        title: exp.name, notification: '', thumb: first.thumb, format: first.format,
        context: '關鍵字「' + (exp.keywords || '#' + exp.rule_id) + '」· A/B 測試',
        link: '/admin/keyword-replies', basis: 'experiment', attributionDays: exp.attribution_days,
        firstAt: exp.start_at, lastAt: exp.end_at, variants
      }, sumRows(variants)));
    }
    return out;
  }

  async function list(raw, origin) {
    const f = parsePerformanceFilters(raw);
    const all = []
      .concat(await executionRows(f, origin))
      .concat(await broadcastRows(f, origin))
      .concat(await keywordExperimentRows(f, origin));
    all.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    const rows = all.slice(0, MAX_ROWS);
    return { rows, truncated: all.length > MAX_ROWS, range: { from: f.from, to: f.to }, totals: sumRows(rows) };
  }

  /** 點一列：各連結點擊（次數與人數） */
  async function detail(raw, origin) {
    const type = String(raw.type || '');
    if (type === 'broadcast') {
      const id = Number(raw.sourceId);
      const f = parsePerformanceFilters(raw);
      const { rows } = await query(
        `SELECT id, message_config, variant_b_message_config, audience_config FROM admin_broadcasts WHERE id = $1`, [id]);
      const b = rows[0];
      if (!b) throw new Error('找不到這則群發');
      const exp = b.audience_config && b.audience_config.experiment && b.audience_config.experiment.enabled === true ? b.audience_config.experiment : null;
      const { rows: clicks } = await query(
        `SELECT COALESCE(r.variant, 'a') AS variant, COALESCE(k.button_index, 0) AS idx,
                COUNT(*)::int AS clicks, COUNT(DISTINCT r.line_user_id)::int AS people
           FROM admin_broadcast_clicks k
           JOIN admin_broadcast_recipients r ON r.id = k.recipient_id AND r.broadcast_id = k.broadcast_id
          WHERE k.broadcast_id = $1 AND r.status = 'sent'
            AND r.pushed_at >= $2::timestamptz AND r.pushed_at < $3::timestamptz
          GROUP BY 1, 2`, [id, f.from, f.to]);
      const out = [];
      for (const v of ['a', 'b', 'c']) {
        const cfg = v === 'a' ? b.message_config : v === 'b' ? b.variant_b_message_config : exp && exp.variantCMessageConfig;
        if (!cfg) continue;
        const buttons = listBroadcastButtons(cfg, { heroImageBaseUrl: origin || 'https://example.invalid' });
        out.push({ variant: v, links: buttons.map(btn => {
          const c = clicks.find(x => x.variant === v && Number(x.idx) === btn.index) || {};
          return { label: btn.label || '連結 ' + (btn.index + 1), uri: btn.uri, clicks: Number(c.clicks || 0), people: Number(c.people || 0) };
        }) });
      }
      return { groups: out };
    }
    if (type === 'keyword_ab') {
      const { rows } = await query('SELECT * FROM keyword_reply_experiments WHERE id = $1', [Number(raw.experimentId)]);
      const exp = rows[0];
      if (!exp) throw new Error('找不到這個 A/B 測試');
      const { rows: clicks } = await query(
        `SELECT k.variant, k.target_index AS idx, COUNT(*)::int AS clicks, COUNT(DISTINCT k.line_user_id)::int AS people
           FROM keyword_reply_experiment_clicks k
           JOIN keyword_reply_experiment_assignments a
             ON a.experiment_id = k.experiment_id AND a.variant = k.variant AND a.line_user_id = k.line_user_id
          WHERE k.experiment_id = $1 AND ${attributedClickWindow('$2')}
          GROUP BY 1, 2`, [exp.id, exp.attribution_days || 7]);
      return { groups: ['a', 'b'].map(v => ({ variant: v, links: ((exp.targets && exp.targets[v]) || []).map(t => {
        const c = clicks.find(x => x.variant === v && Number(x.idx) === Number(t.index)) || {};
        return { primary: ((exp.targets && exp.targets.primary && exp.targets.primary[v]) || []).map(Number).includes(Number(t.index)), label: t.label || '連結 ' + (Number(t.index) + 1), uri: t.uri, clicks: Number(c.clicks || 0), people: Number(c.people || 0) };
      }) })) };
    }
    if (!['welcome', 'automation', 'keyword'].includes(type)) throw new Error('來源不正確');
    if (!/^\d{1,20}$/.test(String(raw.revision || ''))) throw new Error('內容版本不正確');
    const f = parsePerformanceFilters(raw);
    const { rows: latest } = await query(
      `SELECT targets FROM crm_message_executions
        WHERE source_type = $1 AND source_id = $2 AND revision = $3 AND NOT test_only
        ORDER BY id DESC LIMIT 1`, [type, Number(raw.sourceId), String(raw.revision)]);
    const targets = (latest[0] && Array.isArray(latest[0].targets)) ? latest[0].targets : [];
    const { rows: clicks } = await query(
      `SELECT k.action_index AS idx, COUNT(*)::int AS clicks, COUNT(DISTINCT e.recipient_key)::int AS people
         FROM crm_message_clicks k JOIN crm_message_executions e ON e.id = k.execution_id
        WHERE e.source_type = $1 AND e.source_id = $2 AND e.revision = $3 AND NOT e.test_only
          AND e.started_at >= $4::timestamptz AND e.started_at < $5::timestamptz
          AND e.status = 'accepted' AND k.verified_identity = e.recipient_key
        GROUP BY k.action_index`, [type, Number(raw.sourceId), String(raw.revision), f.from, f.to]);
    return { groups: [{ variant: null, links: targets.filter(t => t && t.tracked !== false).map(t => {
      const c = clicks.find(x => Number(x.idx) === Number(t.index)) || {};
      const label = t.label || (t.kind === 'text_url' ? '文字中的連結' : '連結') + ' ' + (Number(t.index) + 1);
      return { label, kind: t.kind || 'uri_action', uri: t.uri || t.url || '', clicks: Number(c.clicks || 0), people: Number(c.people || 0) };
    }) }] };
  }

  return { list, detail };
}

module.exports = { createMessagePerformanceList, describeSnapshot, TYPE_LABEL };
