const jwt = require('jsonwebtoken');

function safeAdminNextPath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const pathOnly = rawPath.split('?')[0];
  if (!pathOnly.startsWith('/admin')) return '';
  if (pathOnly.startsWith('//')) return '';
  return pathOnly;
}

function createAuthCore({ jwtSecret, isProduction, adminLoginPath = '/admin/login' }) {
  // 從 authUser（JWT payload）推導角色：優先用 role claim；
  // 舊 token 沒有 role 但 adm=true → 視為 admin（向後相容，管理員不必重新登入）。
  function roleOf(authUser) {
    if (!authUser) return null;
    if (authUser.role) return authUser.role;
    return authUser.adm ? 'admin' : null;
  }

  function signAuthToken(user) {
    const isAdm = user.is_admin === true || user.is_admin === 1;
    const role = user.role || (isAdm ? 'admin' : null);
    return jwt.sign(
      { uid: user.id, un: user.username, adm: isAdm, role, se: Number(user.sess_epoch) || 0 },
      jwtSecret,
      { expiresIn: '7d' }
    );
  }

  function setAuthCookie(res, token) {
    res.cookie('auth_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
  }

  function clearAuthCookie(res) {
    res.clearCookie('auth_token');
  }

  function authMiddleware(req, _res, next) {
    const token = req.cookies.auth_token;
    if (!token) {
      req.authUser = null;
      return next();
    }
    try {
      req.authUser = jwt.verify(token, jwtSecret);
    } catch (_err) {
      req.authUser = null;
    }
    next();
  }

  function requireLogin(req, res, next) {
    if (!req.authUser || !req.authUser.uid) return res.redirect(adminLoginPath);
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.authUser || !req.authUser.adm) {
      if (req.authUser && !req.authUser.adm) {
        clearAuthCookie(res);
      }
      const returnTo = safeAdminNextPath(req.originalUrl || req.url) || '/admin/broadcast';
      const qs = new URLSearchParams({ next: returnTo });
      return res.redirect(`${adminLoginPath}?${qs.toString()}`);
    }
    next();
  }

  // 只有 admin 角色可用（帳號管理）。先過 requireAdmin 的登入 gate，再要求角色為 admin。
  // 一般員工（role='staff'，is_admin=true）能進日常頁面，但這裡會被擋下。
  function requireOwner(req, res, next) {
    if (!req.authUser || !req.authUser.adm) {
      if (req.authUser && !req.authUser.adm) {
        clearAuthCookie(res);
      }
      const returnTo = safeAdminNextPath(req.originalUrl || req.url) || '/admin/broadcast';
      const qs = new URLSearchParams({ next: returnTo });
      return res.redirect(`${adminLoginPath}?${qs.toString()}`);
    }
    if (roleOf(req.authUser) !== 'admin') {
      if (req.path && req.path.includes('/api/')) {
        return res.status(403).json({ ok: false, error: 'forbidden', detail: '此功能僅限管理員。' });
      }
      return res
        .status(403)
        .send('<!doctype html><meta charset="utf-8"><div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#1f2937;"><h2 style="margin:0 0 8px;">沒有權限</h2><p style="color:#6b7280;line-height:1.7;">「帳號管理」僅限管理員使用。如需開通權限，請聯絡你的管理員。</p><p style="margin-top:20px;"><a href="/admin" style="color:#2563eb;text-decoration:none;">回後台首頁</a></p></div>');
    }
    next();
  }

  return {
    signAuthToken,
    setAuthCookie,
    clearAuthCookie,
    authMiddleware,
    requireLogin,
    requireAdmin,
    requireOwner,
    roleOf
  };
}

module.exports = { createAuthCore };
