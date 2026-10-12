(function () {
  'use strict';
  window.RevisitOutlook = {
    attach: function (options) {
      var row = options.row, root = options.root;
      if (!options.isOwner) return;
      var reserved = row.status === 'needs_review' && row.failure_detail === 'outlook_draft_requested';
      if (row.status !== 'pending' && !reserved) return;
      if (!['draft', 'sending'].includes(options.campaignStatus)) return;
      var section = document.createElement('section');
      section.className = 'rv-outlook-actions';
      section.innerHTML = '<h3>用公司信箱寄送</h3><p>開啟純文字草稿，不會自動寄出。請確認 Outlook 是預設郵件程式，並使用 sales@openrice.com.tw 寄送。寄出後回來確認；未寄出請先刪除 Outlook 草稿再取消此筆。草稿開過後會鎖定內容，避免寄出不同版本。</p><button type="button" class="rv-btn rv-primary" data-outlook-open>' + (reserved ? '重新取得草稿（先檢查 Outlook，避免重複）' : '用 Outlook 開啟草稿') + '</button><p role="status" data-outlook-msg></p><div data-outlook-result></div>';
      root.prepend(section);
      var confirmation = document.createElement('label');
      var check = document.createElement('input');
      check.type = 'checkbox';
      confirmation.append(check, document.createTextNode(' 我已檢查收件人與儲存內容，且沒有同一封未寄出的 Outlook 草稿。'));
      section.querySelector('[data-outlook-open]').before(confirmation);
      if (reserved) {
        var note = root.querySelector('.rv-review-note');
        if (note) {
          note.querySelector('strong').textContent = '已請求開啟 Outlook 草稿，尚未確認寄出。';
          var retry = note.querySelector('[data-review="retry"]');
          if (retry) retry.hidden = true;
          note.querySelector('[data-review="confirm_sent"]').textContent = '已查看寄件備份，確認這封已寄出';
          note.querySelector('[data-review="cancel"]').textContent = '已刪除 Outlook 未寄草稿，取消此筆';
        }
      }
      var button = section.querySelector('[data-outlook-open]');
      button.addEventListener('click', async function () {
        if (!options.isSaved()) {
          section.querySelector('[data-outlook-msg]').textContent = '內容尚未儲存，請先按「儲存這封」再開啟草稿。';
          return;
        }
        if (!check.checked) {
          section.querySelector('[data-outlook-msg]').textContent = '請先勾選確認內容，並檢查 Outlook 沒有同一封未寄草稿。';
          return;
        }
        button.disabled = true;
        var msg = section.querySelector('[data-outlook-msg]');
        try {
          var result = await options.request(row.id);
          var draft = result.draft;
          msg.textContent = '已保留為待確認；系統無法得知 Outlook 是否成功開啟或寄出。寄出後請回來核對寄件備份。';
          var details = section.querySelector('[data-outlook-result]');
          details.replaceChildren();
          if (draft.mailto) {
            // A second explicit click avoids browser restrictions on launching
            // a mail handler after an asynchronous request.
            var link = document.createElement('a');
            link.className = 'rv-btn rv-primary';
            link.href = draft.mailto;
            link.textContent = '開啟郵件草稿';
            details.append(link);
          } else {
            var warning = document.createElement('p');
            warning.textContent = '內容較長，為避免 Outlook 截斷，請將下方完整欄位複製到新郵件。';
            details.append(warning);
          }
          [['收件人', draft.email], ['主旨', draft.subject], ['完整內文（含訂位及退訂連結）', draft.body]].forEach(function (field) {
            var label = document.createElement('label');
            label.textContent = field[0];
            var input = document.createElement('textarea');
            input.readOnly = true;
            input.value = field[1];
            input.rows = field[0].startsWith('完整') ? 9 : 2;
            input.addEventListener('focus', function () { input.select(); });
            label.append(input);
            details.append(label);
          });
          row.status = 'needs_review';
          row.failure_detail = 'outlook_draft_requested';
          options.onReserved();
          // Keep the full draft visible; let the operator explicitly reload
          // once done, rather than destroying a mailto link with a rerender.
          var reload = document.createElement('button');
          reload.type = 'button';
          reload.className = 'rv-btn rv-secondary';
          reload.textContent = '回到本筆，確認已寄出／取消';
          reload.addEventListener('click', options.reload);
          details.append(reload);
        } catch (err) {
          msg.textContent = '無法準備草稿：' + err.message + '。若網路中斷，請重新載入本批確認狀態，不要直接重建整批。';
        } finally { button.disabled = false; }
      });
    }
  };
})();
