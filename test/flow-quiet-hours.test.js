// 安靜時段（台北 21:00–08:00）：
//   用戶剛做了某件事（加好友、玩完遊戲）→ 立刻回，他正在螢幕前等
//   我們主動發起的（久沒來、定時、連勝快斷）→ 一律等到早上八點
// 原本的規則是「只要是流程的第一則就不受限」，等於沉睡喚醒一啟用就可能凌晨三點推播。
const path = require('path');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// 直接讀原始碼驗證判斷條件（這段邏輯在 processEnrollment 深處，
// 要跑起來得拉整台引擎，用讀碼＋行為模擬兩層確認）
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/core/flowEngine.js'), 'utf8');

ok(/const userInitiated\s*=/.test(src), '有區分「用戶主動觸發」與「我們主動發起」');
ok(/if \(!\(isFirstSend && userInitiated\)\)/.test(src),
   '只有「用戶主動觸發的第一則」才跳過安靜時段');
const m = /const userInitiated =([\s\S]{0,220}?);/.exec(src);
const cond = m ? m[1] : '';
['follow', 'event', 'game_play'].forEach(t => {
  ok(cond.includes("'" + t + "'"), '「' + t + '」算用戶主動觸發（可以立刻回）');
});
['inactivity', 'schedule', 'streak_risk'].forEach(t => {
  ok(!cond.includes("'" + t + "'"), '「' + t + '」不算（要遵守安靜時段）');
});

// 時段函式本身：白天不擋、深夜要擋到隔天早上八點
const vm = require('vm');
const fnSrc = /function nextRunIfQuiet\(now\) \{[\s\S]*?\n  \}/.exec(src)[0];
const ctx = { Date };
vm.createContext(ctx);
vm.runInContext(fnSrc + '; globalThis.__q = nextRunIfQuiet;', ctx);
const q = ctx.__q;
const tpe = (y, mo, d, h) => new Date(Date.UTC(y, mo, d, h - 8, 0, 0));   // 台北時間轉 UTC
ok(q(tpe(2026, 7, 25, 14)) === null, '下午兩點：照發');
ok(q(tpe(2026, 7, 25, 9)) === null, '早上九點：照發');
const at3 = q(tpe(2026, 7, 25, 3));
ok(at3 instanceof Date, '凌晨三點：要等');
const at3h = Number(at3.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit' }));
ok(at3h === 8, '凌晨三點會等到當天早上八點（實際 ' + at3h + ' 點）');
const at22 = q(tpe(2026, 7, 25, 22));
const at22h = Number(at22.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit' }));
ok(at22 instanceof Date && at22h === 8, '晚上十點會等到隔天早上八點（實際 ' + at22h + ' 點）');

console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n安靜時段的規則正確');
process.exit(failed ? 1 : 0);
