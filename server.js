/**
 * GURUKUL ENERGIES - PUBLIC TENANT PORTAL SERVER (zero dependencies, Node 16+)
 *
 * Public  : GET  /                    portal page (static files in ./public)
 *           GET  /api/bill?code=12345 ONE bill by its 5-digit code (rate limited)
 * Private : POST /api/admin/upsert    {bill}         } require header
 *           POST /api/admin/delete    {billNo}       } x-admin-key: $ADMIN_KEY
 *           POST /api/admin/replace   {records:[..]} }
 *
 * Payments (Razorpay): GET /api/config, POST /api/pay/order, POST /api/pay/verify,
 *                       POST /api/razorpay/webhook  (marks the bill PAID automatically)
 *
 * Env: PORT, ADMIN_KEY (required), DATA_DIR (default ./data - put on a persistent disk)
 *      RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET  (enable online payments)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'bills.json');
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const PAYMENTS_ENABLED = !!(RZP_KEY_ID && RZP_KEY_SECRET);

if (!ADMIN_KEY || ADMIN_KEY.length < 12) {
  console.error('FATAL: set ADMIN_KEY (at least 12 characters) before starting.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=UTF-8', '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=UTF-8',
  '.xml': 'application/xml; charset=UTF-8'
};

// ---------- storage ----------
let bills = [];
try { if (fs.existsSync(DB_FILE)) bills = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('Could not read DB:', e.message); }
if (!Array.isArray(bills)) bills = [];

function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bills, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomic
}
const last5Of = b => (b.last5Digits || String(b.billNo || '').replace(/[^A-Za-z0-9]/g, '').slice(-5)).toUpperCase();

// ---------- rate limiting (per IP) ----------
const hits = new Map(); // ip -> {count, reset}
function limited(ip, max, windowMs, bucket) {
  const k = bucket + ':' + ip, now = Date.now();
  let h = hits.get(k);
  if (!h || now > h.reset) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
  h.count++;
  return h.count > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 60000).unref();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? xf.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function sendJson(res, status, obj, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }, extra));
  res.end(JSON.stringify(obj));
}
function isAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const real = Buffer.from(ADMIN_KEY);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
  req.on('end', () => { try { cb(null, JSON.parse(body || '{}')); } catch (e) { cb(e); } });
}

// ---------- Razorpay helpers ----------
function rzpRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const base = new URL(process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com'); // override only for testing
    const lib = base.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: base.hostname, port: base.port || undefined, path: '/v1' + apiPath, method,
      auth: RZP_KEY_ID + ':' + RZP_KEY_SECRET,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }, resp => {
      let out = '';
      resp.on('data', c => out += c);
      resp.on('end', () => {
        let j = {}; try { j = JSON.parse(out); } catch (_) {}
        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(j);
        else reject(new Error('Razorpay ' + resp.statusCode + ': ' + ((j.error && j.error.description) || out)));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Razorpay timeout')));
    if (data) req.write(data);
    req.end();
  });
}
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function istStamp() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}`;
}
const METHOD_LABEL = { upi: 'UPI', card: 'Card', netbanking: 'Net Banking', wallet: 'Wallet', emi: 'EMI', paylater: 'Pay Later' };

// Confirms a payment directly with Razorpay (never trusts the browser), then marks the bill PAID.
async function settlePayment(orderId, paymentId) {
  const order = await rzpRequest('GET', '/orders/' + encodeURIComponent(orderId));
  let pay = await rzpRequest('GET', '/payments/' + encodeURIComponent(paymentId));
  if (pay.order_id !== orderId) throw new Error('Payment does not belong to this order');
  if (pay.status === 'authorized') pay = await rzpRequest('POST', '/payments/' + encodeURIComponent(paymentId) + '/capture', { amount: pay.amount, currency: pay.currency });
  if (pay.status !== 'captured') return { settled: false, status: pay.status };
  if (pay.amount !== order.amount) throw new Error('Amount mismatch');
  const billNo = order.notes && order.notes.billNo;
  const bill = bills.find(b => b.billNo === billNo);
  if (!bill) throw new Error('Bill not found for order ' + orderId);
  if (bill.status === 'PAID' && bill.paymentId === paymentId) return { settled: true, already: true };
  if (Math.round((parseFloat(bill.amount) || 0) * 100) !== pay.amount) console.warn('Paid amount differs from current bill amount for', billNo);
  bill.status = 'PAID';
  bill.gatewayPaid = true;
  bill.paymentId = paymentId;
  bill.orderId = orderId;
  bill.txnID = 'RZP/' + paymentId;
  bill.payMode = METHOD_LABEL[pay.method] || pay.method || 'Online';
  bill.paidDate = istStamp();
  bill.paidAmount = pay.amount / 100;
  persist();
  console.log('PAID', billNo, paymentId, bill.paidAmount);
  return { settled: true };
}

const PAID_FIELDS = ['status', 'txnID', 'payMode', 'paidDate', 'gatewayPaid', 'paymentId', 'orderId', 'paidAmount'];
// Keeps online payments safe from being reverted by a stale copy sent from the Billing Office.
function keepGatewayPayment(existing, incoming) {
  if (!existing || !existing.gatewayPaid) return incoming;
  if (incoming.forceStatus) return incoming;
  if (incoming.status === 'PAID') return Object.assign({}, incoming, { gatewayPaid: true, paymentId: existing.paymentId, orderId: existing.orderId, paidAmount: existing.paidAmount, txnID: existing.txnID, payMode: existing.payMode, paidDate: existing.paidDate });
  const out = Object.assign({}, incoming);
  PAID_FIELDS.forEach(f => { if (existing[f] !== undefined) out[f] = existing[f]; });
  return out;
}
function readRaw(req, cb) {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > 1e6) req.destroy(); else chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  // CORS only for the admin API (the billing office calls it from another origin)
  if (url.pathname.startsWith('/api/admin/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  // ----- public: one bill by code -----
  if (url.pathname === '/api/bill' && req.method === 'GET') {
    if (limited(ip, 40, 10 * 60 * 1000, 'lookup')) return sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': '600' });
    const code = (url.searchParams.get('code') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (code.length !== 5) return sendJson(res, 400, { error: 'Enter the 5-digit bill code' });
    const match = bills.find(b => last5Of(b) === code);
    if (!match) {
      // misses count extra, to slow down anyone guessing codes
      if (limited(ip, 15, 10 * 60 * 1000, 'miss')) return sendJson(res, 429, { error: 'Too many attempts' }, { 'Retry-After': '600' });
      return sendJson(res, 404, { error: 'Not found' });
    }
    return sendJson(res, 200, { bill: match });
  }

  // ----- payments config -----
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { payments: PAYMENTS_ENABLED, keyId: PAYMENTS_ENABLED ? RZP_KEY_ID : null });
  }

  // ----- create a Razorpay order for a bill (amount comes from the SERVER's bill, never the browser) -----
  if (url.pathname === '/api/pay/order' && req.method === 'POST') {
    if (!PAYMENTS_ENABLED) return sendJson(res, 503, { error: 'Online payment is not enabled' });
    if (limited(ip, 15, 10 * 60 * 1000, 'order')) return sendJson(res, 429, { error: 'Too many requests' });
    return readBody(req, async (err, p) => {
      if (err) return sendJson(res, 400, { error: 'Bad JSON' });
      try {
        const code = String(p.code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        const bill = code.length === 5 && bills.find(b => last5Of(b) === code);
        if (!bill) return sendJson(res, 404, { error: 'Bill not found' });
        if (String(bill.status).toUpperCase() === 'PAID') return sendJson(res, 409, { error: 'Bill is already paid' });
        const amount = Math.round((parseFloat(bill.amount) || 0) * 100);
        if (amount < 100) return sendJson(res, 400, { error: 'Nothing payable on this bill' });
        const order = await rzpRequest('POST', '/orders', {
          amount, currency: 'INR',
          receipt: ('GE' + last5Of(bill) + '-' + Date.now().toString(36)).slice(0, 40),
          notes: { billNo: bill.billNo, accountID: String(bill.accountID || '') }
        });
        return sendJson(res, 200, { orderId: order.id, amount: order.amount, currency: order.currency, keyId: RZP_KEY_ID, billNo: bill.billNo });
      } catch (e) { console.error(e.message); return sendJson(res, 502, { error: 'Could not start payment. Please try again.' }); }
    });
  }

  // ----- browser reports success: verify signature, then confirm with Razorpay -----
  if (url.pathname === '/api/pay/verify' && req.method === 'POST') {
    if (!PAYMENTS_ENABLED) return sendJson(res, 503, { error: 'Online payment is not enabled' });
    if (limited(ip, 30, 10 * 60 * 1000, 'verify')) return sendJson(res, 429, { error: 'Too many requests' });
    return readBody(req, async (err, p) => {
      if (err) return sendJson(res, 400, { error: 'Bad JSON' });
      try {
        const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = p;
        if (!oid || !pid || !sig || !safeEq(hmac(RZP_KEY_SECRET, oid + '|' + pid), sig)) return sendJson(res, 400, { error: 'Invalid payment signature' });
        const r = await settlePayment(oid, pid);
        return sendJson(res, 200, { success: !!r.settled, status: r.status || 'paid' });
      } catch (e) { console.error(e.message); return sendJson(res, 502, { error: 'Could not confirm payment yet. It will update automatically.' }); }
    });
  }

  // ----- Razorpay webhook: confirms payments even if the tenant closes the browser -----
  if (url.pathname === '/api/razorpay/webhook' && req.method === 'POST') {
    if (!PAYMENTS_ENABLED || !RZP_WEBHOOK_SECRET) { res.writeHead(503); return res.end(); }
    return readRaw(req, async (raw) => {
      if (!safeEq(hmac(RZP_WEBHOOK_SECRET, raw), req.headers['x-razorpay-signature'] || '')) { res.writeHead(400); return res.end('bad signature'); }
      try {
        const ev = JSON.parse(raw);
        const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
        if (pay && pay.order_id && (ev.event === 'payment.captured' || ev.event === 'order.paid' || ev.event === 'payment.authorized')) {
          await settlePayment(pay.order_id, pay.id);
        }
        res.writeHead(200); return res.end('ok');
      } catch (e) { console.error('webhook:', e.message); res.writeHead(500); return res.end('error'); } // Razorpay will retry
    });
  }

  // ----- admin: read all bills (used by the Billing Office to pull payment confirmations) -----
  if (url.pathname === '/api/admin/bills' && req.method === 'GET') {
    if (!isAdmin(req)) {
      if (limited(ip, 10, 10 * 60 * 1000, 'adminfail')) return sendJson(res, 429, { error: 'Too many requests' });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    return sendJson(res, 200, { bills });
  }

  // ----- admin: write API -----
  if (url.pathname.startsWith('/api/admin/') && req.method === 'POST') {
    if (!isAdmin(req)) {
      // only FAILED attempts count, so normal use is never throttled
      if (limited(ip, 10, 10 * 60 * 1000, 'adminfail')) return sendJson(res, 429, { error: 'Too many requests' });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    return readBody(req, (err, p) => {
      if (err) return sendJson(res, 400, { error: 'Bad JSON' });
      try {
        if (url.pathname === '/api/admin/upsert') {
          if (!p || !p.billNo) return sendJson(res, 400, { error: 'billNo required' });
          const i = bills.findIndex(b => b.billNo === p.billNo || (p.accountID && b.accountID === p.accountID && b.billDate === p.billDate));
          const incoming = keepGatewayPayment(i >= 0 ? bills[i] : null, p);
          const force = !!incoming.forceStatus; delete incoming.forceStatus;
          if (force && incoming.status !== 'PAID') PAID_FIELDS.forEach(f => { if (f !== 'status') delete (i >= 0 ? bills[i] : {})[f]; });
          if (i >= 0) bills[i] = Object.assign({}, bills[i], incoming); else bills.unshift(incoming);
        } else if (url.pathname === '/api/admin/delete') {
          bills = bills.filter(b => b.billNo !== p.billNo);
        } else if (url.pathname === '/api/admin/replace') {
          if (!Array.isArray(p.records)) return sendJson(res, 400, { error: 'records[] required' });
          const old = new Map(bills.map(b => [b.billNo, b]));
          bills = p.records.map(r => { const x = keepGatewayPayment(old.get(r.billNo), r); delete x.forceStatus; return x; });
        } else return sendJson(res, 404, { error: 'Unknown endpoint' });
        persist();
        return sendJson(res, 200, { success: true, count: bills.length });
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
    });
  }

  if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

  // ----- static files (only ./public) -----
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(p));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(filePath).pipe(res);
  });
});
server.listen(PORT, () => console.log(`Tenant portal running on port ${PORT} (${bills.length} bills loaded)`));
