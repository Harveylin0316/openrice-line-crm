const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const { createAuthCore } = require('./core/auth');
const { pickPrizeByQuantity, enrichPrizesWithHitRate } = require('./core/lottery');
const { createViewStateCore } = require('./core/viewState');
const { initDb } = require('./core/dbInit');
const { createAdminLoginThrottle } = require('./core/adminLoginThrottle');
const { registerWebRoutes } = require('./routes/web');
const { registerLiffRoutes } = require('./routes/liff');
const { registerAdminBroadcastRoutes } = require('./routes/adminBroadcast');
const { registerAdminLeaderboardRoutes } = require('./routes/adminLeaderboard');
const bookingLeaderboard = require('./core/bookingLeaderboard');
const { registerAdminMessagesRoutes } = require('./routes/adminMessages');
const { buildLineMessages: buildLineMessagesForLib } = require('./core/broadcastTemplates');
const { registerAdminFlowsRoutes } = require('./routes/adminFlows');
const { registerAdminKeywordRepliesRoutes } = require('./routes/adminKeywordReplies');
const { createFlowEngine } = require('./core/flowEngine');
const { registerAdminUsersRoutes } = require('./routes/adminUsers');
const { registerAdminRestaurantsRoutes } = require('./routes/adminRestaurants');
const { registerAdminRfmRoutes } = require('./routes/adminRfm');
const { registerAdminReferralsRoutes } = require('./routes/adminReferrals');
const { registerAdminBookingRegRoutes } = require('./routes/adminBookingReg');
const { registerAdminHubRoutes } = require('./routes/adminHub');
const { registerAdminDashboardRoutes } = require('./routes/adminDashboard');
const { registerAdminEmailDomainRoutes } = require('./routes/adminEmailDomain');
const { registerAdminLiffAnalyticsRoutes } = require('./routes/adminLiffAnalytics');
const { registerAdminAttributionRoutes } = require('./routes/adminAttribution');
const { registerAdminActivitiesRoutes } = require('./routes/adminActivities');
const { registerAdminCouponsRoutes } = require('./routes/adminCoupons');
const { registerGamesRoutes } = require('./routes/games');
const { registerMgmMilesRoutes } = require('./routes/mgmMiles');
const { createMgmMilesEngine } = require('./core/mgmMilesEngine');
const { registerAdminRecipientListsRoutes } = require('./routes/adminRecipientLists');
const { registerAdminAccountsRoutes } = require('./routes/adminAccounts');
const { buildLiffPermanentUrl } = require('./core/liffPermalink');
const { buildPushImageBaseCandidates } = require('./core/linePushImageResolve');
const { createLineWebhookHandler } = require('./routes/lineWebhook');
const { createOaContactsWebhookHandler } = require('./routes/oaContactsWebhook');
const { registerAdminOaContactsRoutes } = require('./routes/adminOaContacts');
const { registerAdminRichMenuRoutes } = require('./routes/adminRichMenu');
const { registerAdminInsightRoutes } = require('./routes/adminInsight');
const { createLinePushService } = require('./core/linePush');
const { createGoldPigBookingService } = require('./core/goldPigBookings');
const { registerGoldPigRoutes } = require('./routes/goldPig');
const { createEmailProvider } = require('./core/emailProvider');
const { createSureNotifyProvider } = require('./core/emailProviderSureNotify');

// 多重偵測：Netlify 不會自動設 NODE_ENV，但會設 NETLIFY=true；AWS Lambda 也會設 AWS_LAMBDA_FUNCTION_NAME。
// 任一條件成立就視為 production，避免單一 env var 沒設導致 ssl/cookie/redirect 等都跑 dev 行為。
const isProduction =
  process.env.NODE_ENV === 'production' ||
  process.env.NETLIFY === 'true' ||
  !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'LocalAdmin1234');
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  (isProduction ? '' : 'local-dev-only-jwt-secret-change-before-production-123');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // Fail fast：缺 DATABASE_URL 就直接讓 module load 炸，比 runtime 每次 query 都 timeout 友善
  console.error('FATAL: DATABASE_URL is not set. Add it to Netlify env vars.');
  // 不 throw，讓 Express 仍能 boot 回 500（避免整個 lambda crash 重 init 浪費）
}

// Process-wide protection — Lambda function 容器內若有未捕獲的 rejection，
// 至少 log 出來而不讓整個 process crash（影響其他 in-flight request）
if (!global.__OR_PROCESS_HANDLERS_INSTALLED__) {
  global.__OR_PROCESS_HANDLERS_INSTALLED__ = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && (reason.stack || reason.message || reason));
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && (err.stack || err.message));
  });
}
const LIFF_ID = process.env.LIFF_ID || '';
const GOLD_PIG_LIFF_ID = process.env.GOLD_PIG_LIFF_ID || '';
const GOLD_PIG_BOOKING_API_KEY = process.env.GOLD_PIG_BOOKING_API_KEY || '';
const GOLD_PIG_DEMO_MODE = process.env.GOLD_PIG_DEMO_MODE === '1';
const GOLD_PIG_ALLOWED_ORIGINS = process.env.GOLD_PIG_ALLOWED_ORIGINS || 'https://twopenrice-ops.github.io,https://tw.openrice.com';
const _liffLotteryBuilt = buildLiffPermanentUrl(LIFF_ID, '/liff/lottery', '/liff/lottery');
const LIFF_LOTTERY_PUSH_URL = /^https:\/\/liff\.line\.me\//i.test(_liffLotteryBuilt) ? _liffLotteryBuilt : '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
// 第二個 LINE OA（新 provider）：只收集 userId，完全獨立於主 OA
const LINE2_CHANNEL_SECRET = process.env.LINE2_CHANNEL_SECRET || '';
const LINE2_CHANNEL_ACCESS_TOKEN = process.env.LINE2_CHANNEL_ACCESS_TOKEN || '';
const LINE2_OA_KEY = process.env.LINE2_OA_KEY || 'oa2';
const LINE_OFFICIAL_ADD_FRIEND_URL_RAW = process.env.LINE_OFFICIAL_ADD_FRIEND_URL || '';

/**
 * LINE@ 加好友連結必須為絕對網址。若設成相對路徑（例如 liff/xxx），在 /liff/{邀請碼} 頁面上會變成 /liff/liff/xxx 而 404。
 */
function normalizeLineOfficialAddFriendUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^\/\//.test(candidate)) {
      candidate = `https:${candidate}`;
    } else if (/^line\.me\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return '';
    }
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

const LINE_OFFICIAL_ADD_FRIEND_URL = normalizeLineOfficialAddFriendUrl(LINE_OFFICIAL_ADD_FRIEND_URL_RAW);
if (LINE_OFFICIAL_ADD_FRIEND_URL_RAW && !LINE_OFFICIAL_ADD_FRIEND_URL) {
  console.warn(
    'LINE_OFFICIAL_ADD_FRIEND_URL is set but invalid (use full https URL, e.g. https://line.me/R/ti/p/@xxx). Ignoring.'
  );
}
const LIFF_INVITE_BONUS_MAX = Number.parseInt(process.env.LIFF_INVITE_BONUS_MAX || '20', 10);
/** 每累計幾位好友完成加好友任務，邀請人可獲 1 次加碼刮次（預設 2） */
const LIFF_INVITE_FRIENDS_PER_DRAW = Math.max(
  1,
  Number.parseInt(process.env.LIFF_INVITE_FRIENDS_PER_DRAW || '2', 10) || 2
);
const LIFF_LINE_USER_BCRYPT_ROUNDS = Number.parseInt(process.env.LIFF_LINE_USER_BCRYPT_ROUNDS || '6', 10);
/** 自訂 LIFF 兌換說明（可含換行）；未設定則使用預設文案 */
const LIFF_REDEMPTION_NOTE = process.env.LIFF_REDEMPTION_NOTE || '';
/** LIFF 內「官方活動／完整辦法」超連結（預設：OpenRice 春日活動頁） */
const LIFF_CAMPAIGN_PAGE_URL =
  process.env.LIFF_CAMPAIGN_PAGE_URL || 'https://tinyurl.com/mv3f9wfv';

/** LINE push 圖片訊息需公開 HTTPS URL；未設定則中獎推播不含餐籃圖 */
function normalizeLinePushPublicBaseUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** Netlify 會注入 URL（https 主網域）；未手動設 LINE_PUSH_PUBLIC_BASE_URL 時用此組圖片給 LINE 抓取 */
const LINE_PUSH_PUBLIC_BASE_URL = normalizeLinePushPublicBaseUrl(
  process.env.LINE_PUSH_PUBLIC_BASE_URL ||
    process.env.PUBLIC_SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    ''
);

/** 後台上傳圖推播、/p/line-media 公開網址組裝（LINE 僅接受 https 圖片網址） */
function resolvePublicSiteOrigin(req) {
  if (LINE_PUSH_PUBLIC_BASE_URL) return LINE_PUSH_PUBLIC_BASE_URL;
  if (!req || typeof req.get !== 'function') return '';
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!host) return '';
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

/** 給 LINE 抓圖用，多來源去重；順序：已解析主網域 → 其餘環境變數 */
const LINE_PUSH_IMAGE_BASE_CANDIDATES = (() => {
  const extra = buildPushImageBaseCandidates();
  const first = LINE_PUSH_PUBLIC_BASE_URL ? [LINE_PUSH_PUBLIC_BASE_URL] : [];
  const seen = new Set();
  const out = [];
  for (const o of [...first, ...extra]) {
    if (o && !seen.has(o)) {
      seen.add(o);
      out.push(o);
    }
  }
  return out;
})();
if (isProduction && LINE_CHANNEL_ACCESS_TOKEN && LINE_PUSH_IMAGE_BASE_CANDIDATES.length === 0) {
  console.warn(
    'LINE 推播圖片無 HTTPS 來源：請設定 LINE_PUSH_IMAGE_BASE_URL、LINE_PUSH_PUBLIC_BASE_URL、PUBLIC_SITE_URL，或確認託管平台有注入 URL（例如 Netlify 的 URL）。'
  );
}

function normalizeAdminLoginPath(rawPath) {
  const fallback = '/admin/login';
  if (typeof rawPath !== 'string') return fallback;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.startsWith('//')) return fallback;
  if (trimmed.length < 8) return fallback;
  if (/[^a-zA-Z0-9/_-]/.test(trimmed)) return fallback;
  return trimmed;
}

const ADMIN_LOGIN_PATH = normalizeAdminLoginPath(process.env.ADMIN_LOGIN_PATH || '/admin/login');
const ADMIN_LOGIN_THROTTLE_WINDOW_MIN = Number.parseInt(process.env.ADMIN_LOGIN_THROTTLE_WINDOW_MIN || '15', 10);
const ADMIN_LOGIN_MAX_ATTEMPTS = Number.parseInt(process.env.ADMIN_LOGIN_MAX_ATTEMPTS || '8', 10);
const ADMIN_LOGIN_POST_RATE_MAX = Number.parseInt(process.env.ADMIN_LOGIN_POST_RATE_MAX || '10', 10);

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL. Please configure Postgres connection string.');
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('Missing or weak JWT_SECRET. Use at least 32 characters.');
}

function resolveAssetDir(dirName, expectedFile) {
  const candidates = [
    path.join(__dirname, '..', dirName),
    path.join(__dirname, '..', '..', dirName),
    path.join(process.cwd(), dirName),
    path.join('/var/task', dirName),
    path.join('/var/task', 'src', dirName)
  ];
  for (const candidate of candidates) {
    const target = expectedFile ? path.join(candidate, expectedFile) : candidate;
    if (fs.existsSync(target)) return candidate;
  }
  return path.join(__dirname, '..', dirName);
}

/** Netlify Function 單實例建議小 pool，降低冷啟動建連成本 */
// SSL: Supabase 強制 SSL 連線，所以一律開（不依賴 NODE_ENV）
// Netlify Functions 不一定會設 NODE_ENV=production，導致 SSL 關閉 → 連線 timeout
const pgSslDisabled = process.env.PG_SSL_DISABLED === '1';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: pgSslDisabled ? false : { rejectUnauthorized: false },
  max: Number.parseInt(process.env.PG_POOL_MAX || '', 10) || 2,
  // 縮短到 5s：cold start 失敗時 fail-fast，避免 user 等 10s 才看到錯
  connectionTimeoutMillis: Number.parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '', 10) || 5000,
  // idle 連線 10s 內回收（< Supabase 端的 idle timeout，避免拿到被 server 切斷的連線）
  idleTimeoutMillis: 10000,
  // TCP keepalive：偵測網路中介設備偷殺 idle 連線
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000
});

// 防止 idle 連線在 client 端被 unhandled error 炸掉整個 process
pool.on('error', err => {
  console.error('pg pool idle client error:', err && (err.stack || err.message));
});

// 預設 skip DDL（Schema 已全在 Supabase migrations 管理，cold start 不需重跑）
// 想跑完整 DDL（譬如本機初始化新環境）→ 顯式設 RUN_DB_DDL_ON_BOOT=1
// 不依賴 isProduction（Netlify Functions 不一定設 NODE_ENV=production）
const skipDbDdlOnBoot = process.env.RUN_DB_DDL_ON_BOOT !== '1';

async function query(text, params = []) {
  return pool.query(text, params);
}

const authCore = createAuthCore({
  jwtSecret: JWT_SECRET,
  isProduction,
  adminLoginPath: ADMIN_LOGIN_PATH
});

const lotteryCore = {
  pickPrizeByQuantity,
  enrichPrizesWithHitRate
};

const viewStateCore = createViewStateCore({
  query,
  isProduction
});

const adminLoginThrottle = createAdminLoginThrottle({
  query,
  hmacSecret: JWT_SECRET,
  windowMinutes: ADMIN_LOGIN_THROTTLE_WINDOW_MIN,
  maxAttempts: ADMIN_LOGIN_MAX_ATTEMPTS
});

const linePush = createLinePushService({
  query,
  lineChannelAccessToken: LINE_CHANNEL_ACCESS_TOKEN
});

// 揪友賺哩引擎（MGM）：獨立模組，webhook 見面禮 / 里程碑 / 分享卡都走它
const mgmEngine = createMgmMilesEngine({
  query,
  linePush,
  liffId: process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || ''
});
const goldPigBookings = createGoldPigBookingService({ pool });

// Email provider 選擇：EMAIL_PROVIDER=surenotify|brevo；未設時有 SURENOTIFY_API_KEY 就用電子豹，否則 Brevo。
const emailProviderName = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase()
  || (process.env.SURENOTIFY_API_KEY ? 'surenotify' : 'brevo');
const emailProvider = emailProviderName === 'surenotify'
  ? createSureNotifyProvider({ query })
  : createEmailProvider({ query });
console.log('[email] provider =', emailProviderName, '/ configured =', emailProvider.isConfigured());

const flowEngine = createFlowEngine({
  query,
  pool,
  linePush,
  buildLineMessages: buildLineMessagesForLib
});

let initError = null;
const initPromise = initDb({
  query,
  adminUsername: ADMIN_USERNAME,
  adminPassword: ADMIN_PASSWORD,
  skipDdl: skipDbDdlOnBoot
}).catch(err => {
  initError = err;
  console.error('Database initialization failed:', err.message);
  return null;
});

const app = express();
const viewsDir = resolveAssetDir('views', 'index.ejs');
const publicDir = resolveAssetDir('public', 'style.css');

app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * Production 強制 HTTPS：Netlify CDN 一般會 301，但有些路徑不確定，這層做雙保險。
 * 只對 GET/HEAD redirect（其他方法 redirect 會掉 body，且 webhook 本就走 https）。
 */
app.use((req, res, next) => {
  if (!isProduction) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const proto = String(req.get('x-forwarded-proto') || req.protocol || '').toLowerCase();
  if (proto && proto !== 'https') {
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) return res.redirect(301, 'https://' + host + req.originalUrl);
  }
  next();
});
app.set('view engine', 'ejs');
app.set('views', viewsDir);
app.use(
  express.static(publicDir, {
    maxAge: isProduction ? '1d' : 0,
    etag: true
  })
);

// ----- /healthz：診斷 endpoint，不需 admin，不需 DB connection -----
// 用來確認環境變數設定是否完整 + Lambda 是否能起 init
app.get('/healthz', (req, res) => {
  // 從 DATABASE_URL 抽出 host:port 給 user 確認（不洩密碼）
  let dbHost = '';
  let dbPort = '';
  let dbProtocol = '';
  try {
    if (DATABASE_URL) {
      const u = new URL(DATABASE_URL);
      dbHost = u.hostname;
      dbPort = u.port || '5432';
      dbProtocol = u.protocol;
    }
  } catch (_e) { dbHost = 'invalid_url'; }
  res.json({
    ok: true,
    runtime: {
      node: process.version,
      isProduction,
      netlify: process.env.NETLIFY === 'true',
      lambda: !!process.env.AWS_LAMBDA_FUNCTION_NAME,
      nodeEnv: process.env.NODE_ENV || '(unset)'
    },
    env: {
      DATABASE_URL_set: !!DATABASE_URL,
      DATABASE_URL_host: dbHost,
      DATABASE_URL_port: dbPort,
      DATABASE_URL_protocol: dbProtocol,
      LIFF_ID_set: !!process.env.LIFF_ID,
      GAMES_LIFF_ID_set: !!process.env.GAMES_LIFF_ID,
      GOLD_PIG_LIFF_ID_set: !!GOLD_PIG_LIFF_ID,
      GOLD_PIG_DEMO_MODE,
      LINE_CHANNEL_ACCESS_TOKEN_set: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      ADMIN_PASSWORD_set: !!process.env.ADMIN_PASSWORD,
      JWT_SECRET_set: !!process.env.JWT_SECRET,
      PG_SSL_DISABLED: process.env.PG_SSL_DISABLED || '(unset, ssl enabled)',
      RUN_DB_DDL_ON_BOOT: process.env.RUN_DB_DDL_ON_BOOT || '(unset, skip DDL)'
    },
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    },
    initError: initError ? String(initError.message || initError).slice(0, 200) : null
  });
});

// ----- /healthz/db：實際打一次 DB 確認連線（5 秒 timeout）-----
app.get('/healthz/db', async (_req, res) => {
  const start = Date.now();
  try {
    const r = await query('SELECT NOW() AS now');
    res.json({
      ok: true,
      duration_ms: Date.now() - start,
      db_time: r.rows[0].now,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      duration_ms: Date.now() - start,
      error: String(err.message || err).slice(0, 500),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
    });
  }
});
app.post(
  '/webhooks/line',
  express.raw({ type: 'application/json' }),
  createLineWebhookHandler({
    pool,
    mgmEngine,
    channelSecret: LINE_CHANNEL_SECRET,
    inviteBonusMax: Number.isFinite(LIFF_INVITE_BONUS_MAX) ? LIFF_INVITE_BONUS_MAX : 20,
    inviteFriendsPerDraw: LIFF_INVITE_FRIENDS_PER_DRAW,
    linePushImageBaseCandidates: LINE_PUSH_IMAGE_BASE_CANDIDATES,
    liffLotteryPushUrl: LIFF_LOTTERY_PUSH_URL,
    linePush,
    flowEngine,
    goldPigBookings
  })
);
// 第二個 OA 的 webhook：只收集 userId 寫進 oa_contacts，完全獨立（自己的 secret/token）。
// 必須與主 webhook 一樣用 express.raw 取原始 body 驗簽，且掛在全域 express.json 之前。
app.post(
  '/webhooks/line2',
  express.raw({ type: 'application/json' }),
  createOaContactsWebhookHandler({
    pool,
    channelSecret: LINE2_CHANNEL_SECRET,
    channelAccessToken: LINE2_CHANNEL_ACCESS_TOKEN,
    oaKey: LINE2_OA_KEY
  })
);
// 上限調高：RFM 名單分塊上傳一批可達數百 KB（預設 100KB 會 request entity too large）
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLoginPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.max(3, ADMIN_LOGIN_POST_RATE_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

const adminLoginGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

app.use((req, res, next) => {
  if (req.path !== ADMIN_LOGIN_PATH) return next();
  if (req.method === 'POST') return adminLoginPostLimiter(req, res, next);
  if (req.method === 'GET') return adminLoginGetLimiter(req, res, next);
  return next();
});

app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/liff/auth', authLimiter);
app.use(authCore.authMiddleware);

app.use(async (_req, _res, next) => {
  try {
    await initPromise;
    // 不再因為 boot init 失敗就擋掉每個 request。
    // 場景：cold start 第一次 SELECT 1 撞 connection timeout → initError 被設
    // → 之後 lambda 容器即使 pool 已恢復也每個 request 都回 500
    // 改成：只 log，讓 request 自己嘗試 query；若真的連不上各自 timeout 失敗
    if (initError) {
      console.warn('initError present but allowing request to proceed:', String(initError.message || initError));
    }
    next();
  } catch (err) {
    next(err);
  }
});

// /admin 即時權限檢查（liveness）：授權原本只讀 7 天 JWT，登入後不再看 DB，
// 導致「停用/降級」要等到 token 過期才生效、甚至被降級者能自我復權。
// 這裡在每個 /admin request 讀一次 DB 現況：帳號不存在/非後台帳號/已停用/session 版本過舊 → 視為登出；
// 否則用 DB 的即時 role/is_admin 覆寫 req.authUser，讓停用與降級「立即生效」。
// DB 錯誤時 fail-open（沿用本專案對 initError 的容錯策略），僅記 log，避免暫時性 DB 抖動把管理員全鎖在外。
app.use(async (req, res, next) => {
  const au = req.authUser;
  // 注意：Express 預設路由大小寫不敏感（/ADMIN/... 也會命中 /admin 路由），
  // 所以這裡的前綴判斷也必須 toLowerCase，否則大寫路徑會繞過 liveness 檢查。
  const isAdminPath = String(req.path || '').toLowerCase().startsWith('/admin');
  if (au && au.uid && isAdminPath) {
    try {
      const r = await query('SELECT is_admin, role, is_active, sess_epoch FROM users WHERE id = $1', [au.uid]);
      const row = r.rows[0];
      const tokenSe = Number(au.se) || 0;
      if (!row || row.is_admin !== true || row.is_active === false || (Number(row.sess_epoch) || 0) !== tokenSe) {
        authCore.clearAuthCookie(res);
        req.authUser = null;
      } else {
        req.authUser.adm = true;
        req.authUser.role = row.role || 'admin';
      }
    } catch (e) {
      console.warn('admin liveness check failed (fail-open):', e && e.message);
    }
  }
  const cur = req.authUser;
  res.locals.currentRole = cur ? (cur.role || (cur.adm ? 'admin' : null)) : null;
  res.locals.currentUid = cur ? cur.uid : null;
  next();
});

registerWebRoutes(app, {
  query,
  pool,
  authCore,
  lotteryCore,
  viewStateCore,
  adminLoginPath: ADMIN_LOGIN_PATH,
  adminLoginThrottle,
  linePush,
  lineChannelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  inviteBonusMax: Number.isFinite(LIFF_INVITE_BONUS_MAX) ? LIFF_INVITE_BONUS_MAX : 20,
  inviteFriendsPerDraw: LIFF_INVITE_FRIENDS_PER_DRAW,
  liffLotteryPushUrl: LIFF_LOTTERY_PUSH_URL,
  linePushImageBaseCandidates: LINE_PUSH_IMAGE_BASE_CANDIDATES,
  resolvePublicSiteOrigin
});

registerAdminBroadcastRoutes(app, {
  query,
  pool,
  authCore,
  linePush,
  emailProvider,
  lineChannelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  resolvePublicSiteOrigin
});

registerAdminLeaderboardRoutes(app, {
  query,
  pool,
  authCore,
  linePush,
  lineChannelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  bookingLeaderboard,
  resolvePublicSiteOrigin
});

registerAdminMessagesRoutes(app, {
  query,
  authCore,
  buildLineMessages: buildLineMessagesForLib
});

registerAdminFlowsRoutes(app, { query, pool, flowEngine, authCore });

registerAdminKeywordRepliesRoutes(app, { query, authCore });

registerAdminUsersRoutes(app, { query, authCore });

registerAdminRestaurantsRoutes(app, { query, authCore });

registerAdminRfmRoutes(app, { query, pool, authCore });

registerAdminReferralsRoutes(app, { query, authCore });
registerAdminBookingRegRoutes(app, { query, authCore });

registerAdminHubRoutes(app, { query, authCore });

registerAdminDashboardRoutes(app, { query, authCore });

registerAdminEmailDomainRoutes(app, { authCore });

registerAdminLiffAnalyticsRoutes(app, { query, authCore });

registerAdminAttributionRoutes(app, { query, authCore });

registerAdminActivitiesRoutes(app, { query, pool, authCore });

registerAdminCouponsRoutes(app, { query, pool, authCore });

registerGamesRoutes(app, { query, pool });
registerMgmMilesRoutes(app, {
  query, authCore,
  mgmEngine,
  defaultLiffId: process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || ''
});

registerGoldPigRoutes(app, {
  pool,
  liffId: GOLD_PIG_LIFF_ID,
  bookingApiKey: GOLD_PIG_BOOKING_API_KEY,
  demoMode: GOLD_PIG_DEMO_MODE,
  allowedOrigins: GOLD_PIG_ALLOWED_ORIGINS,
  lineOfficialAddFriendUrl: LINE_OFFICIAL_ADD_FRIEND_URL
});

registerAdminRecipientListsRoutes(app, { query, pool, authCore, flowEngine });

registerAdminAccountsRoutes(app, { query, pool, authCore });

registerAdminOaContactsRoutes(app, { query, authCore, oaKey: LINE2_OA_KEY });

registerAdminRichMenuRoutes(app, { query, authCore });

registerAdminInsightRoutes(app, { query, authCore });

registerLiffRoutes(app, {
  query,
  pool,
  authCore,
  lotteryCore,
  viewStateCore,
  liffId: LIFF_ID,
  linePush,
  linePushImageBaseCandidates: LINE_PUSH_IMAGE_BASE_CANDIDATES,
  inviteBonusMax: Number.isFinite(LIFF_INVITE_BONUS_MAX) ? LIFF_INVITE_BONUS_MAX : 20,
  inviteFriendsPerDraw: LIFF_INVITE_FRIENDS_PER_DRAW,
  lineOfficialAddFriendUrl: LINE_OFFICIAL_ADD_FRIEND_URL,
  lineUserPasswordHashRounds: Number.isFinite(LIFF_LINE_USER_BCRYPT_ROUNDS) ? LIFF_LINE_USER_BCRYPT_ROUNDS : 6,
  liffRedemptionNote: LIFF_REDEMPTION_NOTE,
  liffCampaignPageUrl: LIFF_CAMPAIGN_PAGE_URL
});

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', req && req.method, req && req.path, '→', err && (err.stack || err.message));
  // JSON response 判斷：所有 fetch API 跟 admin/api endpoint 都回 JSON，避免前端拿到 plain text 無法解析
  const accept = (req && req.headers && req.headers['accept']) || '';
  const p = (req && req.path) || '';
  const wantsJson =
    accept.includes('application/json') ||
    p.startsWith('/admin/') && (
      p.includes('/api/') ||
      p.includes('/api') ||
      p.startsWith('/admin/broadcast/') ||
      p.startsWith('/admin/activities/api') ||
      p.startsWith('/admin/liff/')
    ) ||
    p.startsWith('/api/');  // 所有 /api/* (含 /api/games/*)
  if (wantsJson) {
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      detail: err && err.message ? String(err.message).slice(0, 500) : 'unknown'
    });
  }
  // HTML 頁面顯示更友善的訊息（含 error id 給 log 對照）
  const reqId = (req && req.get && req.get('x-nf-request-id')) || '';
  res.status(500).type('text/html').send(
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>Server error</title>
    <style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:24px;color:#1f2937;}
    h1{font-size:20px;margin:0 0 8px;}p{color:#6b7280;font-size:14px;line-height:1.6;}code{font-size:11px;color:#9ca3af;}
    a{color:#2563eb;}</style></head><body>
    <h1>暫時無法載入</h1>
    <p>伺服器處理時發生錯誤，請稍候再試一次。若持續發生請通知管理員。</p>
    <p><a href="javascript:location.reload()">重新整理</a> · <a href="/">回首頁</a></p>
    ${reqId ? `<p><code>request-id: ${reqId}</code></p>` : ''}
    </body></html>`
  );
});

module.exports = app;
