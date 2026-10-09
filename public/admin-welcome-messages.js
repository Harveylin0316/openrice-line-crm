(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let settings = null, previewRevision = 0, refreshSnapshot = false, busy = false;
  const assets = new Map();
  const validId = id => /^[1-9]\d{0,14}$/.test(String(id)) && Number.isSafeInteger(Number(id));
  const errors = {
    migration_required: '此功能需要先套用 Staging migration；目前未啟用。',
    welcome_revision_conflict: '設定已被其他人更新。請重新整理頁面後再編輯，這次變更尚未儲存。',
    message_not_found: '素材已移除，請重新選擇素材或取消變更。',
    welcome_message_invalid: '歡迎內容無法發送，請檢查素材後再儲存。',
    duplicate_check_required: '請先確認不會重複發送歡迎訊息。'
  };
  async function api(url, body) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(errors[data.error] || '操作未完成，請稍後重試。');
    return data;
  }
  function status(text, error = false) {
    $('welcome-status').textContent = text;
    $('welcome-status').classList.toggle('is-error', error);
  }
  function dirty() {
    return !!settings && (refreshSnapshot || $('welcome-message').value !== String(settings.message_id || '') ||
      $('welcome-enabled').checked !== !!settings.enabled || $('welcome-first').checked !== !!settings.first_enabled ||
      $('welcome-unblocked').checked !== !!settings.unblocked_enabled);
  }
  function sync() {
    const changed = dirty(), id = $('welcome-message').value;
    $('welcome-save').disabled = busy || !settings || !changed;
    $('welcome-cancel').disabled = busy || !changed;
    $('welcome-refresh').disabled = busy || !assets.has(id) || refreshSnapshot || id !== String(settings?.message_id || '');
    $('welcome-test').disabled = busy || changed || !$('welcome-tester').value || !settings?.message_snapshot;
    $('welcome-dirty').textContent = changed ? '有尚未儲存的變更' : '已儲存';
    $('welcome-save-note').textContent = $('welcome-enabled').checked ? '儲存後，依選定情境發送歡迎訊息。' : '儲存後維持停用，不會發送。';
    $('welcome-enable-note').textContent = $('welcome-save-note').textContent;
    const same = id === String(settings?.message_id || '');
    $('welcome-asset-name').textContent = !id ? '尚未選擇素材' : same && !refreshSnapshot ? settings.message_name || '已儲存素材' : assets.get(id)?.name || '素材無法使用';
    const version = !id ? '從上方選擇素材，右側會自動預覽。' : same && !refreshSnapshot ? '已儲存版本' + (assets.has(id) ? ' · 內容不會自動更新' : ' · 原素材已移除，保留已儲存內容') : '素材最新版 · 儲存後生效';
    $('welcome-asset-version').textContent = version;
    $('welcome-preview-label').textContent = $('welcome-asset-name').textContent + (id ? ' · #' + id + ' · ' + version : '');
  }
  function show(value) {
    settings = value;
    refreshSnapshot = false;
    $('welcome-enabled').checked = !!value.enabled;
    $('welcome-first').checked = !!value.first_enabled;
    $('welcome-unblocked').checked = !!value.unblocked_enabled;
    $('welcome-duplicate').checked = false;
    if (validId(value.message_id) && !Array.from($('welcome-message').options).some(option => option.value === String(value.message_id))) {
      $('welcome-message').add(new Option((value.message_name || '原素材已移除') + '（已儲存版本）', String(value.message_id)));
    }
    $('welcome-message').value = value.message_id || '';
    $('welcome-badge').textContent = value.enabled ? '已啟用' : '已停用';
    $('welcome-badge').classList.toggle('is-enabled', !!value.enabled);
    sync();
  }
  async function preview() {
    const revision = ++previewRevision, id = $('welcome-message').value;
    const container = $('welcome-preview-content');
    container.textContent = id ? '正在載入預覽…' : '選擇素材後，預覽會顯示在這裡。';
    if (!id || !settings) return;
    if (!validId(id)) { container.textContent = '素材編號無效，請重新選擇。'; return; }
    try {
      const useNew = id !== String(settings.message_id || '') || refreshSnapshot;
      const data = await api('/admin/welcome-messages/preview', useNew ? { messageId: Number(id) } : { saved: true });
      if (revision !== previewRevision) return;
      window.renderMessageSnapshot(container, data.messages);
    } catch (error) {
      if (revision !== previewRevision) return;
      container.textContent = '無法載入預覽，請按「重新載入」重試。';
      status(error.message, true);
    }
  }
  Promise.all([api('/admin/welcome-messages/api'), api('/admin/messages/api/list')]).then(([data, library]) => {
    if (!data.settings || !Number.isSafeInteger(Number(data.settings.revision)) || Number(data.settings.revision) < 1) throw new Error('尚未完成歡迎設定初始化，請聯絡管理員。');
    library.messages.filter(asset => (asset.channel || 'line') === 'line' && validId(asset.id)).forEach(asset => {
      assets.set(String(asset.id), asset);
      $('welcome-message').add(new Option(asset.name + ' #' + asset.id, String(asset.id)));
    });
    show(data.settings);
    $('welcome-flows').textContent = data.flows.length ? '其他啟用中的加好友流程：' + data.flows.map(flow => flow.name).join('、') : '未發現其他啟用中的加好友流程；仍需檢查 LINE 原生後台。';
    data.testers.filter(tester => validId(tester.id)).forEach(tester => $('welcome-tester').add(new Option(tester.label || '測試人員 #' + tester.id, String(tester.id))));
    if ($('welcome-tester').options.length === 1) $('welcome-test-note').textContent = '尚無已登記測試人員。請由管理員登記後再測試；不會發給一般好友。';
    $('welcome-fields').disabled = false;
    status('設定已載入；預覽不會發送訊息。');
    sync(); preview();
  }).catch(error => { $('welcome-badge').textContent = '無法載入'; status(error.message, true); });
  $('welcome-message').addEventListener('change', () => { refreshSnapshot = false; sync(); preview(); });
  ['welcome-first', 'welcome-unblocked', 'welcome-enabled', 'welcome-duplicate', 'welcome-tester'].forEach(id => $(id).addEventListener('change', sync));
  $('welcome-refresh').addEventListener('click', () => { if (!assets.has($('welcome-message').value)) return; refreshSnapshot = true; sync(); preview(); });
  $('welcome-preview').addEventListener('click', preview);
  $('welcome-cancel').addEventListener('click', () => { show(settings); status('已取消變更，恢復已儲存設定。'); preview(); });
  $('welcome-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !settings || !dirty()) return;
    const enabled = $('welcome-enabled').checked, id = $('welcome-message').value;
    if (enabled && !$('welcome-duplicate').checked) return status(errors.duplicate_check_required, true);
    if ((id && !validId(id)) || (!id && (enabled || settings.message_id))) return status('請選擇有效的歡迎素材，或取消變更。', true);
    if (enabled && !$('welcome-first').checked && !$('welcome-unblocked').checked) return status('請至少選擇一種發送情境。', true);
    const payload = { revision: Number(settings.revision), enabled, firstEnabled: $('welcome-first').checked, unblockedEnabled: $('welcome-unblocked').checked, messageId: id, refreshSnapshot, duplicateCheckConfirmed: $('welcome-duplicate').checked };
    busy = true; $('welcome-fields').disabled = true; sync(); status('正在儲存…');
    try { const data = await api('/admin/welcome-messages/api', payload); show(data.settings); status('已儲存。' + (data.settings.enabled ? '歡迎訊息已啟用。' : '歡迎訊息維持停用。')); preview(); }
    catch (error) { status(error.message, true); }
    finally { busy = false; $('welcome-fields').disabled = false; sync(); }
  });
  $('welcome-test').addEventListener('click', async () => {
    if (busy || dirty() || !validId($('welcome-tester').value) || !settings?.message_snapshot) return;
    if (!confirm('將已儲存歡迎訊息發給選定測試人員，確認？')) return;
    busy = true; $('welcome-fields').disabled = true; sync();
    try { const data = await api('/admin/welcome-messages/test', { testRecipientId: Number($('welcome-tester').value) }); status(data.skipped ? 'Staging 安全模式：未實際發送。' : 'LINE API 已接受測試發送。'); }
    catch (error) { status(error.message, true); }
    finally { busy = false; $('welcome-fields').disabled = false; sync(); }
  });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
})();
