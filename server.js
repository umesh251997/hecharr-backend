// ============================================
// HECHARR Backend Server
// Handles: Stripe payments + Supabase database
// ============================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors({
  origin: [
    'https://hechar.com',
    'https://www.hechar.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ]
}));

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ message: '🍬 HECHARR Backend is running!', status: 'ok' });
});

// Create Stripe PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, customer, items } = req.body;
    if (!amount || amount < 50) return res.status(400).json({ error: 'Invalid amount' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currency || 'usd',
      metadata: {
        customer_email: customer?.email || '',
        customer_name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
      },
      description: 'HECHARR Multivitamin Gummies Order',
      receipt_email: customer?.email || undefined
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Save Order to Supabase
app.post('/save-order', async (req, res) => {
  try {
    const { paymentIntentId, customer, items, total, currency } = req.body;

    let userId = null;
    if (customer.email) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', customer.email)
        .single();

      if (existingUser) {
        userId = existingUser.id;
      } else {
        const { data: newUser } = await supabase
          .from('users')
          .insert({
            email: customer.email,
            first_name: customer.firstName,
            last_name: customer.lastName,
            phone: customer.phone,
            created_at: new Date().toISOString()
          })
          .select('id')
          .single();
        userId = newUser?.id;
      }
    }

    const orderId = 'HCH' + Math.random().toString(36).substr(2, 8).toUpperCase();
    const { error: orderError } = await supabase
      .from('orders')
      .insert({
        order_id: orderId,
        stripe_payment_intent_id: paymentIntentId,
        user_id: userId,
        customer_email: customer.email,
        customer_name: `${customer.firstName} ${customer.lastName}`,
        customer_phone: customer.phone,
        shipping_address: customer.address,
        shipping_address2: customer.address2,
        shipping_city: customer.city,
        shipping_zip: customer.zip,
        shipping_state: customer.state,
        shipping_country: customer.country,
        items: JSON.stringify(items),
        total_usd: total,
        currency: currency,
        status: 'paid',
        created_at: new Date().toISOString()
      });

    if (orderError) throw orderError;

    console.log(`Order saved: ${orderId} — ${customer.email} — $${total}`);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error('Save order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin orders dashboard
app.get('/orders', async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>HECHARR Orders</title>
  <style>
    body{font-family:sans-serif;padding:32px;background:#FFF8F0;margin:0}
    h1{color:#FF6B47;margin-bottom:8px}
    p{color:#8B5A2B;margin-bottom:24px;font-size:14px}
    table{width:100%;border-collapse:collapse;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)}
    th{background:#FF6B47;color:white;padding:14px 16px;text-align:left;font-size:12px;letter-spacing:0.5px;text-transform:uppercase}
    td{padding:14px 16px;font-size:13px;border-bottom:1px solid #f5e6d3}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#FFF8F0}
    .badge{background:#4CAF50;color:white;padding:4px 10px;border-radius:50px;font-size:11px;font-weight:700}
    .total{font-weight:700;color:#FF6B47}
    .order-id{font-family:monospace;font-weight:700;font-size:12px;background:#FFF3EB;padding:3px 8px;border-radius:6px}
  </style>
</head>
<body>
  <h1>🍬 HECHARR Orders</h1>
  <p>${orders.length} orders total · Refreshed at ${new Date().toLocaleString()}</p>
  <table>
    <tr>
      <th>Order ID</th><th>Date</th><th>Customer</th><th>Email</th><th>City</th><th>Country</th><th>Total</th><th>Status</th>
    </tr>
    ${orders.map(o => `<tr>
      <td><span class="order-id">${o.order_id}</span></td>
      <td>${new Date(o.created_at).toLocaleDateString()}</td>
      <td>${o.customer_name}</td>
      <td>${o.customer_email}</td>
      <td>${o.shipping_city || '-'}</td>
      <td>${o.shipping_country || '-'}</td>
      <td class="total">$${parseFloat(o.total_usd || 0).toFixed(2)}</td>
      <td><span class="badge">${o.status}</span></td>
    </tr>`).join('')}
  </table>
</body>
</html>`;

  res.send(html);
});

// Stripe Webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'payment_intent.succeeded') {
    console.log(`Payment succeeded: ${event.data.object.id}`);
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍬 HECHARR backend running on port ${PORT}`);
});
