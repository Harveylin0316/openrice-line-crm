'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {integrate}=require('../scripts/qa/package-dineback-direct-liff.cjs');
const input='<script>\n/* ---------- 初始化 ---------- */\nasync function init() {\n    window.OpenRiceAnalytics.start(DEMO);\n    show("view-form");\n}\nif (!DEMO && liff.isInClient()) { liff.closeWindow(); return; }\n</script>';
test('package only adds helper and non-awaited post-init call; removing markers restores exact source',()=>{
 const out=integrate(input,'https://staging--openrice-line-crm.netlify.app');
 assert.match(out,/void window.OpenRiceBroadcastTracking.record/);
 assert.equal(out.replace(/\/\* OR_DIRECT_LIFF_BEGIN \*\/[\s\S]*?\/\* OR_DIRECT_LIFF_END \*\/\n/g,''),input);
 assert.ok(out.includes('if (!DEMO && liff.isInClient()) { liff.closeWindow(); return; }'));
});
test('unknown CRM host, repeat integration or changed insertion sites fail closed',()=>{
 assert.throws(()=>integrate(input,'https://evil.example'));
 assert.throws(()=>integrate(integrate(input,'https://openrice-line-crm.netlify.app'),'https://openrice-line-crm.netlify.app'));
 assert.throws(()=>integrate(input.replace('show("view-form")','different()'),'https://openrice-line-crm.netlify.app'));
});
