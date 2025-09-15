import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Middleware for parsing JSON and URL-encoded bodies
app.use(bodyParser.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));
app.use((req, _res, next) => {
  if (req.path === '/payme') {
    console.log('📥 HEADERS:', req.headers);
  }
  next();
});


// Health check endpoint
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// In-memory order storage
const orders = new Map(); // order_id -> { amount, state, ... }
let orderCounter = 1;

// Generate next order ID (7-digit padded)
function nextOrderId() {
  const id = String(orderCounter).padStart(7, '0');
  orderCounter += 1;
  return id;
}
// vaqtinchalik
console.log('HEADERS:', req.headers);



// Authentication helper for Payme
function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  const basicAuth = req.get('Authorization');
  let isAuthenticated = false;

  if (xAuth && xAuth === process.env.PAYME_KEY) isAuthenticated = true;
  if (!isAuthenticated && basicAuth && basicAuth.startsWith('Basic ')) {
    const decoded = Buffer.from(basicAuth.slice(6), 'base64').toString('utf8');
    const parts = decoded.split(':');
    const secret = parts[1] || parts[0];
    if (secret === process.env.PAYME_KEY) isAuthenticated = true;
  }

  if (!isAuthenticated) {
    return res.status(200).json({
      jsonrpc: '2.0',
      error: {
        code: -32504,
        message: { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещен', en: 'Unauthorized' }
      },
      id: req.body?.id ?? null
    });
  }
  return null;
}

// Response helpers
const ok = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

// Public API endpoints
app.get('/api/new-order', (_req, res) => {
  const orderId = nextOrderId();
  orders.set(orderId, { amount: 0, state: 'new' });
  res.json({ order_id: orderId });
});

app.get('/api/checkout-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amount = Number(req.query.amount || 0);
  if (!orderId || !amount) return res.json({ error: 'order_id va amount (tiyin) shart' });

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount });
  const url = `https://checkout.paycom.uz/${process.env.PAYME_MERCHANT_ID}?order_id=${orderId}&amount=${amount}&lang=uz`;
  res.json({ url });
});

// Click payment URL generation
app.get('/api/click-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amountTiyin = Number(req.query.amount || 0);
  if (!orderId || !amountTiyin) return res.json({ error: 'order_id va amount (tiyin) shart' });

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount: amountTiyin });
  const amountSoum = (amountTiyin / 100).toFixed(2);
  const url = new URL('https://my.click.uz/services/pay');
  url.searchParams.set('service_id', process.env.CLICK_SERVICE_ID);
  url.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  url.searchParams.set('transaction_param', orderId);
  url.searchParams.set('amount', amountSoum);
  if (process.env.CLICK_RETURN_URL) url.searchParams.set('return_url', process.env.CLICK_RETURN_URL);

  res.json({ url: url.toString() });
});

// Click callback handler
app.post('/click/callback', (req, res) => {
  const p = { ...req.body };
  const requiredFields = ['click_trans_id', 'service_id', 'merchant_trans_id', 'amount', 'action', 'sign_time', 'sign_string'];
  if (requiredFields.some(field => typeof p[field] === 'undefined')) {
    return res.json({ error: -1, error_note: 'Missing required fields' });
  }

  const orderId = String(p.merchant_trans_id);
  const order = orders.get(orderId);
  if (!order) return res.json({ error: -5, error_note: 'Order not found' });

  const action = Number(p.action);
  const amountStr = String(p.amount);
  const secret = process.env.CLICK_SECRET_KEY;

  if (action === 0) { // Prepare
    const expectedSign = `${p.click_trans_id}${p.service_id}${secret}${p.merchant_trans_id}${amountStr}${p.action}${p.sign_time}`.toLowerCase();
    if (expectedSign !== String(p.sign_string).toLowerCase()) {
      return res.json({ error: -1, error_note: 'Invalid sign (prepare)' });
    }
    if (Math.round(order.amount / 100) !== Math.round(Number(amountStr))) {
      return res.json({ error: -2, error_note: 'Incorrect amount' });
    }
    order.state = 'created';
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: orderId,
      merchant_prepare_id: orderId,
      error: 0,
      error_note: 'Success'
    });
  }

  if (action === 1) { // Complete
    if (typeof p.merchant_prepare_id === 'undefined') {
      return res.json({ error: -1, error_note: 'Missing field: merchant_prepare_id' });
    }
    const expectedSign = `${p.click_trans_id}${p.service_id}${secret}${p.merchant_trans_id}${p.merchant_prepare_id}${amountStr}${p.action}${p.sign_time}`.toLowerCase();
    if (expectedSign !== String(p.sign_string).toLowerCase()) {
      return res.json({ error: -1, error_note: 'Invalid sign (complete)' });
    }
    if (Number(p.error) === 0) {
      order.state = 'performed';
      order.perform_time = Date.now();
      return res.json({
        click_trans_id: p.click_trans_id,
        merchant_trans_id: orderId,
        merchant_confirm_id: orderId,
        error: 0,
        error_note: 'Success'
      });
    }
    order.state = 'canceled';
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: orderId,
      merchant_confirm_id: orderId,
      error: -9,
      error_note: 'Payment canceled'
    });
  }

  return res.json({ error: -3, error_note: 'Unknown action' });
});

app.post('/payme', (req, res, next) => {
  console.log('📥 AUTH HEADER:', req.headers.authorization);
  next();
}, paymeHandler);

// Payme JSON-RPC handler
app.post('/payme', (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;

  const { method, params, id } = req.body || {};
  if (!method || !params || !id) return res.json(err(id, -32600, { uz: 'Invalid request' }));

  try {
    switch (method) {
      case 'CheckPerformTransaction': {
        const { amount, account } = params;
        const orderId = String(account?.order_id || '');
        const order = orders.get(orderId);
        if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        if (+order.amount !== +amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
        return res.json(ok(id, { allow: true }));
      }
      case 'CreateTransaction': {
        const { id: txId, time, amount, account } = params;
        const orderId = String(account?.order_id || '');
        const order = orders.get(orderId);
        if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        if (order.state && order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
        if (+order.amount !== +amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
        order.state = 'created';
        order.paycom_transaction_id = txId;
        order.paycom_time = time;
        return res.json(ok(id, { transaction: txId, state: 1, create_time: time }));
      }
      case 'PerformTransaction': {
        const { id: txId } = params;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        if (order.state === 'performed') {
          return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time || 0 }));
        }
        order.state = 'performed';
        order.perform_time = Date.now();
        return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
      }
      case 'CancelTransaction': {
        const { id: txId, reason } = params;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        order.state = 'canceled';
        order.cancel_time = Date.now();
        order.cancel_reason = reason || 0;
        return res.json(ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }));
      }
      case 'CheckTransaction': {
        const { id: txId } = params;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        const stateMap = { new: 0, created: 1, performed: 2, canceled: -1 };
        return res.json(ok(id, {
          transaction: txId,
          state: stateMap[order.state] || 0,
          create_time: order.paycom_time || 0,
          perform_time: order.perform_time || 0,
          cancel_time: order.cancel_time || 0,
          reason: order.cancel_reason || null
        }));
      }
      default:
        return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
    }
  } catch (e) {
    console.error('PAYME ERROR:', e);
    return res.json(err(id, -32603, { uz: 'Server xatosi' }));
  }
});

// Fallback for root POST as JSON-RPC
app.post('/', (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;
  paymeHandler(req, res);
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for invalid POST requests
app.post('*', (req, res) => {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: { uz: 'Noto‘g‘ri endpoint' } },
    id: req.body?.id ?? null
  });
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
