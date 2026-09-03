// 四種遊戲都要有防重複扣次數的鑰匙，而且三種情況的處理要一致：
//   伺服器明確拒絕 → 換新鑰匙（沒扣到次數）
//   收不到回應     → 保留同一把（下次重送回原結果）
//   結果顯示出來   → 換新鑰匙
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

const GAMES = [
  { view: 'game_wheel',   name: '轉盤' },
  { view: 'game_scratch', name: '刮刮樂' },
  { view: 'game_slot',    name: '拉霸' },
  { view: 'game_fortune', name: '抽籤詩' }
];

for (const g of GAMES) {
  const s = fs.readFileSync(path.join(REPO, 'views', g.view + '.ejs'), 'utf8');
  ok(/var pendingPlayKey = loadPlayKey\(\)/.test(s), g.name + '：有這把鑰匙');
  ok(/sessionStorage\.setItem\(PLAYKEY_STORE/.test(s) && /sessionStorage\.getItem\(PLAYKEY_STORE/.test(s),
     g.name + '：鑰匙存在瀏覽器裡（重新整理也撿得回來）');
  ok(/savePlayKey\(null\)/.test(s), g.name + '：用完會把暫存的鑰匙清掉（下一次是新的一把）');
  // 存取暫存不可以讓遊戲掛掉（無痕模式、擋 cookie 的瀏覽器會丟例外）
  ok(/try \{ return sessionStorage\.getItem[\s\S]{0,80}catch/.test(s) &&
     /try \{ if \(k\) sessionStorage[\s\S]{0,120}catch/.test(s),
     g.name + '：瀏覽器不給存也不會壞（無痕模式照樣能玩）');
  ok(/play_key: pendingPlayKey/.test(s), g.name + '：抽的時候把鑰匙送出去');
  ok(/if \(!pendingPlayKey\) \{[\s\S]{0,120}pendingPlayKey = 'pk'/.test(s),
     g.name + '：沒有鑰匙才產新的（有的話沿用同一把）');

  // 明確拒絕 → 換新鑰匙
  const rejectBlock = /if \(!resp\.ok\)[\s\S]{0,400}?pendingPlayKey = null/.test(s);
  ok(rejectBlock, g.name + '：伺服器拒絕時換新鑰匙');

  // 收不到回應 → 不可以清鑰匙
  const catchIdx = s.search(/\} catch \(e\) \{[\s\S]{0,300}?收訊不穩/);
  if (catchIdx >= 0) {
    const catchBlock = s.slice(catchIdx, catchIdx + 400);
    ok(!/pendingPlayKey = null/.test(catchBlock), g.name + '：收不到回應時鑰匙留著（才能重送）');
    ok(/收訊不穩/.test(catchBlock), g.name + '：收訊不穩時講人話，不是只寫「錯誤」');
  } else {
    ok(false, g.name + '：找不到「收訊不穩」的處理');
  }

  // 結果顯示之後才換新鑰匙（順序很重要：清太早，顯示途中出錯會被多扣一次）
  const showIdx = s.search(/showResult\(resp\.prize, resp\)|renderPrize\(currentPrize, resp\)/);
  const clearAfter = showIdx >= 0 && /pendingPlayKey = null/.test(s.slice(showIdx, showIdx + 260));
  ok(clearAfter, g.name + '：結果呈現出來之後才換新鑰匙');
}

// 後端：四種遊戲共用同一支引擎，鑰匙格式驗證只有一處
const routes = fs.readFileSync(path.join(REPO, 'src/routes/gamesGeneric.js'), 'utf8');
ok(/\^\[A-Za-z0-9_-\]\{8,64\}\$/.test(routes), '後端驗證鑰匙格式（擋亂送的字串）');
ok(/playKey/.test(routes), '後端把鑰匙傳進抽獎引擎');

console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n四種遊戲的防重複扣次數都一致');
process.exit(failed ? 1 : 0);
