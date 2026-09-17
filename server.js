'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const VIBE_BASE = process.env.VIBE_BASE || 'https://vibecode.bitrix24.tech';
const API_KEY = process.env.VIBE_API_KEY || '';
const MAIN_CATEGORY_ID = 0; // основная воронка

if (!API_KEY) {
  console.error('VIBE_API_KEY not set — dashboard will show errors.');
}

// Опознанность посетителя шлюз определяет по заголовку X-Vibe-User-Id:
// X-Vibe-Authorization может законно отсутствовать у гостевых ссылок и у
// пользователей без токена приложения, даже когда личность известна.
const IDENTITY_HEADER = 'x-vibe-user-id';

// Все /api/* требуют опознанного пользователя; без X-Vibe-User-Id — 401.
function authorize(req) {
  if (!req.headers[IDENTITY_HEADER]) {
    return { status: 401, message: 'Запрос не идентифицирован: отсутствует заголовок X-Vibe-User-Id. Доступ к API без опознанного пользователя запрещён.' };
  }
  return null;
}

// Человекочитаемые сообщения для частых кодов ответа VibeCode API.
function friendlyError(status, fallback) {
  switch (status) {
    case 401: return 'Неверный или отсутствующий ключ доступа (401). Проверьте X-Vibe-Authorization и срок действия ключа.';
    case 403: return 'Доступ запрещён (403). Ключу не хватает скоупов для этого запроса.';
    case 422: return 'Агрегация отклонена порталом (422): слишком дорогой запрос. Сузьте период или обратитесь к администратору портала.';
    case 502: return 'Шлюз или API временно недоступен (502). Попробуйте повторить позже.';
    case 504: return 'Превышен лимит ожидания ответа Vibe API. Повторите запрос позже.';
    default: return fallback || null;
  }
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const CURRENCY_SYMBOLS = {
  RUB: '\u20bd', USD: '$', EUR: '\u20ac', UAH: '\u20b4',
  KZT: '\u20b8', BYN: 'Br', GBP: '\u00a3', CNY: '\u00a5',
};

function currencySymbol(id) {
  return CURRENCY_SYMBOLS[String(id || '').toUpperCase()] || '';
}

// Кэш стадий воронки на 5 минут, чтобы не дёргать портал на каждый рендер.
let stageCache = null;
let stageCacheTs = 0;

async function vibeCall(routePath, init = {}, timeoutMs = 25000) {
  const headers = Object.assign({ 'X-Api-Key': API_KEY }, init.headers || {});
  let attempts = 0;
  for (;;) {
    attempts++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(VIBE_BASE + routePath, Object.assign({}, init, { headers, signal: ctrl.signal }));
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        const err = new Error(`Vibe API timeout (${Math.round(timeoutMs / 1000)}s): ${routePath}. Повторите позже.`);
        err.status = 504;
        err.body = null;
        throw err;
      }
      throw e;
    }
    clearTimeout(timer);
    const body = await res.json().catch(() => null);

    if (res.status === 429 && attempts < 5) {
      const advised = res.headers.get('Retry-After') || (body && body.error && body.error.retryAfter) || null;
      const wait = Math.min(advised === null ? Math.pow(2, attempts) : Number(advised), 60) + Math.random();
      console.warn(`Rate limited, retrying in ${Math.round(wait)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }

    if (!res.ok || !body || body.success !== true) {
      const err = new Error((body && body.error && body.error.message) || `Vibe API error (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
}

async function loadStages() {
  if (stageCache && Date.now() - stageCacheTs < 5 * 60 * 1000) return stageCache;
  const entityId = MAIN_CATEGORY_ID === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${MAIN_CATEGORY_ID}`;
  const { data } = await vibeCall(`/v1/statuses?filter[entityId]=${encodeURIComponent(entityId)}&limit=500`);
  stageCache = (data || [])
    .filter((s) => s && s.statusId && (MAIN_CATEGORY_ID === 0 || s.categoryId === MAIN_CATEGORY_ID))
    .map((s) => ({
      stageId: s.statusId,
      name: s.name || s.statusId,
      sort: s.sort || 0,
      semantics: s.stageSemanticId || s.semantics || null,
      stageSemanticId: s.stageSemanticId || s.semantics || null,
      color: s.color || null,
    }))
    .sort((a, b) => a.sort - b.sort);
  stageCacheTs = Date.now();
  return stageCache;
}

function dateRange(from, to) {
  const now = new Date();
  const defFrom = new Date(now);
  defFrom.setDate(defFrom.getDate() - 30);
  const gte = from ? `${from}T00:00:00` : `${defFrom.toISOString().slice(0, 10)}T00:00:00`;
  const lte = to ? `${to}T23:59:59` : `${now.toISOString().slice(0, 10)}T23:59:59`;
  return { from: gte.slice(0, 10), to: lte.slice(0, 10), filter: { $gte: gte, $lte: lte } };
}

// Валюты портала — чтобы денежные итоги никогда не смешивались.
// Агрегат не умеет группировать по currencyId (400), зато принимает его в filter,
// поэтому гоняем один агрегат на каждую валюту.
// Кэш валют портала на 30 минут — справочник почти не меняется.
let curCache = null;
let curCacheTs = 0;

async function loadCurrencies() {
  if (curCache && Date.now() - curCacheTs < 30 * 60 * 1000) return curCache;
  const { data } = await vibeCall('/v1/currencies/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: {}, limit: 50 }),
  });
  const rows = Array.isArray(data) ? data : [];
  const out = [];
  for (const r of rows) {
    const id = String((r && (r.id || r.currencyId || r.code)) || '').trim();
    if (!id || out.some((x) => x.id === id)) continue;
    out.push({ id, base: r.base === true || r.base === 'Y' || r.base === '1' });
    if (out.length >= 12) break;
  }
  curCache = out;
  curCacheTs = Date.now();
  return curCache;
}

async function loadStageAggregation(createdAt, currencyId) {
  const filter = Object.assign({ categoryId: MAIN_CATEGORY_ID }, { createdAt });
  if (currencyId) filter.currencyId = currencyId;
  const { data } = await vibeCall('/v1/deals/aggregate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      aggregate: [{ field: 'amount', function: 'sum' }],
      filter,
      groupBy: 'stageId',
    }),
  });
  return data || { count: 0, groups: [] };
}

async function loadRecent(createdAt) {
  const { data } = await vibeCall('/v1/deals/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: Object.assign({ categoryId: MAIN_CATEGORY_ID }, { createdAt }),
      sort: { createdAt: 'desc' },
      limit: 10,
      select: ['id', 'title', 'amount', 'stageId', 'categoryId', 'currency', 'assignedById', 'createdAt'],
    }),
  });
  return Array.isArray(data) ? data : [];
}

async function buildDashboard(from, to, onlyCurrency) {
  const range = dateRange(from, to);
  const [stages, currencies, recent] = await Promise.all([
    loadStages(),
    loadCurrencies(),
    loadRecent(range.filter),
  ]);
  let curList = currencies.map((c) => c.id);
  if (!curList.length) curList = ['RUB'];
  // Фильтр по валюте из панели: считаем только выбранную валюту.
  if (onlyCurrency && curList.includes(onlyCurrency)) curList = [onlyCurrency];

  // Агрегаты — СТРОГО последовательно. Параллельный залп агрегатов упирается
  // в лимит стоимости портала (422 AGGREGATION_LIMIT_EXCEEDED).
  const perCur = [];
  for (const cur of curList) {
    perCur.push({ cur, funnel: await loadStageAggregation(range.filter, cur) });
  }

  // Выигранными считаем только стадии с семантикой S (успех).
  const wonStage = (stages.find((s) => s.stageSemanticId === 'S') || {}).stageId || 'WON';

  // Строки воронки: количество суммарно, деньги — отдельно по каждой валюте.
  const stageRows = stages.map((st) => {
    let count = 0;
    const amounts = {};
    for (const { cur, funnel } of perCur) {
      const g = (funnel.groups || []).find((x) => x.stageId === st.stageId);
      const c = g ? (g.count || 0) : 0;
      const a = g && g.aggregates && g.aggregates.amount ? (g.aggregates.amount.sum || 0) : 0;
      count += c;
      amounts[cur] = a;
    }
    return Object.assign({}, st, { count, amounts });
  });

  const perCurrency = {};
  for (const cur of curList) {
    perCurrency[cur] = { symbol: currencySymbol(cur), openSum: 0, wonSum: 0, avgCheck: 0 };
  }
  let openCount = 0, wonCount = 0;
  for (const row of stageRows) {
    const closed = row.stageSemanticId === 'S' || row.stageSemanticId === 'F';
    if (closed) continue;
    openCount += row.count;
    for (const cur of curList) {
      perCurrency[cur].openSum += (row.amounts[cur] || 0);
    }
  }
  for (const { cur, funnel } of perCur) {
    const g = (funnel.groups || []).find((x) => x.stageId === wonStage);
    const c = g ? (g.count || 0) : 0;
    const a = g && g.aggregates && g.aggregates.amount ? (g.aggregates.amount.sum || 0) : 0;
    perCurrency[cur].wonSum = a;
    perCurrency[cur].avgCheck = c ? a / c : 0;
  }
  wonCount = perCur.reduce((acc, { funnel }) => {
    const g = (funnel.groups || []).find((x) => x.stageId === wonStage);
    return acc + (g ? (g.count || 0) : 0);
  }, 0);

  const totalCount = stageRows.reduce((a, r) => a + r.count, 0);
  const conversion = totalCount ? (wonCount / totalCount) * 100 : 0;

  return {
    period: { from, to },
    currency: curList.length === 1 ? curList[0] : null,
    multiCurrency: curList.length > 1,
    currencies: curList.map((c) => ({ id: c, symbol: currencySymbol(c) })),
    stages: stageRows,
    summary: {
      totalCount,
      openCount,
      wonCount,
      conversion,
      perCurrency,
    },
    recent: recent.map((d) => ({
      id: d.id,
      title: d.title || `Сделка #${d.id}`,
      amount: d.amount || 0,
      currency: currencySymbol(d.currency || d.currencyId),
      currencyId: d.currency || d.currencyId || null,
      stageId: d.stageId,
      stageName: (stages.find((s) => s.stageId === d.stageId) || {}).name || d.stageId,
      stageColor: (stages.find((s) => s.stageId === d.stageId) || {}).color || null,
      responsibleId: d.assignedById,
      createdAt: d.createdAt,
    })),
  };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // Все /api/* требуют опознанного пользователя (X-Vibe-User-Id), иначе 401.
    if (pathname.startsWith('/api/')) {
      const denied = authorize(req);
      if (denied) {
        return sendJson(res, denied.status, {
          success: false,
          error: { code: 'UNAUTHORIZED', message: denied.message },
        });
      }
    }

    // Открытый health-check для платформы (вне /api).
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (pathname === '/api/me') {
      const upstream = await fetch(VIBE_BASE + '/v1/me', {
        headers: { 'X-Api-Key': API_KEY },
      });
      const body = await upstream.json().catch(() => null);
      if (!upstream.ok || !body || body.success !== true) {
        const code = body && body.error && body.error.code || 'VIBE_ERROR';
        return sendJson(res, upstream.status, {
          success: false,
          error: { code, message: friendlyError(upstream.status, code), details: body },
        });
      }
      const me = body.data || body;
      return sendJson(res, 200, {
        success: true,
        accessMode: 'READONLY',
        me: {
          type: me.type || me.keyType || null,
          scopes: me.scopes || me.scope || null,
          accessMode: me.accessMode || me.accessModeLevel || 'READONLY',
          portal: me.portal || me.portalDomain || null,
          owner: me.owner || null,
        },
      });
    }

    if (pathname === '/api/meta') {
      const [stages, currencies] = await Promise.all([loadStages(), loadCurrencies()]);
      return sendJson(res, 200, {
        success: true,
        portal: (process.env.PORTAL_NAME || '').trim() || null,
        stages,
        currencies: currencies.map((c) => ({ id: c.id, symbol: currencySymbol(c.id), base: !!c.base })),
        mainCategoryId: MAIN_CATEGORY_ID,
      });
    }

    if (pathname === '/api/data') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const currency = (url.searchParams.get('currency') || '').trim();
      const range = dateRange(from, to);
      const data = await buildDashboard(range.from, range.to, currency);
      return sendJson(res, 200, { success: true, data });
    }

    // Статика — каталог public.
    let file = pathname === '/' ? '/index.html' : pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    console.error('Request error:', err);
    const code = err.body && err.body.error && err.body.error.code || 'INTERNAL';
    sendJson(res, err.status || 500, {
      success: false,
      error: { code, message: friendlyError(err.status, err.message) },
    });
  }
});

server.listen(PORT, () => {
  console.log(`CRM dashboard listening on :${PORT}`);
});