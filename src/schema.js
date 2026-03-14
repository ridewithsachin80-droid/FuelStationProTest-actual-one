const { Pool } = require('pg');

// Production-ready connection pool configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 150,                    // Maximum pool size for 100 stations
  min: 20,                     // Minimum idle connections
  idleTimeoutMillis: 30000,    // 30 seconds
  connectionTimeoutMillis: 10000, // 10 seconds
  maxUses: 7500,               // Recycle connections
});

// Connection error handling
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err);
});

pool.on('connect', () => {
  console.log('[DB] New client connected to pool');
});

// Initialize database schema
async function initDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('[Schema] Initializing database schema...');
    
    await client.query('BEGIN');
    
    // Tenants table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        active INTEGER DEFAULT 1,
        owner_phone VARCHAR(15),
        manager_phone VARCHAR(15),
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100)
      )
    `);
    
    // Employees table
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'employee',
        shift VARCHAR(20),
        phone VARCHAR(15),
        pin_hash VARCHAR(255),
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, phone)
      )
    `);
    
    // Tanks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tanks (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        fuel_type VARCHAR(50) NOT NULL,
        capacity INTEGER NOT NULL,
        current_level INTEGER DEFAULT 0,
        low_alert INTEGER DEFAULT 500,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, name)
      )
    `);
    
    // Pumps table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pumps (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        tank_id INTEGER REFERENCES tanks(id) ON DELETE SET NULL,
        name VARCHAR(100) NOT NULL,
        fuel_type VARCHAR(50) NOT NULL,
        opening_reading INTEGER DEFAULT 0,
        current_reading INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, name)
      )
    `);
    
    // Sales table (main transaction table)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        shift VARCHAR(20) NOT NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        fuel_type VARCHAR(50) NOT NULL,
        liters DECIMAL(10,2) NOT NULL,
        rate DECIMAL(10,2) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        mode VARCHAR(20) NOT NULL,
        pump_id INTEGER REFERENCES pumps(id) ON DELETE SET NULL,
        vehicle_number VARCHAR(50),
        customer_id INTEGER,
        customer_name VARCHAR(255),
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Shifts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        shift VARCHAR(20) NOT NULL,
        date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP,
        total_sales DECIMAL(10,2) DEFAULT 0,
        cash_sales DECIMAL(10,2) DEFAULT 0,
        upi_sales DECIMAL(10,2) DEFAULT 0,
        card_sales DECIMAL(10,2) DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        total_liters DECIMAL(10,2) DEFAULT 0,
        discrepancy DECIMAL(10,2) DEFAULT 0,
        notes TEXT,
        UNIQUE(tenant_id, employee_id, shift, date)
      )
    `);
    
    // Credit customers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_customers (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(15),
        company VARCHAR(255),
        credit_limit DECIMAL(10,2) DEFAULT 0,
        current_balance DECIMAL(10,2) DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, phone)
      )
    `);
    
    // Credit transactions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES credit_customers(id) ON DELETE CASCADE,
        sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
        date DATE NOT NULL,
        type VARCHAR(20) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        balance_after DECIMAL(10,2) NOT NULL,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Expenses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        category VARCHAR(100) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description TEXT,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Dip readings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS dip_readings (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        tank_id INTEGER REFERENCES tanks(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        shift VARCHAR(20) NOT NULL,
        reading INTEGER NOT NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Audit log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        entity VARCHAR(50) NOT NULL,
        action VARCHAR(50) NOT NULL,
        details JSONB,
        user_id INTEGER,
        ip_address VARCHAR(45),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Push subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        subscription JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, employee_id)
      )
    `);
    
    await client.query('COMMIT');
    console.log('[Schema] Database schema initialized successfully');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Schema] Error initializing schema:', error);
    throw error;
  } finally {
    client.release();
  }
  
  return pool;
}

// Health check query
async function healthCheck() {
  try {
    const start = Date.now();
    const result = await pool.query('SELECT NOW()');
    const responseTime = Date.now() - start;
    
    return {
      status: 'healthy',
      responseTime,
      timestamp: result.rows[0].now,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

// Graceful shutdown
async function closePool() {
  try {
    await pool.end();
    console.log('[DB] Connection pool closed');
  } catch (error) {
    console.error('[DB] Error closing pool:', error);
  }
}

module.exports = {
  initDatabase,
  pool,
  healthCheck,
  closePool
};
