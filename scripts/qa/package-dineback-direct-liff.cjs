'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function integrate(input, crmOrigin) {
  if (!['https://openrice-line-crm.netlify.app', 'https://staging--openrice-line-crm.netlify.app'].includes(crmOrigin)) throw Error('Unknown CRM origin');
  if (input.includes('OR_DIRECT_LIFF_BEGIN') || input.includes('OpenRiceBroadcastTracking')) throw Error('Already integrated');
  const marker = '/* ---------- 初始化 ---------- */';
  const ready = '    window.OpenRiceAnalytics.start(DEMO);\n    show("view-form");';
  if (input.split(marker).length !== 2 || input.split(ready).length !== 2) throw Error('Activity changed: review integration sites manually');
  const helper = fs.readFileSync(path.join(__dirname, '../../public/broadcast-direct-liff.js'), 'utf8');
  const wrap = text => '/* OR_DIRECT_LIFF_BEGIN */\n' + text + '\n/* OR_DIRECT_LIFF_END */\n';
  return input.replace(marker, wrap(helper) + marker).replace(ready,
    wrap('    void window.OpenRiceBroadcastTracking.record({ liff, liffId: CONFIG.LIFF_ID, crmOrigin: ' + JSON.stringify(crmOrigin) + ', preview: DEMO });') + ready);
}

if (require.main === module) {
  const [inputPath, outputPath, crmOrigin] = process.argv.slice(2);
  if (!inputPath || !outputPath || !crmOrigin || path.resolve(inputPath) === path.resolve(outputPath)) throw Error('Usage: node script INPUT.html OUTPUT.html FIXED_CRM_ORIGIN (source must not be overwritten)');
  const input = fs.readFileSync(inputPath, 'utf8');
  const output = integrate(input, crmOrigin);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, output, { flag: 'wx' });
  console.log(JSON.stringify({ output: path.resolve(outputPath), crmOrigin, sourceSha256: crypto.createHash('sha256').update(input).digest('hex'), outputSha256: crypto.createHash('sha256').update(output).digest('hex') }));
}

module.exports = { integrate };
