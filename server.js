const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB = path.join(ROOT, 'data', 'claims.json');
const MIN = 100, MAX = 400;

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'uploads'), { recursive: true });

function load() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch { return { regions: [] }; }
}
function save(db) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}
function expired(r) {
  if (!r || r.duration === 'permanent') return false;
  const ms = r.duration === '1day' ? 864e5 : 864e5 * 10;
  return Date.now() - (r.claimedAt || 0) > ms;
}
function soldMap(db) {
  const m = new Map();
  db.regions = (db.regions || []).filter(r => !expired(r));
  for (const r of db.regions) {
    const cells = r.cells || [];
    if (cells.length) cells.forEach(k => m.set(k, r));
    else {
      for (let c = r.minC; c <= r.maxC; c++)
        for (let row = r.minR; row <= r.maxR; row++)
          m.set(c + ',' + row, r);
    }
  }
  return m;
}
function priceUnit(duration) {
  if (duration === 'permanent') return 50;
  if (duration === '1day') return 0.1;
  return 0.25;
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
      return json(res, 200, {
        ok: true,
        shared: true,
        stripe: !!(process.env.STRIPE_SECRET_KEY)
      });
    }

    if (p === '/api/wall' && req.method === 'GET') {
      const db = load();
      soldMap(db);
      save(db);
      return json(res, 200, { regions: db.regions, minBuy: MIN, maxBuy: MAX });
    }

    // --- Stripe Checkout ---
    if (p === '/api/checkout' && req.method === 'POST') {
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key) {
        return json(res, 400, { ok: false, error: 'Stripe not configured — set STRIPE_SECRET_KEY on Render' });
      }
      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN || cells.length > MAX) {
        return json(res, 400, { ok: false, error: 'Need ' + MIN + '-' + MAX + ' blocks' });
      }
      const unit = priceUnit(data.duration || 'daily');
      const totalCents = Math.round(cells.length * unit * 100);
      if (totalCents < 50) {
        return json(res, 400, { ok: false, error: 'Amount too small for Stripe' });
      }

      const publicUrl = (process.env.PUBLIC_URL || 'https://holy-pixel-wall.onrender.com').replace(/\/$/, '');
      const params = new URLSearchParams();
      params.append('mode', 'payment');
      params.append('success_url', publicUrl + '/?paid=1&session_id={CHECKOUT_SESSION_ID}');
      params.append('cancel_url', publicUrl + '/?canceled=1');
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append('line_items[0][price_data][product_data][name]', 'Holy Pixel Wall — ' + cells.length + ' pixels');
      params.append('line_items[0][price_data][unit_amount]', String(totalCents));
      params.append('line_items[0][quantity]', '1');
      params.append('metadata[pixels]', String(cells.length));
      params.append('metadata[name]', String(data.name || '').slice(0, 40));

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });
      const session = await stripeRes.json();
      if (!stripeRes.ok) {
        return json(res, 500, {
          ok: false,
          error: (session.error && session.error.message) || 'Stripe error'
        });
      }
      return json(res, 200, { ok: true, url: session.url, id: session.id });
    }

    if (p === '/api/claim' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN || cells.length > MAX)
        return json(res, 400, { ok: false, error: 'Need ' + MIN + '-' + MAX + ' blocks' });
      const db = load();
      const map = soldMap(db);
      for (const k of cells) {
        if (map.has(k)) return json(res, 409, { ok: false, error: 'Blocks owned' });
      }
      let minC = 1e9, maxC = -1, minR = 1e9, maxR = -1;
      cells.forEach(k => {
        const [c, r] = k.split(',').map(Number);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      });
      const region = {
        id: crypto.randomUUID(),
        name: String(data.name || 'ANON').slice(0, 40),
        desc: String(data.desc || '').slice(0, 120),
        media: data.media || '',
        mediaType: data.mediaType || 'image',
        fit: data.fit || 'contain',
        link: data.link || '',
        linkType: data.linkType || 'none',
        duration: data.duration || 'daily',
        paid: data.paid || 0,
        claimedAt: Date.now(),
        cells, minC, maxC, minR, maxR,
        pixels: cells.length,
        color: '#4472c4'
      };
      db.regions.push(region);
      save(db);
      return json(res, 201, { ok: true, region });
    }

    // static files
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('Shared Holy Pixel Wall: http://localhost:' + PORT);
  console.log('Stripe:', process.env.STRIPE_SECRET_KEY ? 'ON' : 'OFF (set STRIPE_SECRET_KEY)');
});