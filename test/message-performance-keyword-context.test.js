'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keywordExperimentContext } = require('../src/core/messagePerformanceList');

test('關鍵字 A/B 歷史成效明確標示已刪除規則，不顯示 null 或 undefined', () => {
  for (const rule_id of [null, undefined, 0]) {
    assert.equal(keywordExperimentContext({ rule_id, keywords: null }),
      '原關鍵字規則已刪除 · A/B 測試（歷史成效保留）');
  }
});
test('仍存在的規則缺關鍵字時保留編號，不誤稱已刪除', () => {
  assert.equal(keywordExperimentContext({ rule_id: 12, keywords: '  ' }),
    '關鍵字規則 #12（關鍵字未提供）· A/B 測試');
});
test('正常關鍵字與歷史名稱保持可辨識', () => {
  assert.equal(keywordExperimentContext({ rule_id: 12, keywords: '抽獎,優惠' }),
    '關鍵字「抽獎,優惠」· A/B 測試');
});
