const { Pool } = require('pg');
const { createLinePushService } = require('./src/core/linePush');
const { createMgmMilesEngine } = require('./src/core/mgmMilesEngine');
const HEN = 'U5d8519f9913013fc46e89846bd665bb3';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  const query = (text, params) => pool.query(text, params);
  const linePush = createLinePushService({ query, lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
  const eng = createMgmMilesEngine({ query, linePush, liffId: process.env.GAMES_LIFF_ID });
  const r1 = await eng.onFollow(HEN, '林御恒 Hen');
  console.log('見面禮:', JSON.stringify(r1));
  const card = await eng.buildEntryCard(HEN);
  if (card) {
    const sent = await linePush.pushLineMessages(HEN, card, { pushType: 'mgm_entry' });
    console.log('分享卡推播:', sent ? '已送出' : '失敗');
  } else console.log('分享卡: 沒有進行中的活動');
  const { rows } = await query(
    `SELECT (prize_snapshot->>'miles')::int AS miles, prize_snapshot->>'milestone' AS m, played_at
       FROM activity_plays WHERE activity_id = (SELECT id FROM activities WHERE slug='mgm-miles')
        AND line_user_id = $1`, [HEN]);
  console.log('Hen 的里數帳本:', JSON.stringify(rows));
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
