-- ============================================
-- HECHARR Database Setup
-- Run this in: supabase.com → SQL Editor → New Query
-- Press RUN — creates all your tables instantly
-- ============================================

-- USERS TABLE
-- Stores every customer who has ever bought from you
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ORDERS TABLE  
-- Every single order, fully detailed
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,              -- e.g. HCH3X9KAB2
  stripe_payment_intent_id TEXT,             -- Stripe's ID for the payment
  user_id UUID REFERENCES users(id),         -- links to users table
  
  -- Customer info
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  
  -- Shipping address
  shipping_address TEXT,
  shipping_address2 TEXT,
  shipping_city TEXT,
  shipping_zip TEXT,
  shipping_state TEXT,
  shipping_country TEXT,
  
  -- Order details
  items JSONB,                               -- the products they ordered
  total_usd DECIMAL(10,2),                   -- total in USD
  currency TEXT DEFAULT 'usd',              -- currency they paid in
  status TEXT DEFAULT 'paid',               -- paid, shipped, delivered, refunded
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- INDEX for fast email lookups
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(customer_email);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- ============================================
-- DONE! Your database is ready.
-- You should now see "users" and "orders" 
-- in the Table Editor on the left.
-- ============================================
