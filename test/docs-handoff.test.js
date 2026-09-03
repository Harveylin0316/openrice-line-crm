const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('AI handoff entry points stay present and current', () => {
  const readme = read('README.md');
  const agentRules = read('AGENTS.md');
  const handoff = read('docs/AI_HANDOFF.md');
  const legacyHandoff = read('PROJECT_HANDOFF.md');
  const envExample = read('.env.example');

  assert.match(readme, /OpenRice LINE CRM/);
  assert.match(readme, /docs\/AI_HANDOFF\.md/);
  assert.match(agentRules, /computeUserQuota\(\)/);
  assert.match(agentRules, /preview=1/);

  assert.match(handoff, /分享超有哩/);
  assert.match(handoff, /Migration 不完整/);
  assert.match(handoff, /RUN_DB_DDL_ON_BOOT/);
  assert.match(handoff, /尚未發放/);
  assert.match(handoff, /已發放/);

  assert.match(legacyHandoff, /歷史專案交接說明/);
  assert.match(legacyHandoff, /不代表目前完整 LINE CRM/);

  assert.match(envExample, /RUN_DB_DDL_ON_BOOT/);
  assert.doesNotMatch(envExample, /SKIP_DB_DDL_ON_BOOT/);
});
