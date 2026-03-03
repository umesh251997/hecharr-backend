// ============================================
// HECHARR Backend Server — Production Ready
// Stripe PaymentIntents + Supabase Auth + Orders
// ============================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ===== CORS =====
// Must allow your Netlify domain AND localhost for dev
const allowedOrigins = [
  'https://hechar.com',
  'https://www.hechar.com',
  // Add your actual Netlify URL below once deployed:
  'https://hecharr.netlify.app',
  'https://www.hecharr.netlify.app',
  // Local dev
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
  // Allow all netlify previews
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    // Allow any netlify.app subdomain
    if (origin.endsWith('.netlify.app') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Webhook needs raw body — MUST be before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));

// All other routes use JSON
app.use(express.json());

// Supabase client (service role — full access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({
    message: '🍬 HECHARR Backend is running!',
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// ===== CREATE PAYMENT INTENT =====
// Frontend calls this first → gets clientSecret → Stripe Elements handles card
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, customer, items } = req.body;

    if (!amount || isNaN(amount) || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount. Minimum is $0.50.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // must be integer cents
      currency: (currency || 'usd').toLowerCase(),
      metadata: {
        customer_email: customer?.email || '',
        customer_name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
        item_count: items?.length?.toString() || '0'
      },
      description: 'HECHARR Multivitamin Gummies Order',
      receipt_email: customer?.email || undefined,
      // automatic_payment_methods allows Cards, Apple Pay, Google Pay
      automatic_payment_methods: { enabled: true }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== SAVE ORDER TO SUPABASE =====
app.post('/save-order', async (req, res) => {
  try {
    const { paymentIntentId, customer, items, total, currency } = req.body;

    if (!paymentIntentId || !customer?.email) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }

    // Verify payment actually succeeded before saving
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment not completed. Status: ${paymentIntent.status}` });
    }

    // Upsert user (create if not exists)
    let userId = null;
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', customer.email)
      .single();

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: newUser, error: userError } = await supabase
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

      if (userError) console.error('User insert error:', userError.message);
      userId = newUser?.id;
    }

    // Generate order ID
    const orderId = 'HCH' + Math.random().toString(36).substr(2, 8).toUpperCase();

    const { error: orderError } = await supabase
      .from('orders')
      .insert({
        order_id: orderId,
        stripe_payment_intent_id: paymentIntentId,
        user_id: userId,
        customer_email: customer.email,
        customer_name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
        customer_phone: customer.phone || null,
        shipping_address: customer.address,
        shipping_address2: customer.address2 || null,
        shipping_city: customer.city,
        shipping_zip: customer.zip,
        shipping_state: customer.state,
        shipping_country: customer.country,
        items: JSON.stringify(items),
        total_usd: total,
        currency: currency || 'usd',
        status: 'paid',
        created_at: new Date().toISOString()
      });

    if (orderError) throw orderError;

    console.log(`✅ Order saved: ${orderId} — ${customer.email} — $${total}`);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error('❌ Save order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== SUPABASE AUTH: SIGN UP =====
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-confirm for now
      user_metadata: { first_name: firstName, last_name: lastName }
    });

    if (error) return res.status(400).json({ error: error.message });

    // Also add to users table
    await supabase.from('users').upsert({
      id: data.user.id,
      email,
      first_name: firstName,
      last_name: lastName,
      created_at: new Date().toISOString()
    }, { onConflict: 'email' });

    res.json({ success: true, user: { id: data.user.id, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SUPABASE AUTH: LOGIN =====
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

    const { data: profile } = await supabase
      .from('users')
      .select('first_name, last_name, phone')
      .eq('email', email)
      .single();

    res.json({
      success: true,
      user: {
        id: data.user.id,
        email,
        name: `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || email.split('@')[0],
        firstName: profile?.first_name,
        lastName: profile?.last_name
      },
      session: data.session
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN ORDERS DASHBOARD =====
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
    <tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Email</th><th>City</th><th>Country</th><th>Total</th><th>Status</th></tr>
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

// ===== STRIPE WEBHOOK =====
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log(`✅ Payment succeeded: ${event.data.object.id}`);
      break;
    case 'payment_intent.payment_failed':
      console.log(`❌ Payment failed: ${event.data.object.id}`);
      break;
    default:
      console.log(`Webhook event: ${event.type}`);
  }

  res.json({ received: true });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍬 HECHARR backend running on port ${PORT}`);
  console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ configured' : '❌ MISSING'}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅ configured' : '❌ MISSING'}`);
});
