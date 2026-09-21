const DEFAULT_PAGE_SIZE = 1000;

function buildRestaurantSearchUrl(name) {
  const query = encodeURIComponent(String(name || '').trim() || '餐廳');
  return `https://tw.openrice.com/zh-tw/taipei/restaurants?what=${query}&utm_source=email&utm_medium=crm&utm_campaign=revisit_email`;
}

function createBookingReportClient(options = {}) {
  const apiUrl = String(options.apiUrl || process.env.BOOKING_REPORT_API_URL || '').trim().replace(/\/+$/, '');
  const token = String(options.token || process.env.BOOKING_REPORT_API_TOKEN || '').trim();
  const fetchImpl = options.fetchImpl || global.fetch;

  function isConfigured() {
    return Boolean(apiUrl && token && typeof fetchImpl === 'function');
  }

  async function fetchPage({ from, to, offset = 0, limit = DEFAULT_PAGE_SIZE }) {
    if (!isConfigured()) throw new Error('booking_report_not_configured');
    const url = new URL(apiUrl);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('offset', String(Math.max(Number(offset) || 0, 0)));
    url.searchParams.set('limit', String(Math.min(Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1), DEFAULT_PAGE_SIZE)));
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.rows)) {
      const error = new Error('booking_report_request_failed');
      error.status = response.status;
      error.sourceError = payload && payload.error;
      throw error;
    }
    return {
      rows: payload.rows,
      total: Math.max(Number(payload.total) || 0, 0),
      limit: Number(payload.limit) || DEFAULT_PAGE_SIZE,
      offset: Number(payload.offset) || 0
    };
  }

  return { isConfigured, fetchPage };
}

module.exports = { DEFAULT_PAGE_SIZE, buildRestaurantSearchUrl, createBookingReportClient };
