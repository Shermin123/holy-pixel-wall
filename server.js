const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_DIR = path.join(ROOT, 'data');
const DB = path.join(DB_DIR, 'claims.json');
const MIN = 10;
const MAX = 999999;

// Ensure data dir exists (IMPORTANT FOR RENDER DISK)
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'uploads'), { recursive: true });

console.log('DB Path:', DB);
console.log('DB Exists:', fs.existsSync(DB));

function load() {
  try {
    if (!fs.existsSync(DB)) {
      console.log('No DB file, creating new');
      return { regions: [] };
    }
    const raw = fs.readFileSync(DB, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.regions? parsed : { regions: [] };
  } catch (e) {
    console.error('LOAD FAILED', e.message);
    return { regions: [] };
  }
}

// ATOMIC SAVE - never corrupts, works with Render Disk
function save(db) {
  try {
    const tmp = DB + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB);
    console.log('SAVED OK -', db.regions.length, 'regions -', new Date().toISOString());
    return true;
  } catch (e) {
    console.error('SAVE FAILED', e);
    return false;
  }
}

function expired(r) {
  if (!r || r.duration === 'permanent') return false;
  const MS_DAY = 86400000;
  let ms = MS_DAY * 30;
  if (r.duration === '3month') ms = MS_DAY * 90;
  if (r.duration === '6month') ms = MS_DAY * 182;
  if (r.duration === '1month') ms = MS_DAY * 30;
  if (r.duration === '1day') ms = MS_DAY;
  if (r.duration === 'daily') ms = MS_DAY * 10;
  return Date.now() - (r.claimedAt || 0) > ms;
}

function soldMap(db) {
  const m = new Map();
  const before = db.regions.length;
  db.regions = (db.regions || []).filter(r =>!expired(r));
  if (db.regions.length!== before) {
    console.log(`Cleaned ${before - db.regions.length} expired regions`);
  }
  for (const r of db.regions) {
    const cells = r.cells || [];
    if (cells.length) {
      cells.forEach(k => m.set(k, r));
    } else if (r.minC!= null) {
      for (let c = r.minC; c <= r.maxC; c++)
        for (let row = r.minR; row <= r.maxR; row++)
          m.set(c + ',' + row, r);
    }
  }
  return m;
}

function priceUnit(duration) {
  if (duration === 'permanent') return 50;
  if (duration === '6month') return 10;
  if (duration === '3month') return 1;
  return 0.50;
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
      const db = load();
      return json(res, 200, {
        ok: true,
        regions: db.regions.length,
        pixels: db.regions.reduce((n,r)=>n+(r.pixels||0),0),
        stripe:!!(process.env.STRIPE_SECRET_KEY),
        dbPath: DB,
        dbExists: fs.existsSync(DB)
      });
    }

    if (p === '/api/wall' && req.method === 'GET') {
      const db = load();
      const map = soldMap(db);
      // Only save if we cleaned expired
      if (map.size!== db.regions.reduce((a,r)=>a+(r.cells?.length||0),0)) {
        save(db);
      }
      return json(res, 200, { regions: db.regions, minBuy: MIN, maxBuy: MAX });
    }

    if (p === '/api/checkout' && req.method === 'POST') {
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key) return json(res, 400, { ok: false, error: 'Stripe not configured - Add STRIPE_SECRET_KEY in Render env' });
      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN) return json(res, 400, { ok: false, error: 'Need at least ' + MIN + ' blocks' });
      if (cells.length > MAX) return json(res, 400, { ok: false, error: 'Too many blocks' });

      // Check if already sold
      const db = load();
      const map = soldMap(db);
      for (const k of cells) {
        if (map.has(k)) return json(res, 409, { ok: false, error: 'Some blocks already owned - pick another area' });
      }

      const unit = priceUnit(data.duration || '1month');
      const totalCents = Math.round(cells.length * unit * 100);
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
      if (!stripeRes.ok) return json(res, 500, { ok: false, error: session.error?.message || 'Stripe error' });
      return json(res, 200, { ok: true, url: session.url });
    }

    if (p === '/api/claim' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN) return json(res, 400, { ok: false, error: 'Need at least ' + MIN });

      const db = load();
      const map = soldMap(db);
      for (const k of cells) {
        if (map.has(k)) return json(res, 409, { ok: false, error: 'Blocks owned - someone else bought while you were paying' });
      }

      let minC=1e9,maxC=-1,minR=1e9,maxR=-1;
      cells.forEach(k=>{const[c,r]=k.split(',').map(Number); if(!isNaN(c)&&!isNaN(r)){minC=Math.min(minC,c);maxC=Math.max(maxC,c);minR=Math.min(minR,r);maxR=Math.max(maxR,r);}});

      const newRegion = {
        id: crypto.randomUUID(),
        name: String(data.name||'ANON').slice(0,40),
        desc: String(data.desc||'').slice(0,120),
        media: data.media||'',
        mediaType: data.mediaType||'image',
        fit: 'cover',
        cropScale: data.cropScale||1,
        cropX: data.cropX??0.5,
        cropY: data.cropY??0.5,
        link: data.link||'',
        linkType: data.linkType||'none',
        duration: data.duration||'1month',
        paid: data.paid||0,
        claimedAt: Date.now(),
        cells,
        minC, maxC, minR, maxR,
        pixels: cells.length,
        color: '#4472c4'
      };

      db.regions.push(newRegion);
      const ok = save(db);
      if (!ok) return json(res, 500, { ok: false, error: 'Failed to save - disk full?' });

      console.log(`NEW CLAIM: ${newRegion.name} - ${cells.length} pixels - $${newRegion.paid}`);
      return json(res, 201, { ok: true, id: newRegion.id });
    }

    // Serve static files
    let file = p === '/'? '/index.html' : p;
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    console.error('SERVER ERROR', e);
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('Holy Pixel Wall running on ' + PORT);
  console.log('DB:', DB);
  console.log('DB exists:', fs.existsSync(DB));
  if (fs.existsSync(DB)) {
    try {
      const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
      console.log('Loaded regions:', db.regions?.length||0);
    } catch {}
  }
  console.log('========================================');
});