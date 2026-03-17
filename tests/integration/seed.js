/**
 * FuelBunk Pro — Integration Test Seed Script
 *
 * Creates the minimum test fixtures needed for integration tests:
 *   - Super admin account
 *   - Test tenant (station)
 *   - Admin user (Owner role)
 *   - 2 tanks (petrol 15K, diesel 20K)
 *   - 2 pumps
 *   - 1 employee with PIN
 *   - 1 credit customer
 *   - 1 lube product
 *
 * Run ONCE before integration tests:
 *   DATABASE_URL=your_db_url node tests/integration/seed.js
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING.
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const TENANT_ID  = process.env.TEST_TENANT_ID || 'test_tenant_001';
const ADMIN_USER = process.env.ADMIN_USER || 'owner';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Owner1234!';
const SUPER_USER = process.env.SUPER_USER || 'superadmin';
const SUPER_PASS = process.env.SUPER_PASS || 'SuperSecret123!';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : false,
});

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding integration test fixtures...\n');

    // 1. Super admin
    const superHash = await bcrypt.hash(SUPER_PASS, 10);
    await client.query(`
      INSERT INTO super_admin (id, username, pass_hash)
      VALUES (1, $1, $2)
      ON CONFLICT (id) DO UPDATE SET username=$1, pass_hash=$2
    `, [SUPER_USER, superHash]);
    console.log(`✓ Super admin: ${SUPER_USER}`);

    // 2. Tenant
    await client.query(`
      INSERT INTO tenants (id, name, location, owner_name, icon, color, color_light, omc, active)
      VALUES ($1, 'Test Station', 'Koratagere', 'Test Owner', '⛽', '#d4940f', '#f0b429', 'bpcl', 1)
      ON CONFLICT (id) DO NOTHING
    `, [TENANT_ID]);
    console.log(`✓ Tenant: ${TENANT_ID}`);

    // 3. Admin user (Owner role)
    const adminHash = await bcrypt.hash(ADMIN_PASS, 10);
    await client.query(`
      INSERT INTO admin_users (tenant_id, name, username, pass_hash, role, active)
      VALUES ($1, 'Test Owner', $2, $3, 'Owner', 1)
      ON CONFLICT (tenant_id, username) DO UPDATE SET pass_hash=$3, role='Owner', active=1
    `, [TENANT_ID, ADMIN_USER, adminHash]);
    console.log(`✓ Admin user: ${ADMIN_USER} (Owner)`);

    // 4. Tanks
    await client.query(`
      INSERT INTO tanks (id, tenant_id, fuel_type, name, capacity, current_level, low_alert)
      VALUES
        ('tank_p1', $1, 'petrol',  'Petrol Tank 1',  15000, 12000, 1000),
        ('tank_d1', $1, 'diesel',  'Diesel Tank 1',  20000,  8000,  500)
      ON CONFLICT (id, tenant_id) DO UPDATE SET current_level=EXCLUDED.current_level
    `, [TENANT_ID]);
    console.log('✓ Tanks: petrol (12000L), diesel (8000L)');

    // 5. Pumps
    await client.query(`
      INSERT INTO pumps (id, tenant_id, name, fuel_type, status)
      VALUES
        ('pump_1', $1, 'Pump 1', 'petrol', 'active'),
        ('pump_2', $1, 'Pump 2', 'diesel', 'active'),
        ('inactive_pump_test', $1, 'Inactive Pump', 'petrol', 'inactive')
      ON CONFLICT (id, tenant_id) DO NOTHING
    `, [TENANT_ID]);
    console.log('✓ Pumps: pump_1 (petrol), pump_2 (diesel), inactive_pump_test');

    // 6. Employee with PIN 1234
    const pinHash = await bcrypt.hash('1234', 10);
    await client.query(`
      INSERT INTO employees (tenant_id, name, role, active, pin_hash)
      VALUES ($1, 'Test Employee', 'attendant', 1, $2)
      ON CONFLICT DO NOTHING
    `, [TENANT_ID, pinHash]);
    console.log('✓ Employee: Test Employee (PIN: 1234)');

    // 7. Credit customer
    await client.query(`
      INSERT INTO credit_customers (tenant_id, name, phone, credit_limit, balance, active)
      VALUES ($1, 'TestCreditCustomer', '9999999999', 10000, 2000, 1)
      ON CONFLICT DO NOTHING
    `, [TENANT_ID]);
    console.log('✓ Credit customer: TestCreditCustomer (limit ₹10000, balance ₹2000)');

    // 8. Lube product
    await client.query(`
      INSERT INTO settings (key, tenant_id, value, updated_at)
      VALUES ('lubes_products', $1, $2, NOW())
      ON CONFLICT (key, tenant_id) DO UPDATE SET value=$2, updated_at=NOW()
    `, [TENANT_ID, JSON.stringify([
      {
        id: 'test_lube_p1', name: 'MAK 2T Extra', brand: 'BPCL/MAK',
        category: 'Engine Oil', unit: 'Nos', hsn: '271019', gst_pct: 18,
        selling_price: 150, cost_price: 120, stock: 50, min_stock: 5, active: 1,
      }
    ])]);
    console.log('✓ Lube product: MAK 2T Extra (50 units in stock)');

    // 9. Fuel prices
    await client.query(`
      INSERT INTO settings (key, tenant_id, value, updated_at)
      VALUES ('fuel_prices', $1, $2, NOW())
      ON CONFLICT (key, tenant_id) DO UPDATE SET value=$2, updated_at=NOW()
    `, [TENANT_ID, JSON.stringify({ petrol: 94.0, diesel: 87.0, premium: 112.5 })]);
    console.log('✓ Fuel prices: petrol ₹94, diesel ₹87, premium ₹112.5');

    console.log('\n✅ Seed complete. Run: node tests/integration/integration.test.js\n');
  } catch (e) {
    console.error('❌ Seed failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
