// server.js — Payme + Click (to‘g‘ri tartib)

import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildCheckoutUrl } from './utils/buildCheckoutUrl.js';
import { buildPrepareSign, buildCompleteSign } from './utils/clickSign.js';

// ---- init ----
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// middleware
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true })); // Click POST x-www-form-urlencoded ham yuboradi
app.use(express.static(path.join(__dirname, 'public')));

// ---- "DB" ----
const orders = new Map(); // order_id -> { amount(=tiyin), state, ... }

// ---- HELPERS (Payme) ----
function requirePaymeAuth(req, res) {
  const auth = req.get('X-Auth');
  if (!auth || auth !== process.env.PAYME_KEY) {
    return res.status(200).json({
      jsonrpc: '2.0',
      error: { code: -32504, message: { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещен', en: 'Unauthorized' } },
      id: req.body?.id ?? null
    });
  }
  return null;
}
const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

// ===================== PAYME CALLBACK =====================
app.post('/payme', (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;

  const { method, params, id } = req.body || {};
  try {
    if (method === 'CheckPerformTransaction') {
      const { amount, account } = params;
      const orderId = String(account?.order_id || '');
      const order = orders.get(orderId);
      if (!order)                  return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
      if (+order.amount !== +amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
      return res.json(ok(id, { allow: true }));
    }

    if (method === 'CreateTransaction') {
      const { id: txId, time, amount, account } = params;
      const orderId = String(account?.order_id || '');
      const order = orders.get(orderId);
      if (!order)                         return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
      if (order.state && order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
      if (+order.amount !== +amount)      return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
      Object.assign(order, { state: 'created', paycom_transaction_id: txId, paycom_time: time });
      return res.json(ok(id, { transaction: txId, state: 1, create_time: time }));
    }

    if (method === 'PerformTransaction') {
      const { id: txId } = params;
      const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
      order.state = 'performed';
      order.perform_time = Date.now();
      return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
    }

    if (method === 'CancelTransaction') {
      const { id: txId, reason } = params;
      const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
      order.state = 'canceled';
      order.cancel_time = Date.now();
      order.cancel_reason = reason ?? 0;
      return res.json(ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }));
    }

    if (method === 'CheckTransaction') {
      const { id: txId } = params;
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

    return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
  } catch (e) {
    console.error(e);
    return res.json(err(id ?? null, -32603, { uz: 'Server xatosi' }));
  }
});

// ===================== CLICK: REDIRECT URL =====================
// my.click.uz/services/pay... havolani yasaydi
app.get('/api/click-url', (req, res) => {
  const order_id     = String(req.query.order_id || '');
  const amount_tiyin = Number(req.query.amount || 0);

  if (!order_id || !amount_tiyin) {
    return res.json({ error: 'order_id va amount (tiyin) shart' });
  }
  if (!orders.has(order_id)) {
    orders.set(order_id, { amount: amount_tiyin, state: 'new' });
  }

  const amount_soum = (amount_tiyin / 100).toFixed(2); // N.NN

  const u = new URL('https://my.click.uz/services/pay');
  u.searchParams.set('service_id',  process.env.CLICK_SERVICE_ID);
  u.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  // ixtiyoriy:
  if (process.env.CLICK_MERCHANT_USER_ID) {
    u.searchParams.set('merchant_user_id', process.env.CLICK_MERCHANT_USER_ID);
  }
  u.searchParams.set('transaction_param', order_id);
  u.searchParams.set('amount',            amount_soum);
  if (process.env.CLICK_RETURN_URL) {
    u.searchParams.set('return_url', process.env.CLICK_RETURN_URL);
  }

  res.json({ url: u.toString() });
});

// ===================== CLICK: CALLBACK (Prepare/Complete) =====================
app.post('/click/callback', (req, res) => {
  const p = Object.assign({}, req.body);

  // Minimal tekshiruv
  const required = ['click_trans_id','service_id','merchant_trans_id','amount','action','sign_time','sign_string'];
  for (const k of required) {
    if (typeof p[k] === 'undefined') {
      return res.json({ error: -1, error_note: `Missing field: ${k}` });
    }
  }

  const orderId = String(p.merchant_trans_id);
  const order   = orders.get(orderId);
  if (!order) return res.json({ error: -5, error_note: 'Order not found' });

  const action = Number(p.action);       // 0=prepare, 1=complete
  const amtStr = String(p.amount);       // Click N.NN format
  const secret = process.env.CLICK_SECRET_KEY;

  if (action === 0) {
    const expected = buildPrepareSign({
      click_trans_id: p.click_trans_id,
      service_id:     p.service_id,
      secret_key:     secret,
      merchant_trans_id: p.merchant_trans_id,
      amount:         amtStr,
      action:         p.action,
      sign_time:      p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) {
      return res.json({ error: -1, error_note: 'Invalid sign (prepare)' });
    }

    // Summani solishtirish: order.amount = tiyinda
    if (Math.round(order.amount / 100) !== Math.round(Number(amtStr))) {
      return res.json({ error: -2, error_note: 'Incorrect amount' });
    }

    order.state = 'created';
    return res.json({
      click_trans_id:       p.click_trans_id,
      merchant_trans_id:    orderId,
      merchant_prepare_id:  orderId,
      error: 0,
      error_note: 'Success'
    });
  }

  if (action === 1) {
    if (typeof p.merchant_prepare_id === 'undefined') {
      return res.json({ error: -1, error_note: 'Missing field: merchant_prepare_id' });
    }

    const expected = buildCompleteSign({
      click_trans_id:      p.click_trans_id,
      service_id:          p.service_id,
      secret_key:          secret,
      merchant_trans_id:   p.merchant_trans_id,
      merchant_prepare_id: p.merchant_prepare_id,
      amount:              amtStr,
      action:              p.action,
      sign_time:           p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) {
      return res.json({ error: -1, error_note: 'Invalid sign (complete)' });
    }

    if (Number(p.error) === 0) {
      order.state = 'performed';
      order.perform_time = Date.now();
      return res.json({
        click_trans_id:      p.click_trans_id,
        merchant_trans_id:   orderId,
        merchant_confirm_id: orderId,
        error: 0,
        error_note: 'Success'
      });
    } else {
      return res.json({
        click_trans_id:      p.click_trans_id,
        merchant_trans_id:   orderId,
        merchant_confirm_id: orderId,
        error: -9,
        error_note: 'Payment canceled'
      });
    }
  }

  return res.json({ error: -3, error_note: 'Unknown action' });
});

// ===================== PAYME: CHECKOUT URL (redirect) =====================
app.get('/api/checkout-url', (req, res) => {
  const order_id = String(req.query.order_id || '');
  const amount   = Number(req.query.amount || 0); // tiyinda

  if (!orders.has(order_id)) orders.set(order_id, { amount, state: 'new' });

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

// ---- start server (eng oxirida!) ----
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on port ' + port));
