const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const VIEWS = path.join(__dirname, '../views');

async function renderLayout(pathname) {
  const html = await ejs.renderFile(path.join(VIEWS, 'layout.ejs'), {
    user: 'Ice',
    isAdmin: true,
    bodyClass: 'admin-shell',
    body: '<section class="card"><h1>測試頁面</h1></section>'
  }, { views: [VIEWS] });
  const dom = new JSDOM(html, {
    url: 'https://crm.example.com' + pathname,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
      window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return dom;
}

test('頂部只留六個白話入口，低頻功能收進全部功能', async () => {
  const dom = await renderLayout('/admin/messages');
  const doc = dom.window.document;
  const nav = [...doc.querySelectorAll('.admin-main-link[data-admin-section]')];
  assert.equal(nav.length, 6);
  assert.deepEqual(nav.map(link => link.textContent.trim()), ['工作台', '傳訊息', '顧客名單', '活動', '看成效', '設定']);
  assert.ok(doc.querySelector('#admin-find-trigger'));
  assert.ok(doc.querySelector('.admin-guide-link[href="/admin/guide"]'));
  assert.equal(doc.querySelectorAll('.navgrp, .nav-link-desc').length, 0);
  const links = [...doc.querySelectorAll('[data-finder-item]')];
  assert.ok(links.length >= 25);
  assert.ok(links.every(link => link.querySelector('strong') && link.querySelector('span')));
  assert.equal(doc.querySelector('#admin-context-current').textContent.trim(), '已存訊息');
  dom.window.close();
});

test('子頁只標亮所屬主要任務，並用麵包屑說明目前頁面', async () => {
  const dom = await renderLayout('/admin/broadcast/history');
  const doc = dom.window.document;
  const active = [...doc.querySelectorAll('.admin-main-link.has-active')];
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.adminSection, 'message');
  assert.match(doc.querySelector('#admin-page-context').textContent, /工作台.*發送紀錄/);
  dom.window.close();
});

test('功能搜尋可用白話工作內容找到入口，沒有結果時給明確下一步', async () => {
  const dom = await renderLayout('/admin');
  const doc = dom.window.document;
  doc.querySelector('#admin-find-trigger').click();
  assert.equal(doc.querySelector('#admin-finder').open, true);
  const input = doc.querySelector('#admin-finder-input');
  input.value = '訂位';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const visible = [...doc.querySelectorAll('[data-finder-item]')].filter(item => !item.hidden);
  const hidden = [...doc.querySelectorAll('[data-finder-item]')].filter(item => item.hidden);
  assert.ok(visible.length >= 2);
  assert.ok(visible.every(item => item.textContent.includes('訂位')));
  assert.ok(hidden.length > 0);
  assert.ok(hidden.every(item => dom.window.getComputedStyle(item).display === 'none'));
  input.value = '完全不存在的功能';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('#admin-finder-empty').hidden, false);
  dom.window.close();
});

test('工作台不重複顯示頁面位置條，子頁才顯示方向提示', async () => {
  const dashboard = await renderLayout('/admin');
  const dashboardContext = dashboard.window.document.querySelector('#admin-page-context');
  assert.equal(dashboardContext.hidden, true);
  assert.equal(dashboard.window.getComputedStyle(dashboardContext).display, 'none');
  dashboard.window.close();

  const detail = await renderLayout('/admin/activities');
  const detailContext = detail.window.document.querySelector('#admin-page-context');
  assert.equal(detailContext.hidden, false);
  assert.match(detailContext.textContent, /工作台.*活動管理/);
  detail.window.close();
});

test('工作台只顯示三個主要任務，其他報表預設收起', async () => {
  const html = await ejs.renderFile(path.join(VIEWS, 'admin_dashboard.ejs'), {
    user: 'Ice', isAdmin: true, bodyClass: 'admin-shell'
  }, { views: [VIEWS] });
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('.db-primary-task').length, 3);
  assert.deepEqual([...doc.querySelectorAll('.db-primary-task strong')].map(x => x.textContent.trim()), ['傳訊息給顧客', '管理活動', '看成效']);
  const more = doc.querySelector('details.db-more-data');
  assert.ok(more);
  assert.equal(more.open, false);
  assert.match(more.textContent, /活動頁使用情況/);
  assert.match(more.textContent, /訂位來源/);
  dom.window.close();
});

test('操作指南以任務、流程、檢查表與名詞解釋交接，而不是只列功能名稱', async () => {
  const html = await ejs.renderFile(path.join(VIEWS, 'admin_guide.ejs'), {
    user: 'Ice', isAdmin: true, bodyClass: 'admin-shell admin-guide-shell'
  }, { views: [VIEWS] });
  assert.match(html, /今天要做什麼/);
  assert.match(html, /最常用的三條工作流程/);
  assert.match(html, /正式送出前檢查/);
  assert.match(html, /常見名詞/);
  assert.match(html, /遇到問題時，請一次提供四件事/);
});
