// 這些頁面的內容包在樣板字串裡（include('layout',{body:`...`})），
// 反斜線跳脫會被吃掉一層，整頁 JS 直接掛掉——本專案已為此出事六次。
// EJS 編譯不會抓到（語法在編譯期是合法的），所以要專門掃。
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, l) { console.log((c ? 'OK  ' : '錯！ ') + l); if (!c) failed++; }

// 內容包在樣板字串裡的頁面（開頭是 include('layout' 且 body 用反引號）
const files = fs.readdirSync(path.join(REPO, 'views'))
  .filter(f => f.endsWith('.ejs'))
  .filter(f => {
    const s = fs.readFileSync(path.join(REPO, 'views', f), 'utf8').slice(0, 400);
    return /include\('layout'/.test(s) && /body:\s*`/.test(s);
  });

ok(files.length > 0, '找得到用樣板字串的頁面（共 ' + files.length + ' 支）');

for (const f of files) {
  const src = fs.readFileSync(path.join(REPO, 'views', f), 'utf8');
  const lines = src.split('\n');
  const bad = [];
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    // 找「落單的反斜線」：\\ 是正確寫法（樣板字串吃掉一層後剛好變成 \），
    // 單獨一個 \ 才會被吃掉造成災難。先把所有 \\ 拿掉再看還有沒有剩。
    const withoutPairs = ln.split('\\\\').join('');
    if (withoutPairs.indexOf('\\') >= 0) {
      bad.push((i + 1) + ': ' + t.slice(0, 90));
    }
  });
  ok(bad.length === 0, f + '：JS 區沒有會被吃掉的反斜線' +
     (bad.length ? ('\n      ' + bad.slice(0, 4).join('\n      ')) : ''));
}

console.log(failed ? ('\n有 ' + failed + ' 項失敗') : '\n樣板字串頁面沒有反斜線地雷');
process.exit(failed ? 1 : 0);
