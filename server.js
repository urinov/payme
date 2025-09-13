import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCheckoutUrl } from './utils/buildCheckoutUrl.js';
import { buildPrepareSign, buildCompleteSign } from './utils/clickSign.js';
app.use(express.urlencoded({ extended: true })); // Click POST yuboradi


dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Oddiy demo "database"
const orders = new Map(); // order_id -> { amount, state, ... }

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
const ok = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

// PAYME callback endpoint
app.post('/payme', (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;

  const { method, params, id } = req.body || {};
  try {
    if (method === 'CheckPerformTransaction') {
      const { amount, account } = params;
      const orderId = String(account?.order_id || '');
      const order = orders.get(orderId);
      if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
      if (+order.amount !== +amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
      return res.json(ok(id, { allow: true }));
    }

    if (method === 'CreateTransaction') {
      const { id: txId, time, amount, account } = params;
      const orderId = String(account?.order_id || '');
      const order = orders.get(orderId);
      if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
      if (order.state && order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
      if (+order.amount !== +amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
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

// Checkout URL generator
app.get('/api/checkout-url', (req, res) => {
  const order_id = String(req.query.order_id || '');
  const amount = Number(req.query.amount || 0);
  if (!orders.has(order_id)) orders.set(order_id, { amount, state: 'new' });

  const url = buildCheckoutUrl({
    merchantId: process.env.PAYME_MERCHANT_ID,
    orderId: order_id,
    amountInTiyin: amount,
    lang: 'uz',
    callbackUrl: process.env.CALLBACK_RETURN_URL,
    currencyIso: 'UZS',
    description: 'To‘lov'
  });
  res.json({ url });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on port ' + port));

// Click callback: Prepare va Complete
app.post('/click/callback', (req, res) => {
  const p = Object.assign({}, req.body);
  const orderId = String(p.merchant_trans_id);
  const order = orders.get(orderId);
  if (!order) return res.json({ error: -5, error_note: 'Order not found' });

  const action = Number(p.action);
  const amt = String(p.amount);
  const secret = process.env.CLICK_SECRET_KEY;

  if (action === 0) {
    const expected = buildPrepareSign({
      click_trans_id: p.click_trans_id, service_id: p.service_id, secret_key: secret,
      merchant_trans_id: p.merchant_trans_id, amount: amt, action: p.action, sign_time: p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) return res.json({ error: -1, error_note: 'Invalid sign (prepare)' });
    order.state = 'created';
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: orderId,
      merchant_prepare_id: orderId,
      error: 0, error_note: 'Success'
    });
  }

  if (action === 1) {
    const expected = buildCompleteSign({
      click_trans_id: p.click_trans_id, service_id: p.service_id, secret_key: secret,
      merchant_trans_id: p.merchant_trans_id, merchant_prepare_id: p.merchant_prepare_id,
      amount: amt, action: p.action, sign_time: p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) return res.json({ error: -1, error_note: 'Invalid sign (complete)' });
    order.state = 'performed';
    order.perform_time = Date.now();
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: orderId,
      merchant_confirm_id: orderId,
      error: 0, error_note: 'Success'
    });
  }
  return res.json({ error: -3, error_note: 'Unknown action' });
});
