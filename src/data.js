/**
 * Data Access Layer for FuelStation Pro
 * All database queries go through this module
 */

class DataService {
  constructor(pool) {
    this.pool = pool;
  }
  
  // ============================================================================
  // TENANTS
  // ============================================================================
  
  async getTenant(tenantId) {
    const result = await this.pool.query(
      'SELECT * FROM tenants WHERE id = $1',
      [tenantId]
    );
    return result.rows[0];
  }
  
  async createTenant(data) {
    const { name, owner_phone, manager_phone, address, city, state } = data;
    const result = await this.pool.query(
      `INSERT INTO tenants (name, owner_phone, manager_phone, address, city, state)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, owner_phone, manager_phone, address, city, state]
    );
    return result.rows[0];
  }
  
  // ============================================================================
  // EMPLOYEES
  // ============================================================================
  
  async getEmployees(tenantId) {
    const result = await this.pool.query(
      'SELECT * FROM employees WHERE tenant_id = $1 ORDER BY name',
      [tenantId]
    );
    return result.rows;
  }
  
  async getEmployee(tenantId, employeeId) {
    const result = await this.pool.query(
      'SELECT * FROM employees WHERE tenant_id = $1 AND id = $2',
      [tenantId, employeeId]
    );
    return result.rows[0];
  }
  
  async createEmployee(tenantId, data) {
    const { name, role, shift, phone, pin_hash } = data;
    const result = await this.pool.query(
      `INSERT INTO employees (tenant_id, name, role, shift, phone, pin_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, name, role, shift, phone, pin_hash]
    );
    return result.rows[0];
  }
  
  // ============================================================================
  // SALES
  // ============================================================================
  
  async createSale(tenantId, saleData) {
    const {
      date, shift, employee_id, fuel_type, liters, rate, amount,
      mode, pump_id, vehicle_number, customer_id, customer_name, remarks
    } = saleData;
    
    const result = await this.pool.query(
      `INSERT INTO sales (
        tenant_id, date, shift, employee_id, fuel_type, liters, rate, amount,
        mode, pump_id, vehicle_number, customer_id, customer_name, remarks
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [tenant_id, date, shift, employee_id, fuel_type, liters, rate, amount,
       mode, pump_id, vehicle_number, customer_id, customer_name, remarks]
    );
    
    return result.rows[0];
  }
  
  async getSales(tenantId, filters = {}) {
    let query = 'SELECT * FROM sales WHERE tenant_id = $1';
    const params = [tenantId];
    let paramCount = 1;
    
    if (filters.date) {
      paramCount++;
      query += ` AND date = $${paramCount}`;
      params.push(filters.date);
    }
    
    if (filters.shift) {
      paramCount++;
      query += ` AND shift = $${paramCount}`;
      params.push(filters.shift);
    }
    
    if (filters.employee_id) {
      paramCount++;
      query += ` AND employee_id = $${paramCount}`;
      params.push(filters.employee_id);
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (filters.limit) {
      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(filters.limit);
    }
    
    const result = await this.pool.query(query, params);
    return result.rows;
  }
  
  // ============================================================================
  // TANKS
  // ============================================================================
  
  async getTanks(tenantId) {
    const result = await this.pool.query(
      'SELECT * FROM tanks WHERE tenant_id = $1 ORDER BY name',
      [tenantId]
    );
    return result.rows;
  }
  
  async updateTankLevel(tenantId, tankId, newLevel) {
    const result = await this.pool.query(
      `UPDATE tanks SET current_level = $3
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, tankId, newLevel]
    );
    return result.rows[0];
  }
  
  // ============================================================================
  // PUMPS
  // ============================================================================
  
  async getPumps(tenantId) {
    const result = await this.pool.query(
      'SELECT * FROM pumps WHERE tenant_id = $1 ORDER BY name',
      [tenantId]
    );
    return result.rows;
  }
  
  // ============================================================================
  // SHIFTS
  // ============================================================================
  
  async getShift(tenantId, employeeId, shift, date) {
    const result = await this.pool.query(
      `SELECT * FROM shifts
       WHERE tenant_id = $1 AND employee_id = $2 AND shift = $3 AND date = $4`,
      [tenantId, employeeId, shift, date]
    );
    return result.rows[0];
  }
  
  async createShift(tenantId, data) {
    const { employee_id, shift, date } = data;
    const result = await this.pool.query(
      `INSERT INTO shifts (tenant_id, employee_id, shift, date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, employee_id, shift, date) DO NOTHING
       RETURNING *`,
      [tenantId, employee_id, shift, date]
    );
    return result.rows[0];
  }
  
  async closeShift(tenantId, shiftId, data) {
    const {
      total_sales, cash_sales, upi_sales, card_sales,
      transaction_count, total_liters, discrepancy, notes
    } = data;
    
    const result = await this.pool.query(
      `UPDATE shifts SET
        closed_at = CURRENT_TIMESTAMP,
        total_sales = $3,
        cash_sales = $4,
        upi_sales = $5,
        card_sales = $6,
        transaction_count = $7,
        total_liters = $8,
        discrepancy = $9,
        notes = $10
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, shiftId, total_sales, cash_sales, upi_sales, card_sales,
       transaction_count, total_liters, discrepancy, notes]
    );
    
    return result.rows[0];
  }
  
  // ============================================================================
  // AUDIT LOG
  // ============================================================================
  
  async logAction(tenantId, entity, action, details, userId, ipAddress) {
    await this.pool.query(
      `INSERT INTO audit_log (tenant_id, entity, action, details, user_id, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, entity, action, JSON.stringify(details), userId, ipAddress]
    );
  }
  
  async getAuditLog(tenantId, limit = 100) {
    const result = await this.pool.query(
      `SELECT * FROM audit_log
       WHERE tenant_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }
}

module.exports = DataService;
