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
      section.innerHTML = '<h3>下一步：用公司信箱寄送</h3><p>由電腦的預設郵件程式（例如 Spark／Outlook）開啟純文字草稿，請選 sales@openrice.com.tw 寄出。開啟後會鎖定本封內容，保留這次版本。</p><button type="button" class="rv-btn rv-primary" data-outlook-open>' + (reserved ? '重新取得草稿（先檢查郵件程式，避免重複）' : '準備這封郵件草稿') + '</button><p role="status" data-outlook-msg></p><div data-outlook-result></div>';
      var actions = root.querySelector('.rv-editor-actions');
      if (actions) actions.after(section); else root.append(section);
      var confirmation = document.createElement('label');
      var check = document.createElement('input');
      check.type = 'checkbox';
      confirmation.append(check, document.createTextNode(' 我已檢查收件人與儲存內容，且郵件程式內沒有同一封未寄草稿。'));
      section.querySelector('[data-outlook-open]').before(confirmation);
      if (reserved) {
        var note = root.querySelector('.rv-review-note');
        if (note) {
          note.querySelector('strong').textContent = '草稿已準備，請先核對寄件備份，再記錄結果。';
          Array.from(note.childNodes).forEach(function (node) {
            if (node.nodeType === 3 && node.textContent.includes('outlook_draft_requested')) node.textContent = '系統保留這次草稿版本，尚未記錄寄出。';
          });
          var retry = note.querySelector('[data-review="retry"]');
          if (retry) retry.hidden = true;
          note.querySelector('[data-review="confirm_sent"]').textContent = '已查看寄件備份，確認這封已寄出';
          note.querySelector('[data-review="cancel"]').textContent = '已刪除郵件程式內未寄草稿，取消此筆';
        }
      }
      var button = section.querySelector('[data-outlook-open]');
      button.addEventListener('click', async function () {
        if (!options.isSaved()) {
          section.querySelector('[data-outlook-msg]').textContent = '內容尚未儲存，請先按「儲存這封」再開啟草稿。';
          return;
        }
        if (!check.checked) {
          section.querySelector('[data-outlook-msg]').textContent = '請先勾選確認內容，並檢查郵件程式沒有同一封未寄草稿。';
          return;
        }
        button.disabled = true;
        var msg = section.querySelector('[data-outlook-msg]');
        var needsReload = true;
        try {
          var result = await options.request(row.id);
          var draft = result.draft;
          msg.textContent = '草稿已準備，尚未確認寄出。請開啟郵件程式寄出，再回來核對寄件備份。';
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
            warning.textContent = '內容較長，請複製下方三個完整欄位到新郵件，避免開啟草稿時被截斷。';
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
            var copy = document.createElement('button');
            copy.type = 'button'; copy.className = 'rv-btn rv-secondary'; copy.textContent = '複製' + field[0];
            copy.addEventListener('click', async function () {
              try {
                if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard_unavailable');
                await navigator.clipboard.writeText(input.value);
                msg.textContent = '已複製' + field[0] + '；請貼到郵件程式，內容仍未寄出。';
              } catch (_err) {
                input.focus(); input.select();
                msg.textContent = '無法自動複製，已選取完整欄位；請按 Ctrl+C／⌘C 複製。';
              }
            });
            label.append(copy);
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
          reload.textContent = '我已處理郵件，回來核對這封';
          reload.addEventListener('click', options.reload);
          details.append(reload);
        } catch (err) {
          msg.textContent = '無法準備草稿：' + err.message + '。若網路中斷，請重新載入本批確認狀態，不要直接重建整批。';
          var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'rv-btn rv-secondary'; retry.textContent = '重新載入本筆狀態'; retry.addEventListener('click', options.reload); section.querySelector('[data-outlook-result]').replaceChildren(retry);
        } finally { button.disabled = needsReload; check.disabled = needsReload; }
      });
    }
  };
})();
