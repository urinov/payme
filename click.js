import { Router } from 'express';

export const clickRouter = Router();

const orders = new Map();
let orderCounter = 1;

function nextOrderId() {
  return String(orderCounter++).padStart(7, '0');
}

clickRouter.get('/api/new-order', (_req, res) => {
  const id = nextOrderId();
  orders.set(id, { amount: 0, state: 'new' });
  res.json({ order_id: id });
});

clickRouter.get('/api/click-url', (req, res) => {
  const orderId = req.query.order_id;
  const amount  = Number(req.query.amount);
  if (!orderId || !amount) return res.json({ error: 'order_id va amount shart' });

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount });

  const amountSoum = (amount / 100).toFixed(2);
  const url = new URL('https://my.click.uz/services/pay');
  url.searchParams.set('service_id', process.env.CLICK_SERVICE_ID);
  url.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  url.searchParams.set('transaction_param', orderId);
  url.searchParams.set('amount', amountSoum);

  res.json({ url: url.toString() });
});

clickRouter.post('/callback', (req, res) => {
  const p = req.body;
  // bu yerda sign tekshiruv, prepare/complete logikasi
  res.json({ error: 0, error_note: 'Success' });
});
