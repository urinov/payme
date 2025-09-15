// server.js — Payme (JSON-RPC) + Click + inkremental order_id (0000001, 0000002, ...)

import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildCheckoutUrl } from './utils/buildCheckoutUrl.js';
import { buildPrepareSign, buildCompleteSign } from './utils/clickSign.js';

// ───── init ───────────────────────────────────────────────────────────────────
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parsers (Payme — JSON-RPC, Click — x-www-form-urlencoded)
app.use(bodyParser.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// Small health check
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ───── "DB" (demo) ────────────────────────────────────────────────────────────
const orders = new Map(); // order_id -> { amount(=tiyin), state, ... }

// Incremental order counter (7-digit)
let orderCounter = 1; // 0000001
function nextOrderId() {
  const id = String(orderCounter).padStart(7, '0');
  orderCounter += 1;
  return id;
}

// ───── Helpers: auth + responses ──────────────────────────────────────────────
function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  const basic = req.get('Authorization');

  let okAuth = false;

  // 1) Biz yuboradigan X-Auth
  if (xAuth && xAuth === process.env.PAYME_KEY) okAuth = true;

  // 2) Payme sandbox yuboradigan Basic (merchant_id:secret yoki paycom:secret)
  if (!okAuth && basic && basic.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
    const parts = decoded.split(':');
    const secret = parts[1] || parts[0];
    if (secret === process.env.PAYME_KEY) okAuth = true;
  }

  if (!okAuth) {
    return res.status(200).json({
      jsonrpc: '2.0',
      error: {
        code:  -31055, // Неверная авторизация
        message: { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещен', en: 'Unauthorized' }
      },
      id: req.body?.id ?? null
    });
  }
  return null;
}

const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

// ───── Public API (order boshqaruvi) ──────────────────────────────────────────
app.get('/api/new-order', (_req, res) => {
  const id = nextOrderId();
  orders.set(id, { amount: 0, state: 'new' });
  res.json({ order_id: id });
});

app.get('/api/checkout-url', (req, res) => {
  const order_id = String(req.query.order_id || '');
  const amount   = Number(req.query.amount || 0); // tiyinda
  if (!order_id || !amount) return res.json({ error: 'order_id va amount (tiyin) shart' });

  // buyurtmani yangilab/yaratib qo'yamiz
  const prev = orders.get(order_id) || { amount: 0, state: 'new' };
  orders.set(order_id, { ...prev, amount });

  const url = buildCheckoutUrl({
    merchantId:     process.env.PAYME_MERCHANT_ID,
    orderId:        order_id,
    amountInTiyin:  amount,
    lang:           'uz',
    callbackUrl:    process.env.CALLBACK_RETURN_URL,
    currencyIso:    'UZS',
    description:    'To‘lov'
  });
  res.json({ url });
});

// Click redirect URL (foydalanuvchini Click’ga olib boradi)
app.get('/api/click-url', (req, res) => {
  const order_id     = String(req.query.order_id || '');
  const amount_tiyin = Number(req.query.amount || 0);
  if (!order_id || !amount_tiyin) return res.json({ error: 'order_id va amount (tiyin) shart' });

  const prev = orders.get(order_id) || { amount: 0, state: 'new' };
  orders.set(order_id, { ...prev, amount: amount_tiyin });

  const amount_soum = (amount_tiyin / 100).toFixed(2);

  const u = new URL('https://my.click.uz/services/pay');
  u.searchParams.set('service_id',  process.env.CLICK_SERVICE_ID);
  u.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  if (process.env.CLICK_MERCHANT_USER_ID) u.searchParams.set('merchant_user_id', process.env.CLICK_MERCHANT_USER_ID);
  u.searchParams.set('transaction_param', order_id);
  u.searchParams.set('amount', amount_soum);
  if (process.env.CLICK_RETURN_URL) u.searchParams.set('return_url', process.env.CLICK_RETURN_URL);

  res.json({ url: u.toString() });
});

// Click callback (prepare/complete)
app.post('/click/callback', (req, res) => {
  const p = { ...req.body };
  const required = ['click_trans_id','service_id','merchant_trans_id','amount','action','sign_time','sign_string'];
  for (const k of required) if (typeof p[k] === 'undefined') return res.json({ error: -1, error_note: `Missing field: ${k}` });

  const orderId = String(p.merchant_trans_id);
  const order = orders.get(orderId);
  if (!order) return res.json({ error: -5, error_note: 'Order not found' });

  const action = Number(p.action); // 0=prepare, 1=complete
  const amtStr = String(p.amount);
  const secret = process.env.CLICK_SECRET_KEY;

  if (action === 0) {
    const expected = buildPrepareSign({
      click_trans_id: p.click_trans_id,
      service_id: p.service_id,
      secret_key: secret,
      merchant_trans_id: p.merchant_trans_id,
      amount: amtStr,
      action: p.action,
      sign_time: p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) return res.json({ error: -1, error_note: 'Invalid sign (prepare)' });

    if (Math.round(order.amount / 100) !== Math.round(Number(amtStr))) {
      return res.json({ error: -2, error_note: 'Incorrect amount' });
    }

    order.state = 'created';
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: orderId,
      merchant_prepare_id: orderId,
      error: 0, error_note: 'Success'
    });
  }

  if (action === 1) {
    if (typeof p.merchant_prepare_id === 'undefined') return res.json({ error: -1, error_note: 'Missing field: merchant_prepare_id' });

    const expected = buildCompleteSign({
      click_trans_id: p.click_trans_id,
      service_id: p.service_id,
      secret_key: secret,
      merchant_trans_id: p.merchant_trans_id,
      merchant_prepare_id: p.merchant_prepare_id,
      amount: amtStr,
      action: p.action,
      sign_time: p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) return res.json({ error: -1, error_note: 'Invalid sign (complete)' });

    if (Number(p.error) === 0) {
      order.state = 'performed';
      order.perform_time = Date.now();
      return res.json({
        click_trans_id: p.click_trans_id,
        merchant_trans_id: orderId,
        merchant_confirm_id: orderId,
        error: 0, error_note: 'Success'
      });
    }
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: orderId,
      merchant_confirm_id: orderId,
      error: -9, error_note: 'Payment canceled'
    });
  }

  return res.json({ error: -3, error_note: 'Unknown action' });
});

// ───── Payme JSON-RPC handler (root + /payme) ─────────────────────────────────
const paymeHandler = (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;

  const { method, params, id } = req.body || {};
  try {
    switch (method) {
      case 'CheckPerformTransaction': {
        const { amount, account } = params || {};
        const orderId = String(account?.order_id || '');
        const order = orders.get(orderId);
        if (!order)                    return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' })); // account not found
        if (+order.amount !== +amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));  // wrong amount
        return res.json(ok(id, { allow: true }));
      }

      case 'CreateTransaction': {
        const { id: txId, time, amount, account } = params || {};
        const orderId = String(account?.order_id || '');
        const order = orders.get(orderId);
        if (!order)                         return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        if (order.state && order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
        if (+order.amount !== +amount)      return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));

        Object.assign(order, { state: 'created', paycom_transaction_id: txId, paycom_time: time });
        return res.json(ok(id, { transaction: txId, state: 1, create_time: time }));
      }

      case 'PerformTransaction': {
        const { id: txId } = params || {};
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));

        if (order.state === 'performed') {
          return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
        }
        order.state = 'performed';
        order.perform_time = Date.now();
        return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
      }

      case 'CancelTransaction': {
        const { id: txId, reason } = params || {};
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));

        order.state = 'canceled';
        order.cancel_time = Date.now();
        order.cancel_reason = reason ?? 0;
        return res.json(ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }));
      }

      case 'CheckTransaction': {
        const { id: txId } = params || {};
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        const map = { new: 0, created: 1, performed: 2, canceled: -1 };
        return res.json(ok(id, {
          transaction: txId,
          state: map[order.state] ?? 0,
          create_time: order.paycom_time ?? 0,
          perform_time: order.perform_time ?? 0,
          cancel_time: order.cancel_time ?? 0,
          reason: order.cancel_reason ?? null
        }));
      }

      default:
        return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
    }
  } catch (e) {
    if (process.env.DEBUG_PAYME === '1') console.error('PAYME ERROR:', e);
    return res.json(err(id ?? null, -32603, { uz: 'Server xatosi' }));
  }
};

app.post('/payme', paymeHandler);
app.post('/',      paymeHandler); // fallback: root POST ham JSON-RPC sifatida qabul qilinsin

// ───── static fayllar (API’lardan keyin!) ─────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// POST fallback — HTML o‘rniga JSON qaytsin
app.post('*', (req, res) => {
  return res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: { uz: 'Noto‘g‘ri endpoint' } },
    id: req.body?.id ?? null
  });
});

// ───── start server ───────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on port ' + port));
