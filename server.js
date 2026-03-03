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
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, Postman, mobile apps)
    if (!origin) return callback(null, true);

    const allowed =
      origin.endsWith('.netlify.app') ||       // any Netlify preview deploy
      origin.endsWith('.hechar.com') ||         // www.hechar.com + any subdomain
      origin === 'https://hechar.com' ||        // naked domain HTTPS
      origin === 'http://localhost:3000' ||
      origin === 'http://localhost:5500' ||
      origin === 'http://127.0.0.1:5500' ||
      origin === 'http://127.0.0.1:3000';

    if (allowed) return callback(null, true);

    console.warn('CORS blocked origin:', origin);
    callback(new Error(`CORS: origin ${origin} not allowed`));
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

    // Validate email before sending to Stripe — prevents "Invalid email" error
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmail = customer?.email && emailRegex.test(customer.email) ? customer.email : null;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: (currency || 'usd').toLowerCase(),
      metadata: {
        customer_email: validEmail || '',
        customer_name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
        item_count: items?.length?.toString() || '0'
      },
      description: 'HECHARR Multivitamin Gummies Order',
      receipt_email: validEmail || undefined, // only set if valid email
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
    return res.status(401).send(`<html><body style="font-family:sans-serif;padding:40px;background:#FFF8F0"><h2 style="color:#FF6B47">Access Denied</h2><p>Add ?secret=YOUR_ADMIN_SECRET to the URL.</p></body></html>`);
  }

  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(200);
  const { data: users } = await supabase.from('users').select('*').order('created_at', { ascending: false }).limit(200);
  const totalRevenue = (orders || []).reduce((sum, o) => sum + parseFloat(o.total_usd || 0), 0);
  const avgOrder = orders && orders.length ? (totalRevenue / orders.length).toFixed(2) : '0.00';

  const orderRows = (orders || []).map(o => {
    let items = '-';
    try { items = JSON.parse(o.items || '[]').map(i => i.name + ' x' + i.qty).join(', '); } catch(e) {}
    const addr = [o.shipping_address, o.shipping_city, o.shipping_state, o.shipping_zip, o.shipping_country].filter(Boolean).join(', ') || '-';
    return `<tr>
      <td><span class="oid">${o.order_id}</span></td>
      <td>${new Date(o.created_at).toLocaleDateString('en-GB')}</td>
      <td>${o.customer_name || '-'}</td>
      <td>${o.customer_email || '-'}</td>
      <td>${o.customer_phone || '-'}</td>
      <td style="font-size:11px;color:#8B5A2B;max-width:180px">${items}</td>
      <td style="font-size:11px;color:#8B5A2B">${addr}</td>
      <td class="total">$${parseFloat(o.total_usd||0).toFixed(2)}</td>
      <td><span class="badge">${o.status}</span></td>
    </tr>`;
  }).join('');

  const userRows = (users || []).map(u => `<tr>
    <td>${[u.first_name, u.last_name].filter(Boolean).join(' ') || '-'}</td>
    <td>${u.email}</td>
    <td>${u.phone || '-'}</td>
    <td>${new Date(u.created_at).toLocaleDateString('en-GB')}</td>
  </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>HECHARR Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#FFF8F0;min-height:100vh}
    .hdr{background:#FF6B47;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
    .hdr h1{font-size:22px;font-weight:800}
    .hdr span{font-size:13px;opacity:0.85}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 32px}
    .stat{background:white;border-radius:16px;padding:20px;box-shadow:0 2px 12px rgba(255,107,71,0.08)}
    .stat-label{font-size:11px;color:#8B5A2B;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
    .stat-value{font-size:30px;font-weight:800;color:#FF6B47}
    .tabs{display:flex;margin:0 32px;border-bottom:2px solid rgba(255,107,71,0.15)}
    .tab{padding:12px 24px;font-size:14px;font-weight:600;color:#8B5A2B;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px}
    .tab.active{color:#FF6B47;border-bottom-color:#FF6B47}
    .sec{padding:24px 32px;display:none}
    .sec.active{display:block}
    .toolbar{display:flex;gap:12px;margin-bottom:16px;align-items:center}
    .search{flex:1;padding:11px 16px;border:1.5px solid rgba(255,107,71,0.2);border-radius:12px;font-size:14px;outline:none;font-family:inherit}
    .search:focus{border-color:#FF6B47}
    .btn{background:#FF6B47;color:white;border:none;padding:10px 20px;border-radius:50px;font-size:13px;font-weight:700;cursor:pointer}
    .btn:hover{background:#3D1F00}
    table{width:100%;border-collapse:collapse;background:white;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.06)}
    th{background:#FF6B47;color:white;padding:12px 14px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700}
    td{padding:13px 14px;font-size:13px;border-bottom:1px solid #f5e6d3;color:#3D1F00}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#FFFAF7}
    .badge{background:#E8F5E9;color:#2E7D32;padding:4px 10px;border-radius:50px;font-size:11px;font-weight:700}
    .oid{font-family:monospace;font-weight:700;font-size:12px;background:#FFF3EB;color:#FF6B47;padding:3px 8px;border-radius:6px}
    .total{font-weight:700;color:#FF6B47}
    .empty{text-align:center;padding:60px;color:#8B5A2B}
  </style>
</head>
<body>
  <div class="hdr"><h1>🍬 HECHARR Admin</h1><span>Refreshed: ${new Date().toLocaleString()}</span></div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Total Orders</div><div class="stat-value">${(orders||[]).length}</div></div>
    <div class="stat"><div class="stat-label">Total Revenue</div><div class="stat-value">$${totalRevenue.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-label">Customers</div><div class="stat-value">${(users||[]).length}</div></div>
    <div class="stat"><div class="stat-label">Avg Order</div><div class="stat-value">$${avgOrder}</div></div>
  </div>
  <div class="tabs">
    <div class="tab active" onclick="show('orders-sec','customers-sec',this)">📦 Orders (${(orders||[]).length})</div>
    <div class="tab" onclick="show('customers-sec','orders-sec',this)">👥 Customers (${(users||[]).length})</div>
  </div>
  <div id="orders-sec" class="sec active">
    <div class="toolbar">
      <input class="search" placeholder="🔍 Search by name, email, order ID..." oninput="filter(this,'otbl')">
      <button class="btn" onclick="exportCSV('otbl','orders')">⬇ Export CSV</button>
    </div>
    <table><thead><tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Email</th><th>Phone</th><th>Items</th><th>Shipping Address</th><th>Total</th><th>Status</th></tr></thead>
    <tbody id="otbl">${orderRows || '<tr><td colspan="9" class="empty">No orders yet</td></tr>'}</tbody></table>
  </div>
  <div id="customers-sec" class="sec">
    <div class="toolbar">
      <input class="search" placeholder="🔍 Search customers..." oninput="filter(this,'ctbl')">
      <button class="btn" onclick="exportCSV('ctbl','customers')">⬇ Export CSV</button>
    </div>
    <table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Joined</th></tr></thead>
    <tbody id="ctbl">${userRows || '<tr><td colspan="4" class="empty">No customers yet</td></tr>'}</tbody></table>
  </div>
  <script>
    function show(a,b,tab){
      document.getElementById(a).classList.add('active');
      document.getElementById(b).classList.remove('active');
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
    }
    function filter(input,id){
      const q=input.value.toLowerCase();
      document.querySelectorAll('#'+id+' tr').forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';});
    }
    function exportCSV(id,name){
      const rows=[...document.getElementById(id).closest('table').querySelectorAll('tr')].map(r=>[...r.querySelectorAll('th,td')].map(c=>'"'+c.innerText.replace(/"/g,'\"').trim()+'"').join(','));
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));
      a.download='hecharr-'+name+'-'+Date.now()+'.csv';a.click();
    }
  </script>
</body></html>`);
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
