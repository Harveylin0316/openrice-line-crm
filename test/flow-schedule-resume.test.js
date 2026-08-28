// 定時流程一次要加幾千人，但 serverless 十秒就會被砍。
// 分批＋續跑：這一輪加不完，下一輪自動接著加，直到全部加完才標記完成。
// 原本是「先標記已跑過、再一次加完」→ 被砍在半路時剩下的人永遠補不回來。
const path = require('path');
const { createFlowEngine } = require(path.join(__dirname, '..', 'src/core/flowEngine'));
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// 假的資料庫：模擬 700 人的名單、記住誰已經被加進來
function makeDb(totalUsers) {
  const all = Array.from({ length: totalUsers }, (_, i) => ({
    user_id: i + 1, line_user_id: 'U' + String(i).padStart(32, '0')
  }));
  const state = { runs: new Map(), enrolled: new Set(), audienceQueries: [] };
  const query = async (sql, params) => {
    const f = String(sql).replace(/\s+/g, ' ');
    if (/FROM admin_flows WHERE status = 'active' AND trigger_type/.test(f))
      return { rows: [{ id: 9, name: '每週提醒', status: 'active', trigger_type: 'schedule',
        trigger_config: { freq: 'daily', hour: 10, minute: 0, audience: { type: 'all' } }, re_enroll: false }] };
    if (/INSERT INTO admin_flow_schedule_runs/.test(f)) {
      const k = params[0] + ':' + params[1];
      if (!state.runs.has(k)) state.runs.set(k, { completed_at: null, enrolled_count: 0 });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT completed_at/.test(f)) {
      const k = params[0] + ':' + params[1];
      const r = state.runs.get(k) || { completed_at: null, enrolled_count: 0 };
      return { rows: [r] };
    }
    if (/UPDATE admin_flow_schedule_runs/.test(f)) {
      const k = params[0] + ':' + params[2];
      state.runs.set(k, { completed_at: params[3] ? new Date() : null, enrolled_count: params[1] });
      return { rows: [] };
    }
    // 受眾：排除已加過的，取一批
    if (/FROM users u/.test(f) && /LIMIT/.test(f)) {
      const limit = params[2];
      state.audienceQueries.push(limit);
      const remain = all.filter(u => !state.enrolled.has(u.line_user_id)).slice(0, limit);
      return { rows: remain };
    }
    // enrollUser 內部三步：查有沒有加過 → 取入口節點 → 寫入
    if (/INSERT INTO admin_flow_enrollments/.test(f)) {
      if (state.enrolled.has(params[1])) return { rows: [], rowCount: 0 };
      state.enrolled.add(params[1]);
      return { rows: [{ id: state.enrolled.size }], rowCount: 1 };
    }
    if (/SELECT 1 FROM admin_flow_enrollments WHERE flow_id/.test(f)) {
      return state.enrolled.has(params[1]) ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/FROM admin_flow_nodes/.test(f))
      return { rows: [{ node_key: 'n1', type: 'send', config: {}, is_entry: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, state };
}

(async () => {
  const TOTAL = 700;                       // 超過一批（300）的量
  const db = makeDb(TOTAL);
  const engine = createFlowEngine({ query: db.query, pool: {},
    linePush: { pushLineMessages: async () => true }, buildLineMessages: () => ({ ok: true, messages: [] }) });

  // 排程時間到的那一刻（台北早上十點＝UTC 兩點）
  const at10 = new Date(Date.UTC(2026, 7, 26, 2, 5, 0));

  const n1 = await engine.runScheduleTriggers(at10);
  ok(n1 === 300, '第一輪只加一批（' + n1 + ' 人），不會硬跑完 700 人被時間上限砍掉');
  ok(db.state.enrolled.size === 300, '目前加了 300 人');
  const runKey = [...db.state.runs.keys()][0];
  ok(runKey && db.state.runs.get(runKey).completed_at === null,
     '還沒加完 → 不標記完成（這是能續跑的關鍵）');

  const n2 = await engine.runScheduleTriggers(at10);
  ok(n2 === 300 && db.state.enrolled.size === 600, '第二輪接著加，不會從頭再來（累計 600 人）');

  const n3 = await engine.runScheduleTriggers(at10);
  ok(n3 === 100 && db.state.enrolled.size === TOTAL, '第三輪把剩下的 100 人加完（全部 ' + TOTAL + ' 人一個不漏）');
  ok(db.state.runs.get(runKey).completed_at !== null, '全部加完才標記完成');

  const n4 = await engine.runScheduleTriggers(at10);
  ok(n4 === 0 && db.state.enrolled.size === TOTAL, '標記完成後不會再重複加（同一期間只發一次）');

  // 每一批都有帶上限，不會一次撈全部
  ok(db.state.audienceQueries.every(l => l === 300), '每次都只撈一批（不會一次撈幾千人）');

  console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n定時流程的分批續跑正確');
  process.exit(failed ? 1 : 0);
})();
