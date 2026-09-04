const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

test('活動成效查詢不再使用未分組的 activity_id，並讀得到新版里數欄位', () => {
  const source = fs.readFileSync(path.join(REPO, 'src/routes/mgmMiles.js'), 'utf8');
  assert.doesNotMatch(source, /p2\.activity_id\s*=\s*p\.activity_id/);
  assert.match(source, /prize_snapshot->'prize_value'->>'miles'/);
  assert.match(source, /prize_inventory:\s*prizeInventory/);
  assert.match(source, /COALESCE\(prize_snapshot->>'prize_type',''\) <> 'none'/);
});

test('活動成效頁同頁顯示分享超有哩 KPI、獎項庫存與得獎名單', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_mgm.ejs'), {
    title: '活動成效', user: 'admin', isAdmin: true, bodyClass: 'admin-shell mgm-shell'
  }, { views: [path.join(REPO, 'views')] });

  const payload = {
    ok: true,
    activities: [{ id: 6, name: '分享超有哩', game_type: 'wheel' }],
    activity: {
      id: 6, slug: 'share-miles', name: '分享超有哩', game_type: 'wheel', status: 'active',
      base_plays_per_user: 1, referral_bonus_per: 1, referral_invites_per_bonus: 1,
      referral_bonus_max: 3,
      stats: {
        referrals: 4, referrals_existing: 1, inviters: 2, people: 8,
        plays: 12, wins: 7, wins_pending: 3, miles_pending: 20000
      }
    },
    prize_inventory: [
      { id: 18, name: '【三獎】10,000 哩', prize_type: 'badge', stock_total: 11, stock_remaining: 9, drawn: 2, is_grand_prize: true },
      { id: 22, name: '銘謝惠顧', prize_type: 'none', stock_total: null, stock_remaining: null, drawn: 5, is_grand_prize: false }
    ],
    people: [{
      uid: 'U1234567890abcdef', display_name: 'Ice', wins: 2, wins_pending: 1,
      pending_prizes: '【三獎】10,000 哩', miles: 20000, miles_pending: 10000,
      miles_done: 10000, last_at: '2026-09-04T08:00:00Z'
    }],
    ledger: [{
      id: 1, line_user_id: 'U1234567890abcdef', display_name: 'Ice',
      prize_name: '【三獎】10,000 哩', prize_type: 'badge', miles: 10000,
      coupon_code: null, granted_done: false, played_at: '2026-09-04T08:00:00Z'
    }],
    inviters: [{ uid: 'U1234567890abcdef', display_name: 'Ice', new_friends: 4, existing_friends: 1, last_at: '2026-09-04T08:00:00Z' }],
    pairs: [{
      created_at: '2026-09-04T08:00:00Z', inviter_uid: 'U1234567890abcdef', inviter_name: 'Ice',
      invitee_uid: 'Uabcdef1234567890', invitee_name: 'Josh', was_existing: false
    }]
  };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/admin/mgm?activity_id=6',
    beforeParse(window) {
      window.fetch = async () => ({ json: async () => payload });
      window.confirm = () => true;
    }
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  const document = dom.window.document;
  assert.equal(document.querySelector('#mg-act option:checked').textContent, '分享超有哩（幸運轉盤）');
  assert.match(document.getElementById('mg-stats').textContent, /成功邀請新好友/);
  assert.match(document.getElementById('mg-stats').textContent, /20,000/);
  assert.equal(document.querySelectorAll('#mg-inventory .mg-prize').length, 2);
  assert.match(document.getElementById('mg-inventory').textContent, /剩餘/);
  assert.match(document.getElementById('mg-inventory').textContent, /設定總量 11/);
  assert.match(document.getElementById('mg-people').textContent, /Ice/);
  assert.match(document.getElementById('mg-people').textContent, /三獎/);
  dom.window.close();
});
