(function () {
  'use strict';
  /**
   * 名單條件編輯器（名單庫、自動化流程「進入條件」共用）。
   * 定義格式與伺服器 audienceSegments.cleanDefinition 一致：
   *   { operator:'and'|'or', conditions:[ {mode,type,value} | {type:'group', mode, operator, conditions:[...]} ] }
   * 條件組只支援一層，可做出「是好友 且（點過 A 或 點過 B）」。
   * 用法：var b = AudienceBuilder.create({ container, getCatalog, onChange }); b.load(def); b.definition(operator)
   */
  var LABELS = {
    joined_after: '加入日期在此日之後', joined_before: '加入日期在此日之前', is_friend: '目前仍是好友',
    is_blocked: '目前已封鎖', tag: '會員標籤', rich_menu: '點過指定圖文選單', rich_menu_button: '點過指定圖文選單按鈕', liff_event: 'LIFF 指定行為',
    activity: '玩過指定活動', activity_enter: '進入指定活動', activity_start: '開始指定活動', activity_complete: '完成指定活動', activity_share: '分享指定活動', successful_invite: '指定活動成功邀請', invite_count: '全部活動成功邀請合計至少幾人', reward_status: '獎勵狀態',
    follow_event: '曾加入好友', block_event: '曾封鎖', unblock_event: '封鎖後曾重新加入',
    line_login: '已有 LINE Login 身分', app_registration: '完成活動手機登記（非 OpenRice App 註冊）', booking_confirmed: '已確認金豬食堂訂位', booking_cancelled: '已取消／申請取消金豬食堂訂位',
    booking_source: '訂位來源（問卷最新回答）', booking_source_answered: '回答過訂位來源問卷',
    broadcast_sent: '指定群發已發送', broadcast_delivered: '指定群發已送達（Email）', broadcast_opened: '指定群發已開啟', broadcast_clicked: '指定群發已點擊', broadcast_tested: '指定群發已進測試組', broadcast_converted: '指定群發已轉換（CTA 點擊）'
  };
  var NO_VALUE = ['is_friend', 'is_blocked', 'line_login', 'app_registration', 'follow_event', 'block_event', 'unblock_event', 'booking_confirmed', 'booking_cancelled', 'booking_source_answered'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function create(opts) {
    var container = opts.container;
    var getCatalog = opts.getCatalog || function () { return {}; };
    var onChange = opts.onChange || function () {};
    function catalog() { return getCatalog() || {}; }
    function options(items) { return (items || []).map(function (x) { return '<option value="' + x.id + '">' + esc(x.name || ('#' + x.id)) + '</option>'; }).join(''); }
    function richMenuButtonInput() {
      return '<div class="aud-richmenu-picker">' +
        '<select class="aud-rm-menu" aria-label="選擇圖文選單"><option value="">先選圖文選單</option>' + options(catalog().menus) + '</select>' +
        '<select class="aud-rm-tab" aria-label="選擇分頁" disabled><option value="">再選分頁</option></select>' +
        '<select class="aud-rm-button" aria-label="選擇按鈕" disabled><option value="">最後選按鈕</option></select>' +
        '<input class="aud-value" type="hidden" value="" />' +
        '<span class="muted aud-rm-hint">依序選擇，不需要查編號。</span>' +
      '</div>';
    }
    function setupRichMenuButtonPicker(row, initialValue) {
      var picker = row.querySelector('.aud-richmenu-picker');
      if (!picker) return;
      var menuSelect = picker.querySelector('.aud-rm-menu');
      var tabSelect = picker.querySelector('.aud-rm-tab');
      var buttonSelect = picker.querySelector('.aud-rm-button');
      var valueInput = picker.querySelector('.aud-value');
      var hint = picker.querySelector('.aud-rm-hint');
      var match = /^([0-9]+):([0-9]+):([0-9]+)$/.exec(String(initialValue || ''));
      function selectedMenu() { return (catalog().menus || []).find(function (menu) { return String(menu.id) === menuSelect.value; }); }
      function syncValue() {
        if (menuSelect.value !== '' && tabSelect.value !== '' && buttonSelect.value !== '') {
          valueInput.value = menuSelect.value + ':' + tabSelect.value + ':' + buttonSelect.value;
          var menu = selectedMenu();
          var tab = menu && (menu.tabs || []).find(function (item) { return String(item.index) === tabSelect.value; });
          var button = tab && (tab.buttons || []).find(function (item) { return String(item.index) === buttonSelect.value; });
          hint.textContent = '已選：' + (menu ? menu.name : '') + ' › ' + (tab ? tab.label : '') + ' › ' + (button ? button.label : '');
        } else {
          valueInput.value = '';
          hint.textContent = '依序選擇，不需要查編號。';
        }
      }
      function fillButtons(preferred) {
        var menu = selectedMenu();
        var tab = menu && (menu.tabs || []).find(function (item) { return String(item.index) === tabSelect.value; });
        var buttons = tab && tab.buttons || [];
        buttonSelect.innerHTML = '<option value="">最後選按鈕</option>' + buttons.map(function (button) {
          return '<option value="' + button.index + '">' + esc(button.label) + '</option>';
        }).join('');
        buttonSelect.disabled = !buttons.length;
        if (preferred != null && buttons.some(function (button) { return String(button.index) === String(preferred); })) buttonSelect.value = String(preferred);
        syncValue();
      }
      function fillTabs(preferredTab, preferredButton) {
        var menu = selectedMenu();
        var tabs = menu && menu.tabs || [];
        tabSelect.innerHTML = '<option value="">再選分頁</option>' + tabs.map(function (tab) {
          return '<option value="' + tab.index + '">' + esc(tab.label) + '</option>';
        }).join('');
        tabSelect.disabled = !tabs.length;
        if (preferredTab != null && tabs.some(function (tab) { return String(tab.index) === String(preferredTab); })) tabSelect.value = String(preferredTab);
        else if (tabs.length === 1) tabSelect.value = String(tabs[0].index);
        fillButtons(preferredButton);
      }
      menuSelect.addEventListener('change', function () { fillTabs(null, null); onChange(); });
      tabSelect.addEventListener('change', function () { fillButtons(null); onChange(); });
      buttonSelect.addEventListener('change', function () { syncValue(); onChange(); });
      if (match) { menuSelect.value = match[1]; fillTabs(match[2], match[3]); } else syncValue();
    }
    function valueInput(type, value) {
      var c = catalog();
      if (NO_VALUE.indexOf(type) >= 0) return '<span class="muted aud-no-value">不需設定</span>';
      if (type === 'booking_source') return '<select class="aud-value">' + options(c.booking_sources) + '</select>';
      if (type === 'joined_after' || type === 'joined_before') return '<input class="aud-value" type="date" value="' + esc(value || '') + '" />';
      if (type === 'tag') return '<select class="aud-value">' + options(c.tags) + '</select>';
      if (type === 'activity' || type.indexOf('activity_') === 0 || type === 'successful_invite') return '<select class="aud-value">' + options(c.activities) + '</select>';
      if (type === 'rich_menu') return '<select class="aud-value">' + options(c.menus) + '</select>';
      if (type === 'rich_menu_button') return richMenuButtonInput();
      if (type.indexOf('broadcast_') === 0) return '<select class="aud-value">' + options(c.broadcasts) + '</select>';
      if (type === 'reward_status') return '<select class="aud-value"><option value="obtained">獲得過</option><option value="unclaimed">有尚未兌換的獎項</option><option value="claimed">有已兌換的獎項</option></select>';
      if (type === 'invite_count') return '<input class="aud-value" type="number" min="1" max="10000" value="' + esc(value || '1') + '" />';
      return '<input class="aud-value" type="text" maxlength="80" placeholder="例：app_open 或 map_booking_click" value="' + esc(value || '') + '" />';
    }
    function conditionRow(initial) {
      initial = initial || { mode: 'include', type: 'is_friend', value: null };
      var row = document.createElement('div');
      row.className = 'aud-condition';
      var typeOpts = Object.keys(LABELS).map(function (k) { return '<option value="' + k + '"' + (k === initial.type ? ' selected' : '') + '>' + LABELS[k] + '</option>'; }).join('');
      row.innerHTML = '<select class="aud-mode"><option value="include">包含</option><option value="exclude">排除</option></select>' +
        '<select class="aud-type">' + typeOpts + '</select><span class="aud-value-wrap">' + valueInput(initial.type, initial.value) + '</span>' +
        '<button type="button" class="aud-remove" aria-label="移除條件">×</button>';
      row.querySelector('.aud-mode').value = initial.mode || 'include';
      row.querySelector('.aud-type').addEventListener('change', function () {
        row.querySelector('.aud-value-wrap').innerHTML = valueInput(this.value, null);
        if (this.value === 'rich_menu_button') setupRichMenuButtonPicker(row, null);
        onChange();
      });
      row.querySelector('.aud-remove').addEventListener('click', function () { row.remove(); onChange(); });
      return row;
    }
    function placeRow(row, initial, parent) {
      parent.appendChild(row);
      if (initial && initial.type === 'rich_menu_button') setupRichMenuButtonPicker(row, initial.value);
      var valueEl = row.querySelector('.aud-value');
      if (valueEl && initial && initial.value != null && initial.type !== 'rich_menu_button') valueEl.value = String(initial.value);
    }
    function addCondition(initial, parent) {
      var row = conditionRow(initial);
      placeRow(row, initial || null, parent || container);
      onChange();
      return row;
    }
    function addGroup(initial) {
      initial = initial || { type: 'group', mode: 'include', operator: 'or', conditions: [] };
      var g = document.createElement('div');
      g.className = 'aud-group';
      g.innerHTML = '<div class="aud-group-head">' +
          '<select class="aud-group-mode" aria-label="條件組包含或排除"><option value="include">包含</option><option value="exclude">排除</option></select>' +
          '<span>符合以下</span>' +
          '<select class="aud-group-op" aria-label="條件組內的關係"><option value="or">任一條件（OR）</option><option value="and">全部條件（AND）</option></select>' +
          '<span class="muted aud-group-tip">的人</span>' +
          '<button type="button" class="aud-remove aud-group-remove" aria-label="移除條件組">×</button>' +
        '</div><div class="aud-group-body"></div>' +
        '<button type="button" class="aud-group-add">＋ 組內條件</button>';
      g.querySelector('.aud-group-mode').value = initial.mode === 'exclude' ? 'exclude' : 'include';
      g.querySelector('.aud-group-op').value = initial.operator === 'and' ? 'and' : 'or';
      var body = g.querySelector('.aud-group-body');
      g.querySelector('.aud-group-add').addEventListener('click', function () { addCondition(null, body); });
      g.querySelector('.aud-group-remove').addEventListener('click', function () { g.remove(); onChange(); });
      g.querySelector('.aud-group-mode').addEventListener('change', onChange);
      g.querySelector('.aud-group-op').addEventListener('change', onChange);
      container.appendChild(g);
      var inner = Array.isArray(initial.conditions) && initial.conditions.length ? initial.conditions : [null, null];
      inner.forEach(function (c) { var row = conditionRow(c); placeRow(row, c, body); });
      onChange();
      return g;
    }
    function readRow(row) {
      var input = row.querySelector('.aud-value');
      return { mode: row.querySelector('.aud-mode').value, type: row.querySelector('.aud-type').value, value: input ? input.value : null };
    }
    function definition(operator) {
      var items = [];
      Array.prototype.forEach.call(container.children, function (el) {
        if (el.classList.contains('aud-condition')) items.push(readRow(el));
        else if (el.classList.contains('aud-group')) {
          var inner = Array.prototype.filter.call(el.querySelector('.aud-group-body').children, function (x) { return x.classList.contains('aud-condition'); }).map(readRow);
          items.push({ type: 'group', mode: el.querySelector('.aud-group-mode').value, operator: el.querySelector('.aud-group-op').value, conditions: inner });
        }
      });
      return { operator: operator === 'or' ? 'or' : 'and', conditions: items };
    }
    function load(def) {
      container.innerHTML = '';
      var list = def && Array.isArray(def.conditions) ? def.conditions : [];
      list.forEach(function (c) { if (c && c.type === 'group') addGroup(c); else addCondition(c); });
      return list.length;
    }
    function count() { return container.querySelectorAll('.aud-condition').length; }
    return { addCondition: function (initial) { return addCondition(initial); }, addGroup: addGroup, definition: definition, load: load, count: count };
  }

  window.AudienceBuilder = { create: create, LABELS: LABELS };
})();
