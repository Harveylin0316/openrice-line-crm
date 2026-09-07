const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowEngine } = require('../src/core/flowEngine');

function makeEngine(triggerConfig) {
  const state = { active: false, sent: false, inserted: 0, restarted: 0, contexts: [], enrollmentCount: 0, limitWindow: null };
  const flow = { id: 7, name: '圖文選單追蹤', status: 'active', trigger_type: 'rich_menu_tap',
    trigger_config: triggerConfig, re_enroll: true };
  const query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM admin_flows WHERE status = 'active' AND trigger_type/.test(q)) return { rows: [flow], rowCount: 1 };
    if (/FROM admin_flow_nodes/.test(q)) return { rows: [{ node_key: 'n1', type: 'wait', is_entry: true }], rowCount: 1 };
    if (/SELECT id FROM users/.test(q)) return { rows: [{ id: 99 }], rowCount: 1 };
    if (/UPDATE admin_flow_enrollments/.test(q) && /last_message_sent_at IS NULL/.test(q)) {
      if (state.active && !state.sent) {
        state.restarted++;
        state.contexts.push(JSON.parse(params[3]));
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/COUNT\(\*\)::int AS n FROM admin_flow_enrollments/.test(q)) {
      state.limitWindow = params[2];
      return { rows: [{ n: state.enrollmentCount }], rowCount: 1 };
    }
    if (/INSERT INTO admin_flow_enrollments/.test(q)) {
      if (state.active) return { rows: [], rowCount: 0 };
      state.active = true; state.inserted++; state.enrollmentCount++;
      state.contexts.push(JSON.parse(params[4]));
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    state,
    engine: createFlowEngine({ query, pool: {}, linePush: { pushLineMessages: async () => true },
      buildLineMessages: () => ({ ok: true, messages: [] }) })
  };
}

test('任一功能按鈕可觸發，重複點擊只重設同一份倒數', async () => {
  const t = makeEngine({ menu_id: 12, match: 'any', buttons: [] });
  const first = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 1,
    lineUserId: 'U' + 'a'.repeat(32), kind: 'link', label: '找餐廳' });
  assert.deepEqual(first, { matched: 1, enrolled: 1, restarted: 0 });
  const second = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 2,
    lineUserId: 'U' + 'a'.repeat(32), kind: 'message', label: '查詢訂位' });
  assert.deepEqual(second, { matched: 1, enrolled: 0, restarted: 1 });
  assert.equal(t.state.inserted, 1);
  assert.equal(t.state.restarted, 1);
  assert.equal(t.state.contexts[1].cell, 2, '重新計時後保留最後一次點擊的按鈕');
});

test('指定按鈕只接受相符 menu/tab/cell，分頁或其他按鈕不會誤觸發', async () => {
  const t = makeEngine({ menu_id: 12, match: 'selected', buttons: [{ tab: 1, cell: 3 }] });
  const wrongMenu = await t.engine.triggerRichMenuTap({ menuId: 11, tab: 1, cell: 3, lineUserId: 'U' + 'b'.repeat(32) });
  const wrongCell = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 1, cell: 2, lineUserId: 'U' + 'b'.repeat(32) });
  assert.equal(wrongMenu.matched, 0);
  assert.equal(wrongCell.matched, 0);
  assert.equal(t.state.inserted, 0);
  const hit = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 1, cell: 3, lineUserId: 'U' + 'b'.repeat(32) });
  assert.equal(hit.enrolled, 1);
});

test('已發過第一則訊息的 active 流程不會因連點而重播', async () => {
  const t = makeEngine({ menu_id: 12, match: 'any' });
  await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 0, lineUserId: 'U' + 'c'.repeat(32) });
  t.state.sent = true;
  const again = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 0, lineUserId: 'U' + 'c'.repeat(32) });
  assert.deepEqual(again, { matched: 1, enrolled: 0, restarted: 0 });
  assert.equal(t.state.inserted, 1);
});

test('每人最多兩次：完成兩輪後第三次會被擋住', async () => {
  const t = makeEngine({ menu_id: 12, match: 'any', user_limit: { max: 2, window: 'lifetime' } });
  const user = 'U' + 'd'.repeat(32);
  const first = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 0, lineUserId: user });
  t.state.active = false;
  const second = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 0, lineUserId: user });
  t.state.active = false;
  const third = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 0, lineUserId: user });
  assert.equal(first.enrolled, 1);
  assert.equal(second.enrolled, 1);
  assert.equal(third.enrolled, 0);
  assert.equal(t.state.inserted, 2);
  assert.equal(t.state.limitWindow, 'lifetime');
});

test('每天上限會使用台北日界線，而且等待中的連點只重設、不多扣一次', async () => {
  const t = makeEngine({ menu_id: 12, match: 'any', user_limit: { max: 1, window: 'day' } });
  const user = 'U' + 'e'.repeat(32);
  await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 0, lineUserId: user });
  const again = await t.engine.triggerRichMenuTap({ menuId: 12, tab: 0, cell: 1, lineUserId: user });
  assert.equal(again.restarted, 1);
  assert.equal(t.state.enrollmentCount, 1);
  assert.equal(t.state.limitWindow, 'day');
});
