/* Optional LIFF activity integration. Call only after successful liff.init().
 * This helper never changes navigation, submits a registration, or closes LIFF.
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
        var refs = params.getAll('or_bc');
        if (started || options.preview || location.protocol !== 'https:' ||
            params.get('demo') === '1' || params.get('preview') === '1' || refs.length !== 1 ||
            !/^[1-9]\d*\.[1-9]\d*\.(0|[1-9]\d*)\.[abc-]$/.test(refs[0]) || refs[0].length > 90 ||
            origins.indexOf(options.crmOrigin) < 0 || !options.liffId || options.liff?.id !== options.liffId) return false;
        var token = options.liff.getIDToken();
        if (!token) return false;
        started = true;
        var controller = new AbortController();
        timer = setTimeout(function () { controller.abort(); }, 2500);
        var response = await fetch(options.crmOrigin + '/tracking/broadcast/liff-hit', {
          method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ reference: refs[0], liff_id: options.liffId, id_token: token, page_path: location.pathname })
        });
        return response.ok;
      } catch (_) {
        // Analytics cannot block registration or the completion button.
        return false;
      } finally { if (timer) clearTimeout(timer); }
    }
  };
})();
