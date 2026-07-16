/**
 * 後台帳號管理 + 改密碼
 *
 *  帳號管理（僅管理員 requireOwner）：
 *    GET  /admin/accounts                     頁面
 *    GET  /admin/accounts/api/list            列出所有後台帳號（is_admin=true）
 *    POST /admin/accounts/api/create          新增員工帳號 {username, password, role}
 *    POST /admin/accounts/api/update-role     改角色 {id, role}
 *    POST /admin/accounts/api/set-active      停用/啟用 {id, active}
 *    POST /admin/accounts/api/reset-password  管理員重設某帳號密碼 {id, password}
 *
 *  改自己的密碼（任何登入者 requireAdmin，員工也算 is_admin=true）：
 *    GET  /admin/account/password             頁面
 *    POST /admin/account/password             {currentPassword, newPassword}
 *
 * 設計：後台帳號沿用 users 表（is_admin=true）。role ∈ {admin, staff}；is_active 停用旗標。
 * 所有帳號操作一律加 is_admin=true 條件，避免誤動到 LINE 會員列。
 * 停用/降級的即時生效由 app.js 的 /admin liveness 中介層負責（每個 request 讀 DB 現況）。
 * 改密碼/重設密碼會 sess_epoch +1，讓其他裝置的舊 JWT 立即失效（liveness 檢查 se）。
 * 「最後一位管理員」保護在交易 + SELECT ... FOR UPDATE 下序列化，避免並發把管理員降到 0。
 */
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt 實際只吃前 72 bytes

function validUsername(u) {
  return /^[A-Za-z0-9_.\-]{3,40}$/.test(String(u || ''));
}
function validRole(r) {
  return r === 'admin' || r === 'staff';
}
function passwordProblem(p) {
  const s = String(p == null ? '' : p);
  if (s.length < MIN_PASSWORD_LEN) return `密碼至少 ${MIN_PASSWORD_LEN} 個字`;
  if (Buffer.byteLength(s, 'utf8') > MAX_PASSWORD_BYTES) return '密碼太長，請換短一點';
  return null;
}

function registerAdminAccountsRoutes(app, deps) {
  const { query, pool, authCore } = deps;
  const { requireOwner, requireAdmin, signAuthToken, setAuthCookie } = authCore;

  function currentUid(req) {
    return req.authUser && Number(req.authUser.uid);
  }
  // 500 回應：完整錯誤只記 server log，回給前端的是通用訊息（不外洩 DB / schema 細節）
  function serverError(res, code, err) {
    console.error('[accounts]', code, err && (err.message || err));
    return res.status(500).json({ ok: false, error: code, detail: '系統忙碌，請稍後再試' });
  }
  // 重新簽發「目前這台裝置」的登入 cookie（改自己密碼後用，避免把自己踢出）
  function reissueSelfCookie(res, userRow) {
    if (userRow && typeof signAuthToken === 'function' && typeof setAuthCookie === 'function') {
      setAuthCookie(res, signAuthToken(userRow));
    }
  }

  // ---------- 頁面 ----------
  app.get('/admin/accounts', requireOwner, (req, res) => {
    res.render('admin_accounts', {
      title: '帳號管理',
      bodyClass: 'admin-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      currentUid: currentUid(req) || 0
    });
  });

  app.get('/admin/account/password', requireAdmin, (req, res) => {
    res.render('admin_change_password', {
      title: '改密碼',
      bodyClass: 'admin-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // ---------- API：列表 ----------
  app.get('/admin/accounts/api/list', requireOwner, async (req, res) => {
    try {
      const r = await query(
        `SELECT id, username, role, is_active, created_at
         FROM users WHERE is_admin = true
         ORDER BY (role = 'staff') ASC, username ASC`
      );
      const me = currentUid(req);
      const rows = r.rows.map(u => ({
        id: u.id,
        username: u.username,
        role: u.role === 'staff' ? 'staff' : 'admin', // NULL/admin 都視為管理員
        isActive: u.is_active !== false,
        createdAt: u.created_at,
        isSelf: Number(u.id) === Number(me)
      }));
      res.json({ ok: true, accounts: rows });
    } catch (err) {
      return serverError(res, 'list_failed', err);
    }
  });

  // ---------- API：新增員工帳號 ----------
  app.post('/admin/accounts/api/create', requireOwner, async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const role = String((req.body && req.body.role) || 'staff');

    if (!validUsername(username)) {
      return res.status(400).json({ ok: false, error: 'bad_username', detail: '帳號需 3–40 字，僅限英數字與 _ . -' });
    }
    if (username.toLowerCase().startsWith('line_')) {
      return res.status(400).json({ ok: false, error: 'bad_username', detail: '帳號不可用 line_ 開頭（保留給 LINE 會員）' });
    }
    if (!validRole(role)) {
      return res.status(400).json({ ok: false, error: 'bad_role', detail: '角色只能是管理員或員工' });
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem) {
      return res.status(400).json({ ok: false, error: 'bad_password', detail: pwProblem });
    }
    try {
      const dup = await query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (dup.rowCount > 0) {
        return res.status(409).json({ ok: false, error: 'username_taken', detail: '這個帳號已經有人用了' });
      }
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const ins = await query(
        `INSERT INTO users (username, password_hash, is_admin, role, is_active)
         VALUES ($1, $2, true, $3, true)
         RETURNING id, username, role, is_active, created_at`,
        [username, hash, role]
      );
      const u = ins.rows[0];
      return res.json({ ok: true, account: { id: u.id, username: u.username, role: u.role, isActive: true, createdAt: u.created_at } });
    } catch (err) {
      if (err && err.code === '23505') {
        return res.status(409).json({ ok: false, error: 'username_taken', detail: '這個帳號已經有人用了' });
      }
      return serverError(res, 'create_failed', err);
    }
  });

  // ---------- API：改角色（交易 + FOR UPDATE 序列化，保護最後一位管理員）----------
  app.post('/admin/accounts/api/update-role', requireOwner, async (req, res) => {
    const id = Number((req.body && req.body.id) || 0);
    const role = String((req.body && req.body.role) || '');
    const me = currentUid(req);
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });
    if (!validRole(role)) return res.status(400).json({ ok: false, error: 'bad_role', detail: '角色只能是管理員或員工' });
    if (Number(id) === Number(me) && role !== 'admin') {
      return res.status(400).json({ ok: false, error: 'self_demote', detail: '不能把自己降級，避免把自己鎖在門外' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 鎖住所有「有效管理員」列，序列化並發的降級/停用，避免 TOCTOU 把管理員降到 0
      await client.query(`SELECT id FROM users WHERE is_admin = true AND (role = 'admin' OR role IS NULL) FOR UPDATE`);
      const cur = await client.query('SELECT id, role FROM users WHERE id = $1 AND is_admin = true', [id]);
      if (cur.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'not_found', detail: '找不到這個帳號' });
      }
      const targetIsAdmin = cur.rows[0].role !== 'staff'; // admin 或 NULL 都算管理員
      if (targetIsAdmin && role !== 'admin') {
        const others = await client.query(
          `SELECT count(*)::int AS n FROM users
           WHERE is_admin = true AND is_active = true AND (role = 'admin' OR role IS NULL) AND id <> $1`,
          [id]
        );
        if ((others.rows[0] ? others.rows[0].n : 0) < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, error: 'last_admin', detail: '至少要保留一位管理員' });
        }
      }
      await client.query('UPDATE users SET role = $1 WHERE id = $2 AND is_admin = true', [role, id]);
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      return serverError(res, 'update_failed', err);
    } finally {
      client.release();
    }
  });

  // ---------- API：停用/啟用（交易 + FOR UPDATE 序列化）----------
  app.post('/admin/accounts/api/set-active', requireOwner, async (req, res) => {
    const id = Number((req.body && req.body.id) || 0);
    const active = req.body && (req.body.active === true || req.body.active === 'true' || req.body.active === 1);
    const me = currentUid(req);
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });
    if (Number(id) === Number(me) && !active) {
      return res.status(400).json({ ok: false, error: 'self_disable', detail: '不能停用自己的帳號' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM users WHERE is_admin = true AND (role = 'admin' OR role IS NULL) FOR UPDATE`);
      const cur = await client.query('SELECT id, role FROM users WHERE id = $1 AND is_admin = true', [id]);
      if (cur.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'not_found', detail: '找不到這個帳號' });
      }
      if (!active && cur.rows[0].role !== 'staff') { // 停用一位管理員
        const others = await client.query(
          `SELECT count(*)::int AS n FROM users
           WHERE is_admin = true AND is_active = true AND (role = 'admin' OR role IS NULL) AND id <> $1`,
          [id]
        );
        if ((others.rows[0] ? others.rows[0].n : 0) < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, error: 'last_admin', detail: '至少要保留一位在職管理員' });
        }
      }
      await client.query('UPDATE users SET is_active = $1 WHERE id = $2 AND is_admin = true', [!!active, id]);
      await client.query('COMMIT');
      return res.json({ ok: true, isActive: !!active });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      return serverError(res, 'update_failed', err);
    } finally {
      client.release();
    }
  });

  // ---------- API：管理員重設某帳號密碼（sess_epoch +1 → 對方所有裝置立即失效）----------
  app.post('/admin/accounts/api/reset-password', requireOwner, async (req, res) => {
    const id = Number((req.body && req.body.id) || 0);
    const password = String((req.body && req.body.password) || '');
    const me = currentUid(req);
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });
    const pwProblem = passwordProblem(password);
    if (pwProblem) return res.status(400).json({ ok: false, error: 'bad_password', detail: pwProblem });
    try {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const upd = await query(
        `UPDATE users SET password_hash = $1, sess_epoch = sess_epoch + 1
         WHERE id = $2 AND is_admin = true
         RETURNING id, username, is_admin, role, sess_epoch`,
        [hash, id]
      );
      if (upd.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found', detail: '找不到這個帳號' });
      // 若重設的是自己 → 重新簽發目前裝置 cookie，避免把自己踢出
      if (Number(id) === Number(me)) reissueSelfCookie(res, upd.rows[0]);
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'reset_failed', err);
    }
  });

  // ---------- API：改自己的密碼 ----------
  app.post('/admin/account/password', requireAdmin, async (req, res) => {
    const currentPassword = String((req.body && req.body.currentPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');
    const me = currentUid(req);
    if (!me) return res.status(401).json({ ok: false, error: 'no_session' });
    const pwProblem = passwordProblem(newPassword);
    if (pwProblem) return res.status(400).json({ ok: false, error: 'bad_password', detail: pwProblem });
    try {
      const r = await query('SELECT password_hash FROM users WHERE id = $1', [me]);
      if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      const ok = await bcrypt.compare(currentPassword, r.rows[0].password_hash || '');
      if (!ok) {
        return res.status(400).json({ ok: false, error: 'wrong_current', detail: '目前密碼不正確' });
      }
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const upd = await query(
        `UPDATE users SET password_hash = $1, sess_epoch = sess_epoch + 1
         WHERE id = $2
         RETURNING id, username, is_admin, role, sess_epoch`,
        [hash, me]
      );
      // 重新簽發目前裝置 cookie（其他裝置的舊 token se 落後 → 下次操作被登出）
      if (upd.rowCount > 0) reissueSelfCookie(res, upd.rows[0]);
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'change_failed', err);
    }
  });
}

module.exports = { registerAdminAccountsRoutes };
