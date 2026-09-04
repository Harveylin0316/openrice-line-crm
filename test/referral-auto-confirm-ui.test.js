const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/games-mgm.js'), 'utf8');

function boot({ serverChecks }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="status-row"></div></body></html>', {
    runScripts: 'dangerously',
    url: 'https://example.test/games/wheel/share-miles',
    beforeParse(w) {
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.requestAnimationFrame = (fn) => w.setTimeout(fn, 0);
    }
  });
  const w = dom.window;
  let friendshipChecks = 0;
  w.liff = {
    requestFriendship: async () => {},
    getFriendship: async () => { friendshipChecks++; return { friendFlag: true }; }
  };
  w.eval(source);
  let rechecks = 0;
  w.ORMGM.gate.init('https://line.me/R/ti/p/test', async () => {
    rechecks++;
    return serverChecks[Math.min(rechecks - 1, serverChecks.length - 1)];
  });
  w.ORMGM.gate.show('請先加入好友');
  return { w, get rechecks() { return rechecks; }, get friendshipChecks() { return friendshipChecks; } };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('按加入好友後會自動確認，不顯示「我加好了」步驟', async () => {
  const app = boot({ serverChecks: [true] });
  const doc = app.w.document;
  doc.getElementById('oa-gate-add').click();
  await tick();

  assert.equal(app.rechecks, 1);
  assert.equal(app.friendshipChecks, 1);
  assert.equal(doc.getElementById('oa-gate').hidden, true);
  assert.equal(doc.getElementById('oa-gate-done').textContent, '重新確認');
  assert.equal(doc.getElementById('oa-gate-done').hidden, true);
});

test('LINE 短暫延遲時會自動重查，成功前不要求使用者再按按鈕', async () => {
  const app = boot({ serverChecks: [false, true] });
  const doc = app.w.document;
  // 壓短測試用 timer；正式頁仍使用 700ms 起的漸進重試。
  const realSetTimeout = app.w.setTimeout.bind(app.w);
  app.w.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(Number(ms) || 0, 5));
  doc.getElementById('oa-gate-add').click();
  await tick(50);

  assert.equal(app.rechecks, 2);
  assert.equal(doc.getElementById('oa-gate').hidden, true);
  assert.equal(doc.getElementById('oa-gate-done').hidden, true);
});

test('使用者取消加入時不會誤加次數，只留下例外狀況的重新確認', async () => {
  const app = boot({ serverChecks: [false] });
  const doc = app.w.document;
  const realSetTimeout = app.w.setTimeout.bind(app.w);
  app.w.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(Number(ms) || 0, 3));
  app.w.liff.getFriendship = async () => ({ friendFlag: false });
  doc.getElementById('oa-gate-add').click();
  await tick(60);

  assert.equal(app.rechecks, 5);
  assert.equal(doc.getElementById('oa-gate').hidden, false);
  assert.equal(doc.getElementById('oa-gate-done').hidden, false);
  assert.match(doc.getElementById('oa-gate-text').textContent, /暫時還沒同步/);
});
