/**
 * MGM 邀請流程的共用前端邏輯（四個遊戲頁共用）
 *
 * 解決的問題：陌生人點朋友的邀請連結進來，LINE 授權畫面的「加好友」預設不勾，
 * 所以他多半還不是好友。原本的程式送出 referral 之後完全不看回應，就把網址上的
 * ?ref= 刪掉——這次邀請當場消失，他之後乖乖加了好友再回來，邀請人永遠拿不到。
 *
 * 這支做三件事：
 *   1. 依錯誤碼決定「這次邀請還有沒有救」，有救就存起來，之後自動重送
 *   2. 被擋下來時給一個真的可以按的加好友出口
 *   3. follow webhook 在加入當下立即入帳；頁面自動重驗只是 webhook 延遲時的備援
 *
 * 掛在 window.ORMGM。
 */
(function (w, d) {
  'use strict';

  var UID_RE = /^U[0-9a-f]{32}$/i;
  var TTL_MS = 72 * 3600 * 1000;   // 邀請最多留 3 天。綁到活動結束等於把「連結被下毒」
                                   // 的窗口拉成整個活動，不值得。
  var MAX_TRIES = 12;              // 跨 session 累計，避免無限重送

  // ── 錯誤碼分類 ────────────────────────────────────────────────
  // BURN：這個條件永遠不會成立，清掉不用再試。
  // 其他一律 KEEP（含未知碼）——保守，寧可多留也不要把還有救的邀請燒掉。
  var BURN = {
    identity_mismatch: 1,   // 竄改或跨帳號殘留
    missing_ids: 1,
    self_referral: 1,       // 邀請自己
    bad_inviter: 1,         // 連結本身壞的
    activity_not_found: 1,
    activity_ended: 1       // 活動結束，不可能再成立
  };
  // 這幾個是「活動還沒開跑」，留著但先不要一直重試（草稿期空轉沒意義）
  var NOT_YET = { activity_not_active: 1, activity_not_started: 1, mgm_disabled: 1 };

  function classify(code) {
    if (!code) return 'keep';
    if (BURN[code]) return 'burn';
    if (NOT_YET[code]) return 'later';
    return 'keep';
  }

  // ── 暫存 ──────────────────────────────────────────────────────
  function rk(slug) { return 'ormgm:ref:' + slug; }
  function dk(slug) { return 'ormgm:done:' + slug; }

  function loadRef(slug) {
    try {
      var raw = w.localStorage.getItem(rk(slug));
      if (!raw) return null;
      var r = JSON.parse(raw);
      if (!r || !UID_RE.test(String(r.i || ''))) { w.localStorage.removeItem(rk(slug)); return null; }
      if (r.e && Date.now() > r.e) { w.localStorage.removeItem(rk(slug)); return null; }
      return r;
    } catch (e) { return null; }
  }
  function saveRef(slug, rec) {
    try { w.localStorage.setItem(rk(slug), JSON.stringify(rec)); return true; }
    catch (e) { return false; }   // 無痕模式／storage 滿了
  }
  function clearRef(slug) { try { w.localStorage.removeItem(rk(slug)); } catch (e) {} }
  function isDone(slug) { try { return !!w.localStorage.getItem(dk(slug)); } catch (e) { return false; } }
  function markDone(slug) { try { w.localStorage.setItem(dk(slug), String(Date.now())); } catch (e) {} }

  // ── 樣式（自帶，不引外部資源）────────────────────────────────
  var styled = false;
  function injectStyle() {
    if (styled) return;
    styled = true;
    var css =
      '.ormgm-gate{margin:14px 0 0;padding:14px 16px;border:2px solid #F15A22;border-radius:10px;' +
        'font-family:inherit;text-align:left}' +
      '.ormgm-gate[hidden]{display:none}' +
      '.ormgm-gate-text{margin:0 0 11px;font-size:14px;line-height:1.65;font-weight:700}' +
      '.ormgm-gate-btn{display:block;width:100%;padding:14px;border:0;border-radius:9px;' +
        'background:#F15A22;color:#fff;font-family:inherit;font-size:17px;font-weight:900;' +
        'cursor:pointer;box-shadow:0 4px 0 #B8401A}' +
      '.ormgm-gate-btn:active{transform:translateY(3px);box-shadow:0 1px 0 #B8401A}' +
      '.ormgm-gate-btn:disabled{opacity:.6;box-shadow:0 4px 0 #B8401A;cursor:default}' +
      '.ormgm-gate-alt{display:block;margin:10px auto 0;border:0;background:transparent;' +
        'font-family:inherit;font-size:13.5px;font-weight:700;color:inherit;opacity:.75;' +
        'cursor:pointer;text-decoration:underline;text-underline-offset:3px}' +
      '.ormgm-gate-alt[hidden]{display:none}' +
      '.ormgm-toast{margin:10px 0 0;padding:10px 13px;border-radius:8px;background:#3E2723;' +
        'color:#FBF8F5;font-size:13px;line-height:1.6;font-family:inherit;' +
        'opacity:0;transition:opacity .25s}' +
      '.ormgm-toast.on{opacity:1}' +
      '.ormgm-toast[hidden]{display:none}';
    var el = d.createElement('style');
    el.textContent = css;
    d.head.appendChild(el);
  }

  // 找一個合理的插入位置：狀態列之後；沒有就塞在 .page / body 最後
  function anchor() {
    return d.getElementById('status-row') || d.querySelector('.page') || d.body;
  }

  // ── toast ─────────────────────────────────────────────────────
  // 為什麼不寫進 #status：四頁的 bootstrap 都會在 referral 之後用「哈囉，暱稱」
  // 無條件覆蓋掉 statusEl，寫進去等於沒寫。
  var toastEl = null, toastTimer = null;
  function toast(text) {
    if (!text) return;
    injectStyle();
    if (!toastEl) {
      toastEl = d.createElement('div');
      toastEl.className = 'ormgm-toast';
      toastEl.hidden = true;
      var a = anchor();
      if (a && a.parentNode) a.parentNode.insertBefore(toastEl, a.nextSibling);
      else d.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    requestAnimationFrame(function () { toastEl.classList.add('on'); });
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('on');
      setTimeout(function () { if (toastEl) toastEl.hidden = true; }, 300);
    }, 4200);
  }

  // ── 加好友閘門 ────────────────────────────────────────────────
  var gate = {
    _el: null, _open: false, _denied: 0, _url: '', _onRecheck: null, _tries: 0,
    _confirmSeq: 0, _confirmTimer: null,

    init: function (addFriendUrl, onRecheck) {
      this._url = addFriendUrl || '';
      this._onRecheck = onRecheck || null;
    },

    _build: function () {
      if (this._el) return this._el;
      injectStyle();
      var self = this;
      var sec = d.createElement('section');
      sec.className = 'ormgm-gate';
      sec.id = 'oa-gate';
      sec.hidden = true;
      sec.innerHTML =
        '<p class="ormgm-gate-text" id="oa-gate-text"></p>' +
        '<button type="button" class="ormgm-gate-btn" id="oa-gate-add">加入好友</button>' +
        '<button type="button" class="ormgm-gate-alt" id="oa-gate-done" hidden>重新確認</button>';
      var a = anchor();
      if (a && a.parentNode) a.parentNode.insertBefore(sec, a.nextSibling);
      else d.body.appendChild(sec);

      sec.querySelector('#oa-gate-add').addEventListener('click', function () {
        self._goAdd(this);
      });
      sec.querySelector('#oa-gate-done').addEventListener('click', function () {
        self._recheck(this);
      });
      this._el = sec;
      return sec;
    },

    // 三段 fallback：LIFF 的 requestFriendship（有些版本沒有）→ 站內開窗 → 直接跳轉
    _goAdd: function (btn) {
      var self = this;
      this._stopAutoConfirm();
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = '開啟中';
      function after() {
        self._startAutoConfirm(btn, label);
      }
      try {
        if (w.liff && typeof w.liff.requestFriendship === 'function') {
          w.liff.requestFriendship().then(after, function () { self._openUrl(); after(); });
          return;
        }
      } catch (e) { /* 往下走 fallback */ }
      this._openUrl();
      after();
    },

    _openUrl: function () {
      if (!this._url) return;
      try {
        if (w.liff && typeof w.liff.openWindow === 'function') {
          w.liff.openWindow({ url: this._url, external: false });
          return;
        }
      } catch (e) { /* 往下走 */ }
      w.location.href = this._url;
    },

    _stopAutoConfirm: function () {
      this._confirmSeq++;
      if (this._confirmTimer) clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    },

    _startAutoConfirm: function (btn, originalLabel) {
      var self = this;
      if (!this._el || !this._onRecheck) {
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      this._stopAutoConfirm();
      var seq = this._confirmSeq;
      var attempt = 0;
      var retryDelays = [700, 1200, 2000, 3000];
      var textEl = this._el.querySelector('#oa-gate-text');
      var retryBtn = this._el.querySelector('#oa-gate-done');
      textEl.textContent = '正在確認好友狀態，完成後會自動更新，不需要再按按鈕。';
      retryBtn.hidden = true;
      btn.disabled = true;
      btn.textContent = '正在確認';

      function check() {
        if (seq !== self._confirmSeq || !self._open) return;
        attempt++;
        // 官方建議 requestFriendship 後用 getFriendship 重新讀狀態；真正入帳仍由
        // server-side referral 驗證，不能相信前端回傳值。兩者並行以縮短等待。
        var local = Promise.resolve(null);
        try {
          if (w.liff && typeof w.liff.getFriendship === 'function') {
            local = Promise.resolve(w.liff.getFriendship()).then(
              function (r) { return !!(r && r.friendFlag); },
              function () { return null; }
            );
          }
        } catch (e) { local = Promise.resolve(null); }
        var server = Promise.resolve().then(function () { return self._onRecheck(); }).then(
          function (ok) { return ok === true; },
          function () { return false; }
        );
        Promise.all([local, server]).then(function (checks) {
          if (seq !== self._confirmSeq || !self._open) return;
          if (checks[1]) {
            self.hide();
            return;
          }
          if (attempt <= retryDelays.length) {
            textEl.textContent = checks[0] === true
              ? '好友已加入，正在同步遊戲次數…'
              : '正在等待 LINE 同步好友狀態，完成後會自動更新。';
            self._confirmTimer = setTimeout(check, retryDelays[attempt - 1]);
            return;
          }
          btn.disabled = false;
          btn.textContent = originalLabel;
          textEl.textContent = '好友狀態暫時還沒同步。若已完成加入，可以稍後按「重新確認」。';
          retryBtn.hidden = false;
        });
      }
      check();
    },

    _recheck: function (btn) {
      var self = this;
      if (!this._onRecheck) return;
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = '確認中';
      Promise.resolve(this._onRecheck()).then(function (ok) {
        btn.disabled = false;
        btn.textContent = label;
        if (ok) return;
        self._tries++;
        // LINE 那邊剛加好友到查得到，偶爾會有幾秒落差，不要一次就叫人去找客服
        toast(self._tries >= 3
          ? '還是查不到，可能要等一下下。稍後再按一次就好。'
          : '還沒查到，等幾秒再按一次「重新確認」。');
      }, function () {
        btn.disabled = false;
        btn.textContent = label;
        toast('連線不太順，等一下再按一次。');
      });
    },

    show: function (text) {
      var el = this._build();
      this._open = true;
      if (text) el.querySelector('#oa-gate-text').textContent = text;
      el.hidden = false;
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    },

    hide: function () {
      this._stopAutoConfirm();
      this._open = false;
      this._denied = 0;
      if (this._el) {
        this._el.hidden = true;
        var addBtn = this._el.querySelector('#oa-gate-add');
        var retryBtn = this._el.querySelector('#oa-gate-done');
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = '加入好友'; }
        if (retryBtn) { retryBtn.disabled = false; retryBtn.hidden = true; retryBtn.textContent = '重新確認'; }
      }
    },

    serverDenied: function () { this._denied++; },
    isOpen: function () { return this._open; }
  };

  // ── 送出邀請（single-flight，避免重整/切回來時同時飛兩筆）────
  var inflight = null;

  function referral(o) {
    if (inflight) return inflight;
    inflight = _referral(o).then(
      function (r) { inflight = null; return r; },
      function (e) { inflight = null; throw e; }
    );
    return inflight;
  }

  async function _referral(o) {
    var slug = o.slug, gameType = o.gameType, me = o.userId;
    if (!slug || !me) return { state: 'none' };
    if (isDone(slug)) return { state: 'skip' };

    // 網址上的 ref 優先，但要先驗格式，否則一條壞連結會把之前存好的合法邀請抹掉
    var rec = null;
    var urlRef = null;
    try { urlRef = new URLSearchParams(w.location.search).get('ref'); } catch (e) {}
    if (urlRef) {
      if (UID_RE.test(urlRef) && urlRef !== me) {
        rec = { i: urlRef, e: Date.now() + TTL_MS, a: 0, t: 0 };
        // 存得起來才准把網址上的 ref 拿掉；存不起來（無痕模式）就留著當載體
        if (saveRef(slug, rec)) stripUrlRef();
      } else {
        stripUrlRef();          // 自己邀自己 / 格式錯：清網址，但不動已存的
        rec = loadRef(slug);
      }
    } else {
      rec = loadRef(slug);
    }
    if (!rec) return { state: 'none' };
    if (rec.a >= MAX_TRIES) return { state: 'quota' };

    var body = {
      line_user_id: me,
      inviter_line_user_id: rec.i,
      id_token: (typeof o.getIdToken === 'function' ? (o.getIdToken() || '') : '')
    };

    var resp;
    try {
      var r = await fetch('/api/games/' + gameType + '/' + encodeURIComponent(slug) + '/referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      try { resp = await r.json(); } catch (e) { resp = { ok: false, error: 'http_error' }; }
      if (!r.ok && !resp.error) resp = { ok: false, error: 'http_error' };
    } catch (e) {
      resp = { ok: false, error: 'network_error' };
    }

    if (resp && resp.ok) {
      markDone(slug);
      clearRef(slug);
      return { state: 'done', counted: !!resp.counted, sameInviter: resp.same_inviter,
               wasExisting: resp.invitee_was_existing === true };
    }

    var code = (resp && resp.error) || 'http_error';
    var kind = classify(code);
    if (kind === 'burn') {
      // 只清掉「這次送出的那一位」，暫存裡若已換成別人就留著
      var cur = loadRef(slug);
      if (cur && cur.i === rec.i) clearRef(slug);
      return { state: 'dead', code: code };
    }
    rec.a = (rec.a || 0) + 1;
    rec.t = Date.now();
    saveRef(slug, rec);
    if (code === 'invitee_not_follower') gate.serverDenied();
    return { state: 'pending', code: code, later: kind === 'later' };
  }

  function stripUrlRef() {
    try {
      var u = new URL(w.location.href);
      if (!u.searchParams.has('ref')) return;
      u.searchParams.delete('ref');
      w.history.replaceState({}, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  function hasPending(slug) { return !!loadRef(slug); }

  // ── 從加好友畫面切回來 ────────────────────────────────────────
  // 只做唯讀動作：刷次數、重驗好友、重送還沒成功的邀請。絕對不碰 /play。
  function watchReturn(o) {
    var last = 0;
    d.addEventListener('visibilitychange', function () {
      if (d.visibilityState !== 'visible') return;
      var now = Date.now();
      if (now - last < 2500) return;
      last = now;
      if (typeof o.onQuota === 'function') { try { o.onQuota(); } catch (e) {} }
      if (gate.isOpen() && typeof o.onRecheck === 'function') { try { o.onRecheck(); } catch (e) {} }
      if (hasPending(o.slug) && typeof o.busy === 'function' && !o.busy() &&
          typeof o.onReferral === 'function') {
        var rec = loadRef(o.slug);
        // 退避：3s → 15s → 60s，之後每分鐘一次
        var wait = [3000, 15000, 60000][Math.min(rec.a || 0, 2)];
        if (!rec.t || (now - rec.t) >= wait) { try { o.onReferral(); } catch (e) {} }
      }
    });
  }

  w.ORMGM = {
    referral: referral,
    gate: gate,
    toast: toast,
    watchReturn: watchReturn,
    hasPending: hasPending,
    classify: classify
  };
})(window, document);
