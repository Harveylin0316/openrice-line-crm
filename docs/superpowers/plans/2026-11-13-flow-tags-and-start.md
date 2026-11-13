# Automation Flow tags and start Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Extend existing flow editor with inline tag creation, independent AB branch tagging, and minute-precision scheduled start.
**Architecture:** Reuse user_tags and graph nodes; persist branch assignment in existing enrollment context. No new tracking system or automatic cleanup of existing tags. User selected option 3: first date/time followed by daily/weekly/monthly recurrence.
**Tech Stack:** Express, PostgreSQL, EJS, Node tests/JSDOM.
**Spec:** User-approved feature document in this conversation (2026-11-13); user instructed 開始.

## Constraints
- Only staging; no actual sends, main changes, production schema changes.
- Preserve existing hash-based 50/50 and broadcast-derived A/B/C grouping.
- Inline creation uses existing permissions; duplicate names select existing tag without recoloring it.
- Prior unrelated stashed work remains preserved.

## Review Focus
- Delayed tag creation response after user edits/deletes/reorders a node cannot change another node.
- Save/reopen retains branch tags and independent expiry.
- Blank/deleted tag cannot silently succeed at validation.
- Repeated execution follows saved group, only assigned branch tags.
- Scheduled activation cannot occur before due time or while paused.

## Task 1: Branch tags and inline creation
- [x] Add failing route and DOM tests for branch tags, invalid tag IDs and creation preserving unsaved fields.
- [x] Extend branch allowlist/rendering to add_tag/remove_tag, validate IDs, use graph roundtrip.
- [x] Add flow-specific tag-create endpoint with shared user_tags storage and no duplicate recoloring.
- [x] Bind async response to node object identity; preserve changes made during request, provide inline status.
- [x] Run focused tests and full suite.

## Task 2: Scheduled start
- [x] Confirm one-time / activation gate / recurring first start with user.
- [x] Add boundary and precision tests, then extend existing scheduler consistently with selected semantics.
- [x] Preserve legacy defaults, run locks/idempotency and paused behavior.

## Task 3: Review and release
- [x] Full npm ci/test/diff checks; desktop390 UI and isolated database QA.
- [x] Update AI_HANDOFF and Hen review (title/evidence/rollback, Hen unchecked).
- [x] Commit/pull-rebase/push staging; verify fixed staging, no main deployment.

Fixed staging migration applied by administrator; draft create/update/reopen and desktop/390px verified. Engine execution verified in isolated PostgreSQL only; no cloud cron or actual sends. Hen review pending.
