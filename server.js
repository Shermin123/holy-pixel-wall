const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB = path.join(ROOT, 'data', 'claims.json');
const MIN = 10, MAX = 999999;

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
  const MS_DAY = 86400000;
  let ms = MS_DAY * 30; // 1month default
  if (r.duration === '3month') ms = MS_DAY * 90;
  if (r.duration === '6month') ms = MS_DAY * 182;
  if (r.duration === '1month') ms = MS_DAY * 30;
  // legacy support
  if (r.duration === '1day') ms = MS_DAY;
  if (r.duration === 'daily') ms = MS_DAY * 10;
  return Date.now() - (r.claimedAt || 0) > ms;
}
function soldMap(db) {
  const m = new Map();
  db.regions = (db.regions