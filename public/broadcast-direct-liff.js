/* Optional LIFF activity integration. Call only after successful liff.init().
 * This helper never changes navigation, submits a registration, or closes LIFF.
 * or_bc = 群發（批次.收件人.按鈕.版本）；or_ex = 自動化／關鍵字／歡迎訊息（執行代碼.連結序號）。
 */
(function () {
  'use strict';
  var started = false;
  var origins = ['https://openrice-line-crm.netlify.app', 'https://staging--openrice-line-crm.netlify.app'];
  window.OpenRiceBroadcastTracking = {
    record: async function (options) {
      var timer;
      try {
        options = options || {};
        var params = new URLSearchParams(location.search);
        var bc = params.getAll('or_bc');
        var ex = params.getAll('or_ex');
        var ref = null, path = null;
        if (bc.length === 1 && ex.length === 0 && bc[0].length <= 90 && /^[1-9]\d*\.[1-9]\d*\.(0|[1-9]\d*)\.[abc-]$/.test(bc[0])) {
          ref = bc[0]; path = '/tracking/broadcast/liff-hit';
        } else if (ex.length === 1 && bc.length === 0 && /^[A-Za-z0-9_-]{32}\.(0|[1-9]\d{0,3})$/.test(ex[0])) {
          ref = ex[0]; path = '/tracking/execution/liff-hit';
        }
        if (started || options.preview || location.protocol !== 'https:' ||
            params.get('demo') === '1' || params.get('preview') === '1' || !ref ||
            origins.indexOf(options.crmOrigin) < 0 || !options.liffId || options.liff?.id !== options.liffId) return false;
        var token = options.liff.getIDToken();
        if (!token) return false;
        started = true;
        var controller = new AbortController();
        timer = setTimeout(function () { controller.abort(); }, 2500);
        var response = await fetch(options.crmOrigin + path, {
          method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ reference: ref, liff_id: options.liffId, id_token: token, page_path: location.pathname })
        });
        return response.ok;
      } catch (_) {
        // Analytics cannot block registration or the completion button.
        return false;
      } finally { if (timer) clearTimeout(timer); }
    }
  };
})();
