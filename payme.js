import { Router } from 'express';

export const paymeRouter = Router();

const orders = new Map();
let orderCounter = 1;

function nextOrderId() {
  return String(orderCounter++).padStart(7, '0');
}

function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  const basic = req.get('Authorization');
  let ok = false;

  if (xAuth === process.env.PAYME_KEY) ok = true;

  if (!ok && basic?.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
    const parts = decoded.split(':');
    const secret = parts[1] || parts[0];
    if (secret === process.env.PAYME_KEY) ok = true;
  }

  if (!ok) {
    return res.status(200).json({
      jsonrpc: '2.0',
      error: { code: -32504, message: { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещен' } },
      id: req.body?.id ?? null
    });
  }
  return null;
}

const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

paymeRouter.get('/api/new-order', (_req, res) => {
  const id = nextOrderId();
  orders.set(id, { amount: 0, state: 'new' });
  res.json({ order_id: id });
});

paymeRouter.get('/api/checkout-url', (req, res) => {
  const orderId = req.query.order_id;
  const amount  = Number(req.query.amount);
  if (!orderId || !amount) return res.json({ error: 'order_id va amount shart' });

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount });

  const url = `https://checkout.paycom.uz/${process.env.PAYME_MERCHANT_ID}?order_id=${orderId}&amount=${amount}&lang=uz`;
  res.json({ url });
});

paymeRouter.post('/', (req, res) => {
  if (requirePaymeAuth(req, res)) return;

  const { method, params, id } = req.body || {};

  try {
    switch (method) {
      case 'CheckPerformTransaction': {
        const order = orders.get(params.account?.order_id || '');
        if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        if (+order.amount !== +params.amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
        return res.json(ok(id, { allow: true }));
      }
      case 'CreateTransaction': {
        const order = orders.get(params.account?.order_id || '');
        if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        if (order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
        if (+order.amount !== +params.amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
        order.state = 'created';
        order.paycom_transaction_id = params.id;
        order.paycom_time = params.time;
        return res.json(ok(id, { transaction: params.id, state: 1, create_time: params.time }));
      }
      // Perform / Cancel / CheckTransaction — xuddi hozirgi kodingdagi kabi
      default:
        return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
    }
  } catch (e) {
    console.error('PAYME ERROR', e);
    return res.json(err(id ?? null, -32603, { uz: 'Server xatosi' }));
  }
});
