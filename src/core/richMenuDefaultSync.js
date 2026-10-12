'use strict';

function menuIds(row) {
  return [...new Set([row.line_rich_menu_id, ...(Array.isArray(row.line_rich_menu_ids)
    ? row.line_rich_menu_ids.map(x => x && x.id) : [])].filter(Boolean))];
}

// Tab switching creates per-user links with higher priority than the default.
// Move only CRM-owned, non-segmented old menus. Keep current tabs and audience menus.
async function syncDefaultRichMenu({ query, rm, targetId, targetRowId, extraOldIds = [] }) {
  const { rows } = await query(`SELECT id, line_rich_menu_id, line_rich_menu_ids, audience_list_id, published_config
    FROM rich_menus WHERE line_rich_menu_id IS NOT NULL`);
  const target = rows.find(r => String(r.id) === String(targetRowId) || r.line_rich_menu_id === targetId);
  if (!target || target.audience_list_id != null) return { submitted: false };
  const keep = new Set(menuIds(target));
  const saved = target.published_config && target.published_config.default_sync_old_ids;
  const candidates = [...extraOldIds, ...(Array.isArray(saved) ? saved : [])];
  for (const row of rows) {
    if (row.audience_list_id == null && String(row.id) !== String(target.id)) candidates.push(...menuIds(row));
  }
  const existing = new Set((await rm.listRichMenus()).map(m => m.richMenuId));
  const protectedIds = new Set(rows.filter(r => r.audience_list_id != null).flatMap(menuIds));
  const fromIds = [...new Set(candidates)].filter(id => !keep.has(id) && !protectedIds.has(id) && existing.has(id));
  return rm.replaceLinkedMenus(fromIds, targetId);
}

module.exports = { syncDefaultRichMenu, menuIds };
