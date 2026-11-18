# LIFF Direct Entry Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 提供不先建立 CRM 網頁視窗、仍有驗證追蹤的 LIFF 直達候選。
**Architecture:** Allowlisted direct links + authenticated cross-origin POST + optional activity-page integration, off by default.
**Tech Stack:** Existing Node/Express/pg, browser JS, node:test.
**Spec:** ../specs/2026-11-17-liff-direct-entry-design.md

## Global Constraints
不改分組、GAS、登錄、完成按鈕或正式站；無 migration。sender 預設關閉。手機尚未驗證不得聲稱修復。

## Review Focus
- spoofed hosts, invalid IDs, missing configuration: retain old URLs, no credential leakage.
- wrong LINE identity, variant, status or target: no writes.
- duplicate concurrent POSTs: one click per recipient/button, transaction rollback on failure.
- preview, unavailable GA/CRM/network and blocked storage: registration/close remain usable.
- staging versus production endpoints and old messages: explicit deployment order and limitations.

### Task 1: Direct link builder
- [x] Add failing tests in test/broadcast-direct-liff.test.js for opt-in, default-off, text/Flex/imagemap/template and preserved parameters/index.
- [x] Run `node --test test/broadcast-direct-liff.test.js`; expect direct-URL assertions fail.
- [x] Add src/core/broadcastDirectLiff.js config/parser/builder and integrate broadcastTemplates.js at its two tracking construction points.
- [x] Rerun targeted tests; expect zero failures.

### Task 2: Verified POST and client
- [x] Add failing tests for src/routes/broadcastDirectLiff.js handler and public/broadcast-direct-liff.js client.
- [x] Implement API with LINE verification and recipient transaction lock; register in src/app.js. Implement client without navigation or registration dependencies.
- [x] Run targeted tests and isolated PostgreSQL concurrency checks; expect unauthorized requests have zero writes, duplicate POSTs one row.

### Task 3: Artifact and release evidence
- [x] Add scripts/qa/package-dineback-direct-liff.cjs that takes an explicitly supplied HTML and outputs an integrated candidate using one of two fixed CRM origins; verifies expected insertion site, never deploys.
- [x] Update AI_HANDOFF and .env.example, create handoff guide with compatibility/metric semantics and rollout/rollback.
- [x] Run npm test, inspect packaged HTML unchanged except injected helper and call. Independent review, fix significant findings with tests.
- [x] Deliver candidate artifacts; any staging deploy remains disabled until app integration and phone acceptance.

## Execution record
- Task 1: three direct-entry assertions RED, builder implementation GREEN; legacy tracking tests unchanged.
- Task 2: API/client missing-module RED then branch tests GREEN; PGlite actual SQL and synthetic identities only.
- Task 3: package assertions RED then GREEN; original live HTML preserved byte-for-byte outside two inserted blocks, five real-HTML JSDOM cases pass.
- Independent review: one Important unique-index compatibility finding. Added actual existing unique index and duplicate-target/legacy fixtures, observed 503 RED, ON CONFLICT DO NOTHING GREEN. No remaining Minor findings.
- Ruling: preserve existing URL-level uniqueness instead of a migration; distinct buttons to the same exact URL retain first attribution. Cost: cannot count each such button independently; this matches existing schema and is documented.
- Ruling: deployed/mobile behavior, native multi-connection contention and actual production schema permissions remain unverified; sender stays disabled. Cost: no claim of end-to-end repair until separate acceptance.
- Final suite after SQL fix: npm test 694/694 pass (permitted local listener), 2026-11-17.
- No production settings, HTML, data, messages or main branch changed. Fixed staging deployment evidence is recorded in the review handoff when available.
