// 後台活動編輯頁：刮刮樂活動要顯示自己的畫面設定區，存檔要寫 rules.ui.scratch／copy，
// 而且不能把輪盤既有設定或其他人寫進 rules 的欄位洗掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const PRIZES = [
  { id: 31, name: '拿鐵買一送一', position: 1, is_grand_prize: false, description: '', image_url: null,
    probability_weight: 60, stock_total: null, stock_remaining: null, prize_type: 'coupon_code', prize_value: { code: 'LATTE', redeem_note: '出示畫面' } },
  { id: 32, name: '銘謝惠顧', position: 2, is_grand_prize: false, description: '', image_url: null,
    probability_weight: 40, stock_total: null, stock_remaining: null, prize_type: 'none', prize_value: {} }
];

async function openEditor(activityOverrides) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_edit.ejs'), {
    title: '編輯活動', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activityId: 9,
    gameTypes: ['wheel', 'scratch', 'claim'],
    statuses: ['draft', 'active', 'paused', 'ended'],
    prizeTypes: ['coupon_code', 'badge', 'none']
  }, { views: [path.join(REPO, 'views')] });
  const activity = Object.assign({
    id: 9, slug: 'summer-scratch', name: '夏日刮刮樂', description: '刮開就知道',
    game_type: 'scratch', status: 'active', start_at: null, end_at: null,
    cover_image_url: null, daily_plays_per_user: null, require_follow_oa: true,
    liff_id_override: null, base_plays_per_user: 2, referral_bonus_per: 1,
    referral_bonus_max: 3, referral_invites_per_bonus: 1,
    rules: {
      someone_elses_key: { keep: true },
      ui: {
        wheel_style: 'bold',
        scratch: { style: 'gold', ratio: '16:9', reveal_threshold: 50, show_stats: false },
        copy: { spin_button: '輪盤才有', stage_label: '刮一下', redemption_text: '到店出示' }
      }
    }
  }, activityOverrides || {});
  const writes = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/admin/activities/9',
    beforeParse(window) {
      window.fetch = async (url, options = {}) => {
        if (!options.method || options.method === 'GET') {
          return { json: async () => ({ ok: true, activity, prizes: PRIZES, effective_liff_id: 'test-liff' }) };
        }
        writes.push({ url, options, body: JSON.parse(options.body || '{}') });
        return { json: async () => ({ ok: true, activity: Object.assign({}, activity, JSON.parse(options.body || '{}')), prize: {} }) };
      };
      window.confirm = () => true;
      window.alert = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
    }
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  return { dom, document: dom.window.document, writes };
}

test('刮刮樂活動顯示刮刮樂設定區、隱藏輪盤設定，並帶入已存的值', async () => {
  const { dom, document } = await openEditor();
  assert.equal(document.getElementById('ae-scratch-editor').hidden, false);
  assert.equal(document.getElementById('ae-scratch-copy-editor').hidden, false);
  assert.equal(document.getElementById('ae-wheel-editor').hidden, true);
  assert.equal(document.getElementById('ae-wheel-copy-editor').hidden, true);
  assert.equal(document.getElementById('ae-scratch-style').value, 'gold');
  assert.equal(document.getElementById('ae-scratch-ratio').value, '16:9');
  assert.equal(document.getElementById('ae-scratch-threshold').value, '50');
  assert.equal(document.getElementById('ae-scratch-show-stats').checked, false);
  assert.equal(document.getElementById('ae-scratch-foil-1').value.toUpperCase(), '#FFE082');
  assert.equal(document.getElementById('ae-scopy-stage-label').value, '刮一下');
  assert.equal(document.getElementById('ae-scopy-redemption-text').value, '到店出示');
  // 情境選單：刮刮樂沒有「我的獎項」歷史
  const history = document.querySelector('#ae-preview-scenario option[value="history"]');
  assert.equal(history.hidden, true);
  // 預覽網址帶 scratch 設定，而且是安全預覽
  const frameSrc = document.getElementById('ae-preview-frame').getAttribute('src');
  assert.match(frameSrc, /\/games\/scratch\/summer-scratch\?/);
  assert.match(frameSrc, /preview=1/);
  const previewUi = JSON.parse(new URL(frameSrc).searchParams.get('preview_ui'));
  assert.equal(previewUi.scratch.style, 'gold');
  assert.equal(previewUi.copy.stage_label, '刮一下');
  // 訊息派送入口
  assert.equal(document.getElementById('ae-send-broadcast').getAttribute('href'), '/admin/broadcast?activity_id=9');
  dom.window.close();
});

test('儲存畫面設定只寫刮刮樂欄位，保留 rules 其他鍵與輪盤設定', async () => {
  const { dom, document, writes } = await openEditor();
  document.getElementById('ae-scratch-style').value = 'brand';
  document.getElementById('ae-scratch-style').dispatchEvent(new dom.window.Event('change'));
  document.getElementById('ae-scopy-share-cta').value = '來刮一張';
  document.getElementById('ae-scopy-redemption-text').value = '7 天內至門市兌換';
  document.getElementById('ae-save-visual').click();
  await new Promise(resolve => setTimeout(resolve, 60));
  const put = writes.find(w => w.options.method === 'PUT');
  assert.ok(put, '應送出 PUT');
  const rules = put.body.rules;
  assert.deepEqual(rules.someone_elses_key, { keep: true });
  assert.equal(rules.ui.wheel_style, 'bold');
  assert.equal(rules.ui.scratch.style, 'brand');
  assert.equal(rules.ui.scratch.custom.foil_1, '#FCC726');
  assert.equal(rules.ui.scratch.ratio, '16:9');
  assert.equal(rules.ui.scratch.reveal_threshold, 50);
  assert.equal(rules.ui.copy.spin_button, '輪盤才有');
  assert.equal(rules.ui.copy.share_cta, '來刮一張');
  assert.equal(rules.ui.copy.redemption_text, '7 天內至門市兌換');
  dom.window.close();
});

test('獎品編輯會把兌獎事項存進 prize_value.redeem_note，且不洗掉其他值', async () => {
  const { dom, document, writes } = await openEditor();
  const editBtn = document.querySelector('.ae-edit-prize[data-id="31"]');
  assert.ok(editBtn, '獎品列要有編輯鈕');
  editBtn.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.getElementById('pm-redeem-note').value, '出示畫面');
  document.getElementById('pm-redeem-note').value = '結帳前出示，每人一次';
  document.getElementById('pm-save').click();
  await new Promise(resolve => setTimeout(resolve, 60));
  const prizeWrite = writes.find(w => /\/prizes\/31$/.test(w.url));
  assert.ok(prizeWrite, '應送出獎品 PUT');
  assert.equal(prizeWrite.body.prize_value.redeem_note, '結帳前出示，每人一次');
  assert.equal(prizeWrite.body.prize_value.code, 'LATTE');
  dom.window.close();
});

test('輪盤活動仍只顯示輪盤設定區', async () => {
  const { dom, document } = await openEditor({ game_type: 'wheel' });
  assert.equal(document.getElementById('ae-scratch-editor').hidden, true);
  assert.equal(document.getElementById('ae-wheel-editor').hidden, false);
  dom.window.close();
});
