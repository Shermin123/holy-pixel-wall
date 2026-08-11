const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'data', 'claims.json');
const MIN = 10;
const PERM_PIXEL_CAP = 1000;
// Set ADMIN_KEY in Render Environment — required to delete/edit any claim
const ADMIN_KEY = process.env.ADMIN_KEY || '';

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

console.log('Storage:', USE_UPSTASH ? 'UPSTASH (PERMANENT FREE)' : 'FILE (WILL BE DELETED ON RENDER FREE)');

async function upstashGet() {
  try {
    const res = await fetch(UPSTASH_URL + '/get/wall_data', {
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
    });
    const j = await res.json();
    if (!j.result) return { regions: [] };
    return JSON.parse(j.result);
  } catch (e) {
    console.error('Upstash get failed', e);
    return { regions: [] };
  }
}

async function upstashSet(db) {
  try {
    const val = JSON.stringify(db);
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', 'wall_data', val])
    });
    const j = await res.json();
    console.log('Upstash saved', j);
    return true;
  } catch (e) {
    console.error('Upstash save failed', e);
    return false;
  }
}

function fileLoad() {
  try {
    if (!fs.existsSync(DB_FILE)) return { regions: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return { regions: [] }; }
}
function fileSave(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return true;
  } catch { return false; }
}

async function load() {
  if (USE_UPSTASH) return await upstashGet();
  return fileLoad();
}

async function save(db) {
  if (USE_UPSTASH) {
    const ok = await upstashSet(db);
    fileSave(db);
    return ok;
  }
  return fileSave(db);
}

function expired(r) {
  if (!r || r.duration === 'permanent') return false;
  const MS_DAY = 86400000;
  let ms = MS_DAY * 30;
  if (r.duration === '3month') ms = MS_DAY * 90;
  if (r.duration === '6month') ms = MS_DAY * 182;
  if (r.duration === '1day') ms = MS_DAY;
  if (r.duration === 'daily') ms = MS_DAY * 10;
  return Date.now() - (r.claimedAt || 0) > ms;
}

function permanentUsed(db) {
  let n = 0;
  (db.regions || []).forEach(r => {
    if (!r || r.duration !== 'permanent' || expired(r)) return;
    n += (r.pixels || (r.cells && r.cells.length) || 0);
  });
  return n;
}

function soldMap(db) {
  const m = new Map();
  db.regions = (db.regions || []).filter(r => !expired(r));
  for (const r of db.regions) {
    const cells = r.cells || [];
    if (cells.length) cells.forEach(k => m.set(k, r));
  }
  return m;
}

function priceUnit(d) {
  if (d === 'permanent') return 50;
  if (d === '6month') return 10;
  if (d === '3month') return 1;
  return 0.10; // 30 days
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      const db = await load();
      return json(res, 200, {
        ok: true,
        regions: (db.regions || []).length,
        storage: USE_UPSTASH ? 'upstash-permanent' : 'file-temp-will-delete'
      });
    }
    if (p === '/api/wall' && req.method === 'GET') {
      const db = await load();
      soldMap(db);
      return json(res, 200, { regions: db.regions });
    }
    if (p === '/api/checkout' && req.method === 'POST') {
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key) return json(res, 400, { ok: false, error: 'Stripe not configured' });
      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN) return json(res, 400, { ok: false, error: 'Need at least ' + MIN });

      const db = await load();
      const map = soldMap(db);
      for (const k of cells) if (map.has(k)) return json(res, 409, { ok: false, error: 'Already owned' });

      if ((data.duration || '') === 'permanent') {
        const used = permanentUsed(db);
        const left = Math.max(0, PERM_PIXEL_CAP - used);
        if (left <= 0) return json(res, 400, { ok: false, error: 'No permanent pixels left (limit ' + PERM_PIXEL_CAP + ')' });
        if (cells.length > left) return json(res, 400, { ok: false, error: 'Only ' + left + ' permanent pixels left' });
      }

      const unit = priceUnit(data.duration || '1month');
      const totalCents = Math.round(cells.length * unit * 100);
      if (totalCents < 50) return json(res, 400, { ok: false, error: 'Amount too small for Stripe (min $0.50)' });
      const publicUrl = (process.env.PUBLIC_URL || 'https://holy-pixel-wall.onrender.com').replace(/\/$/, '');

      const params = new URLSearchParams();
      params.append('mode', 'payment');
      params.append('success_url', publicUrl + '/?paid=1&session_id={CHECKOUT_SESSION_ID}');
      params.append('cancel_url', publicUrl + '/?canceled=1');
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append('line_items[0][price_data][product_data][name]', 'Holy Pixel Wall — ' + cells.length + ' pixels');
      params.append('line_items[0][price_data][unit_amount]', String(totalCents));
      params.append('line_items[0][quantity]', '1');

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });
      const session = await stripeRes.json();
      if (!stripeRes.ok) return json(res, 500, { ok: false, error: (session.error && session.error.message) || 'Stripe error' });
      return json(res, 200, { ok: true, url: session.url });
    }
    if (p === '/api/claim' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN) return json(res, 400, { ok: false, error: 'Need ' + MIN });

      const db = await load();
      if ((data.duration || '') === 'permanent') {
        const used = permanentUsed(db);
        const left = Math.max(0, PERM_PIXEL_CAP - used);
        if (left <= 0) return json(res, 400, { ok: false, error: 'No permanent pixels left (limit ' + PERM_PIXEL_CAP + ')' });
        if (cells.length > left) return json(res, 400, { ok: false, error: 'Only ' + left + ' permanent pixels left' });
      }
      const map = soldMap(db);
      for (const k of cells) if (map.has(k)) return json(res, 409, { ok: false, error: 'Blocks owned' });

      let minC = 1e9, maxC = -1, minR = 1e9, maxR = -1;
      cells.forEach(k => {
        const [c, r] = k.split(',').map(Number);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      });

      db.regions.push({
        id: crypto.randomUUID(),
        name: String(data.name || 'ANON').slice(0, 40),
        desc: String(data.desc || '').slice(0, 120),
        media: data.media || '',
        mediaType: data.mediaType || 'image',
        fit: 'cover',
        cropScale: data.cropScale || 1,
        cropX: data.cropX != null ? data.cropX : 0.5,
        cropY: data.cropY != null ? data.cropY : 0.5,
        link: data.link || '',
        linkType: data.linkType || 'none',
        duration: data.duration || '1month',
        paid: data.paid || 0,
        claimedAt: Date.now(),
        cells, minC, maxC, minR, maxR,
        pixels: cells.length
      });

      const ok = await save(db);
      if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
      return json(res, 201, { ok: true });
    }

    // ---- ADMIN: list / delete / clear claims (requires ADMIN_KEY) ----
    function requireAdmin(data) {
      if (!ADMIN_KEY) return 'Set ADMIN_KEY env var on Render first';
      const key = (data && data.key) || url.searchParams.get('key') || '';
      if (!key || key !== ADMIN_KEY) return 'Invalid admin key';
      return null;
    }

    if (p === '/api/admin/list' && req.method === 'GET') {
      const err = requireAdmin({});
      if (err && url.searchParams.get('key') !== ADMIN_KEY) {
        return json(res, 401, { ok: false, error: err || 'Unauthorized' });
      }
      if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) {
        return json(res, 401, { ok: false, error: 'Unauthorized' });
      }
      const db = await load();
      soldMap(db);
      const list = (db.regions || []).map(r => ({
        id: r.id,
        name: r.name,
        desc: r.desc,
        pixels: r.pixels || (r.cells && r.cells.length) || 0,
        duration: r.duration,
        paid: r.paid,
        link: r.link,
        mediaType: r.mediaType,
        hasMedia: !!(r.media && r.media.length),
        claimedAt: r.claimedAt,
        minC: r.minC, maxC: r.maxC, minR: r.minR, maxR: r.maxR
      }));
      return json(res, 200, { ok: true, count: list.length, regions: list });
    }

    if (p === '/api/admin/delete' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const err = requireAdmin(data);
      if (err) return json(res, 401, { ok: false, error: err });
      if (!data.id) return json(res, 400, { ok: false, error: 'Missing claim id' });
      const db = await load();
      const before = (db.regions || []).length;
      db.regions = (db.regions || []).filter(r => r.id !== data.id);
      if (db.regions.length === before) return json(res, 404, { ok: false, error: 'Claim not found' });
      const ok = await save(db);
      if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
      return json(res, 200, { ok: true, removed: data.id, remaining: db.regions.length });
    }

    if (p === '/api/admin/clear' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const err = requireAdmin(data);
      if (err) return json(res, 401, { ok: false, error: err });
      if (data.confirm !== 'DELETE_ALL') {
        return json(res, 400, { ok: false, error: 'Send confirm: DELETE_ALL' });
      }
      const db = { regions: [] };
      const ok = await save(db);
      if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
      return json(res, 200, { ok: true, remaining: 0 });
    }

    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) { json(res, 500, { ok: false, error: e.message }); }
});

server.listen(PORT, () => console.log('Wall running on ' + PORT + ' with ' + (USE_UPSTASH ? 'PERMANENT STORAGE' : 'TEMP FILE')));
