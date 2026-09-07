const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowEngine } = require('../src/core/flowEngine');

function makeEngine() {
  const state = { active: false, sent: false, inserts: [], restarts: [], enrollmentCount: 0 };
  const flows = [
    { id: 21, name: '分享超有哩追蹤', status: 'active', trigger_type: 'campaign_open',
      trigger_config: { activity_id: 6, campaign_name: '分享超有哩', target_url: 'https://example.com/a',
        user_limit: { max: 2, window: 'lifetime' } }, re_enroll: true },
    { id: 22, name: '中秋追蹤', status: 'active', trigger_type: 'campaign_open',
      trigger_config: { campaign_name: '中秋開飯驚喜', target_url: 'https://example.com/b' }, re_enroll: false }
  ];
  const query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM admin_flows WHERE id = \$1 AND status = 'active'/.test(q)) {
      return { rows: flows.filter(f => f.id === Number(params[0]) && f.trigger_type === params[1]), rowCount: 1 };
    }
    if (/FROM admin_flows WHERE status = 'active' AND trigger_type/.test(q)) {
      return { rows: flows.filter(f => f.trigger_type === params[0]), rowCount: flows.length };
    }
    if (/FROM admin_flow_nodes/.test(q)) return { rows: [{ node_key: 'n1', type: 'wait', is_entry: true }], rowCount: 1 };
    if (/SELECT id FROM users/.test(q)) return { rows: [{ id: 99 }], rowCount: 1 };
    if (/UPDATE admin_flow_enrollments/.test(q) && /last_message_sent_at IS NULL/.test(q)) {
      if (state.active && !state.sent) {
        state.restarts.push(JSON.parse(params[3]));
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/COUNT\(\*\)::int AS n/.test(q)) return { rows: [{ n: state.enrollmentCount }], rowCount: 1 };
    if (/SELECT 1 FROM admin_flow_enrollments/.test(q)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO admin_flow_enrollments/.test(q)) {
      if (state.active) return { rows: [], rowCount: 0 };
      state.active = true;
      state.enrollmentCount++;
      state.inserts.push({ flowId: params[0], context: JSON.parse(params[4]) });
      return { rows: [{ id: state.inserts.length }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const engine = createFlowEngine({ query, pool: {}, linePush: {}, buildLineMessages: () => ({ ok: true, messages: [] }) });
  return { engine, state };
}

test('追蹤入口只觸發網址綁定的流程，並保留來源', async () => {
  const { engine, state } = makeEngine();
  const uid = 'U' + 'a'.repeat(32);
  const out = await engine.triggerCampaignOpen({ flowId: 22, lineUserId: uid, source: 'welcome' });
  assert.equal(out.matched, 1);
  assert.equal(out.enrolled, 1);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0].flowId, 22);
  assert.equal(state.inserts[0].context.source, 'welcome');
});

test('追蹤入口重複開啟只重設尚未送出的同一份倒數', async () => {
  const { engine, state } = makeEngine();
  const uid = 'U' + 'b'.repeat(32);
  await engine.triggerCampaignOpen({ flowId: 21, lineUserId: uid, source: 'broadcast' });
  const again = await engine.triggerCampaignOpen({ flowId: 21, lineUserId: uid, source: 'richmenu' });
  assert.equal(again.restarted, 1);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.restarts[0].source, 'richmenu');
});

test('CRM 活動原始網址可依 activity id 觸發，且不覆蓋剛記下的渠道來源', async () => {
  const { engine, state } = makeEngine();
  const uid = 'U' + 'c'.repeat(32);
  const first = await engine.triggerCampaignOpenByActivity({ activityId: 6, lineUserId: uid });
  assert.deepEqual(first, { matched: 1, enrolled: 1 });
  assert.equal(state.inserts[0].context.source, 'direct');
  const directAgain = await engine.triggerCampaignOpenByActivity({ activityId: 6, lineUserId: uid });
  assert.deepEqual(directAgain, { matched: 1, enrolled: 0 });
  assert.equal(state.restarts.length, 0, 'direct meta 不應洗掉既有入口來源或重新計時');
});

test('不同活動與不存在的流程不會誤觸發', async () => {
  const { engine, state } = makeEngine();
  const uid = 'U' + 'd'.repeat(32);
  assert.deepEqual(await engine.triggerCampaignOpenByActivity({ activityId: 999, lineUserId: uid }), { matched: 0, enrolled: 0 });
  assert.deepEqual(await engine.triggerCampaignOpen({ flowId: 999, lineUserId: uid, source: 'broadcast' }), { matched: 0, enrolled: 0, restarted: 0 });
  assert.equal(state.inserts.length, 0);
});
