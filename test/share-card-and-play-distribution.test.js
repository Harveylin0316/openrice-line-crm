'use strict';
// 1) 輪盤（分享超有哩）邀請朋友的 LINE 卡片可在後台設定：標題／說明／圖片／按鈕／文字版訊息
// 2) 玩家數據「抽獎次數分布」：1 抽／2 抽／3 抽／4 抽／5 抽以上各多少人，每格可建名單並帶去群發
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { registerAdminActivitiesRoutes } = require('../src/routes/adminActivities');

const REPO = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function renderWheelWithCopy(copy, cover) {
  const activity = {
    id: 6, slug: 'share-miles', name: '分享超有哩', description: '分享越多，機會越多',
    cover_image_url: cover || null, game_type: 'wheel', status: 'active', base_plays_per_user: 1,
    referral_bonus_per: 1, referral_bonus_max: 3, referral_invites_per_bonus: 1,
    rules: { ui: { copy: copy || {} } }
  };
  const html = await ejs.renderFile(path.join(REPO, 'views/game_wheel.ejs'), {
    title: '分享超有哩', activity, prizes: [{ id: 1, name: '獎', position: 1 }], liffId: 'test-liff', addFriendUrl: ''
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/games/wheel/share-miles?preview=1&preview_scenario=first_open',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ width: 10 }), set: () => true });
      window.fetch = () => Promise.reject(new Error('no api'));
    }
  });
  await wait(80);
  const captured = [];
  dom.window.__wheelCaptureShare = (x) => captured.push(x);
  dom.window.document.getElementById('invite-btn').click();
  await wait(20);
  return { dom, share: captured[0] };
}

test('分享超有哩：後台設定的卡片標題、說明、圖片、按鈕文字與文字版訊息會用在邀請卡片', async () => {
  const { dom, share } = await renderWheelWithCopy({
    share_card_title: '一起來轉，拿亞洲萬里通里數',
    share_card_desc: '加入 OpenRice 官方帳號就能轉',
    share_card_image: 'https://example.test/share.jpg',
    share_cta: '我要轉',
    share_message: '「{{name}}」快來！'
  }, 'https://example.test/cover.jpg');
  assert.ok(share, '應產生分享卡片');
  const bubble = share.flex.contents;
  assert.equal(bubble.body.contents[0].text, '一起來轉，拿亞洲萬里通里數');
  assert.equal(bubble.body.contents[1].text, '加入 OpenRice 官方帳號就能轉');
  assert.equal(bubble.hero.url, 'https://example.test/share.jpg');
  assert.equal(bubble.footer.contents[0].action.label, '我要轉');
  assert.match(bubble.footer.contents[0].action.uri, /\/wheel\/share-miles\?ref=/);
  assert.equal(share.text, '「分享超有哩」快來！');
  dom.window.close();
});

test('分享超有哩：沒設定時沿用活動名稱、說明、封面與「馬上玩」', async () => {
  const { dom, share } = await renderWheelWithCopy({}, 'https://example.test/cover.jpg');
  const bubble = share.flex.contents;
  assert.equal(bubble.body.contents[0].text, '分享超有哩');
  assert.equal(bubble.body.contents[1].text, '分享越多，機會越多');
  assert.equal(bubble.hero.url, 'https://example.test/cover.jpg');
  assert.equal(bubble.footer.contents[0].action.label, '馬上玩');
  assert.match(share.text, /快來玩「分享超有哩」/);
  dom.window.close();
});

test('後台輪盤文案區有「分享給朋友的 LINE 卡片」欄位與即時預覽', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_edit.ejs'), {
    title: '編輯活動', user: 'admin', isAdmin: true, bodyClass: 'admin-shell', activityId: 6,
    gameTypes: ['wheel', 'scratch'], statuses: ['draft', 'active'], prizeTypes: ['none']
  }, { views: [path.join(REPO, 'views')] });
  const activity = {
    id: 6, slug: 'share-miles', name: '分享超有哩', description: '分享越多', game_type: 'wheel', status: 'active',
    cover_image_url: 'https://example.test/cover.jpg', base_plays_per_user: 1, referral_bonus_per: 1,
    referral_bonus_max: 3, referral_invites_per_bonus: 1, rules: { ui: { copy: { share_cta: '我要轉' } } }
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/admin/activities/6',
    beforeParse(window) {
      window.fetch = async () => ({ json: async () => ({ ok: true, activity, prizes: [], effective_liff_id: 'L' }) });
      window.HTMLElement.prototype.scrollIntoView = () => {};
    }
  });
  await wait(150);
  const doc = dom.window.document;
  for (const id of ['ae-copy-share-card-title', 'ae-copy-share-card-desc', 'ae-copy-share-card-image', 'ae-copy-share-cta', 'ae-copy-share-message']) {
    assert.ok(doc.getElementById(id), id + ' 應存在');
  }
  assert.equal(doc.getElementById('ae-copy-share-cta').value, '我要轉');
  const preview = doc.querySelector('[data-share-preview="ae-copy"]');
  assert.equal(preview.querySelector('[data-share-preview-title]').textContent, '分享超有哩');
  assert.equal(preview.querySelector('[data-share-preview-cta]').textContent, '我要轉');
  doc.getElementById('ae-copy-share-card-title').value = '新標題';
  doc.getElementById('ae-copy-share-card-title').dispatchEvent(new dom.window.Event('input'));
  assert.equal(preview.querySelector('[data-share-preview-title]').textContent, '新標題');
  dom.window.close();
});

function routesWith(queryImpl) {
  const routes = {};
  const app = ['get', 'post', 'put', 'delete'].reduce((o, m) => { o[m] = (p, ...h) => { routes[m.toUpperCase() + ' ' + p] = h; }; return o; }, {});
  const inserted = { lists: [], members: [] };
  const client = {
    query: async (sql, params) => {
      const c = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO admin_recipient_lists/.test(c)) { inserted.lists.push(params); return { rows: [{ id: 77, name: params[0], total: params[2] }] }; }
      if (/INSERT INTO admin_recipient_list_members/.test(c)) { inserted.members.push(...params.filter((_, i) => i % 2 === 1)); return { rows: [] }; }
      return { rows: [] };
    },
    release() {}
  };
  registerAdminActivitiesRoutes(app, {
    query: queryImpl, pool: { connect: async () => client },
    authCore: { requireAdmin: (_q, _s, n) => n(), requireOwner: (_q, _s, n) => n() }
  });
  return { routes, inserted };
}
function res() {
  return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('匯出名單：剛好抽 N 次／抽 N 次以上，用同一個「實際抽獎次數」定義', async () => {
  const seen = [];
  const { routes, inserted } = routesWith(async (sql, params) => {
    seen.push({ sql: String(sql).replace(/\s+/g, ' '), params });
    return { rows: [{ line_user_id: 'U' + 'a'.repeat(32) }, { line_user_id: 'U' + 'b'.repeat(32) }] };
  });
  const handler = routes['POST /admin/activities/api/:id(\\d+)/export-players-to-list'];
  const r1 = res();
  await handler[handler.length - 1]({ params: { id: '6' }, body: { name: '分享超有哩｜2 抽', filter: 'plays_eq', plays: 2 }, authUser: { un: 'admin' } }, r1);
  assert.equal(r1.body.ok, true, JSON.stringify(r1.body));
  assert.equal(r1.body.total, 2);
  assert.match(seen[0].sql, /draw_win/);
  assert.match(seen[0].sql, /WHERE n = \$2/);
  assert.deepEqual(seen[0].params, [6, 2]);
  assert.equal(inserted.members.length, 2);

  const r2 = res();
  await handler[handler.length - 1]({ params: { id: '6' }, body: { name: '5 抽以上', filter: 'plays_gte', plays: 5 }, authUser: { un: 'admin' } }, r2);
  assert.match(seen[1].sql, /WHERE n >= \$2/);
  assert.deepEqual(seen[1].params, [6, 5]);

  const bad = res();
  await handler[handler.length - 1]({ params: { id: '6' }, body: { name: 'x', filter: 'plays_eq', plays: 0 }, authUser: { un: 'admin' } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'invalid_plays');
});

async function openPlayersPage(distribution) {
  const html = await ejs.renderFile(path.join(REPO, 'views/admin_activity_players.ejs'), {
    title: '玩家', user: 'admin', isAdmin: true, bodyClass: 'admin-shell',
    activity: { id: 6, name: '分享超有哩', game_type: 'wheel', base_plays_per_user: 1, referral_bonus_per: 1, referral_bonus_max: 3 }
  }, { views: [path.join(REPO, 'views')] });
  const posts = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/admin/activities/6/players',
    beforeParse(window) {
      window.prompt = (_msg, def) => def;
      window.fetch = async (url, opts) => {
        if (opts && opts.method === 'POST') {
          posts.push({ url, body: JSON.parse(opts.body) });
          return { json: async () => ({ ok: true, list: { id: 91, name: 'x' }, total: 120 }) };
        }
        return { json: async () => ({ ok: true, players: [], overview: {}, funnel: null, grants: null, play_distribution: distribution }) };
      };
    }
  });
  await wait(100);
  return { dom, doc: dom.window.document, posts };
}

test('玩家數據：1 抽～4 抽各一格、5 抽以上合併；按「建名單並推播」建立名單並給群發連結', async () => {
  const { dom, doc, posts } = await openPlayersPage([
    { plays: 1, users: 120 }, { plays: 2, users: 45 }, { plays: 3, users: 20 }, { plays: 4, users: 9 }, { plays: 5, users: 4 }, { plays: 7, users: 2 }
  ]);
  const cells = [...doc.querySelectorAll('.play-dist-cell')];
  assert.deepEqual(cells.map(c => c.querySelector('.k').textContent), ['1 抽', '2 抽', '3 抽', '4 抽', '5 抽以上']);
  assert.deepEqual(cells.map(c => c.querySelector('.v').firstChild.textContent), ['120', '45', '20', '9', '6']);
  assert.match(doc.getElementById('play-dist-meta').textContent, /200/);

  cells[0].querySelector('button').click();
  await wait(30);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/admin/activities/api/6/export-players-to-list');
  assert.equal(posts[0].body.filter, 'plays_eq');
  assert.equal(posts[0].body.plays, 1);
  assert.match(posts[0].body.name, /^分享超有哩｜1 抽/);
  const link = cells[0].querySelector('.done a');
  assert.equal(link.getAttribute('href'), '/admin/broadcast?list_id=91');

  cells[4].querySelector('button').click();
  await wait(30);
  assert.equal(posts[1].body.filter, 'plays_gte');
  assert.equal(posts[1].body.plays, 5);
  dom.window.close();
});

test('玩家數據：最多只抽到 2 次就只顯示 2 格；0 人的格子不能建名單', async () => {
  const { dom, doc } = await openPlayersPage([{ plays: 2, users: 3 }]);
  const cells = [...doc.querySelectorAll('.play-dist-cell')];
  assert.deepEqual(cells.map(c => c.querySelector('.k').textContent), ['1 抽', '2 抽']);
  assert.equal(cells[0].querySelector('button').disabled, true);
  assert.equal(cells[1].querySelector('button').disabled, false);
  dom.window.close();
});

test('群發頁帶 list_id 進來會切到「已儲存名單」並選好那份名單', async () => {
  const html = await ejs.renderFile(path.join(REPO, 'views', 'admin_broadcast.ejs'), {
    title: '群發', bodyClass: 'admin-shell broadcast-shell', user: 'admin', isAdmin: true,
    prizes: [], activities: [], recent: [], scheduled: [], running: [], hasLineToken: true,
    gamesLiffId: 'L', prefillActivityId: null, prefillListId: 91,
    maxRecipients: 5000, chunkSize: 50, fieldLimits: {}, msgLibMode: false, msgLibId: null, msgLibDup: false
  }, { views: [path.join(REPO, 'views')] });
  const source = fs.readFileSync(path.join(REPO, 'public', 'admin-broadcast.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://crm.example/admin/broadcast?list_id=91', pretendToBeVisual: true });
  const { window } = dom;
  window.alert = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (u) => {
    if (u === '/admin/broadcast/recipient-lists') return { json: async () => ({ ok: true, lists: [{ id: 90, name: '別的', total: 3 }, { id: 91, name: '分享超有哩｜1 抽', total: 120 }] }) };
    return { json: async () => ({ ok: true, recipients: [], templates: [] }) };
  };
  window.eval(source);
  await wait(60);
  const doc = window.document;
  assert.equal(doc.querySelector('.tab-btn[data-audience="saved_list"]').classList.contains('active'), true);
  assert.equal(doc.getElementById('audience-pane-saved_list').hidden, false);
  assert.equal(doc.getElementById('saved-list-select').value, '91');
  dom.window.close();
});
