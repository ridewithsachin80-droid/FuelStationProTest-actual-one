/**
 * Smart Alerts System
 * Automatically monitors fuel station operations and sends alerts
 * 
 * Features:
 * - Low fuel alerts
 * - High cash alerts
 * - Unclosed shift alerts
 * - Price change notifications
 * - Unusual activity detection
 */

const whatsapp = require('./whatsapp');

class AlertsSystem {
  constructor(db) {
    this.db = db;
    this.intervals = [];
    this.alertThresholds = {
      lowFuel: 500, // Liters
      highCash: 50000, // Rupees
      unclosedShiftHours: 2, // Hours
      unusualSaleAmount: 10000 // Rupees
    };
  }

  /**
   * Initialize all alert monitoring
   */
  start() {
    console.log('[Alerts] Starting alert monitoring system...');

    // Check low fuel every 30 minutes
    const lowFuelInterval = setInterval(() => this.checkLowFuel(), 30 * 60 * 1000);
    this.intervals.push(lowFuelInterval);

    // Check high cash every 15 minutes
    const highCashInterval = setInterval(() => this.checkHighCash(), 15 * 60 * 1000);
    this.intervals.push(highCashInterval);

    // Check unclosed shifts every 1 hour
    const unclosedShiftInterval = setInterval(() => this.checkUnclosedShifts(), 60 * 60 * 1000);
    this.intervals.push(unclosedShiftInterval);

    // Run initial checks after 1 minute
    setTimeout(() => {
      this.checkLowFuel();
      this.checkHighCash();
      this.checkUnclosedShifts();
    }, 60 * 1000);

    console.log('[Alerts] Alert monitoring started');
    console.log('[Alerts] - Low fuel check: Every 30 minutes');
    console.log('[Alerts] - High cash check: Every 15 minutes');
    console.log('[Alerts] - Unclosed shifts check: Every hour');
  }

  /**
   * Stop all alert monitoring
   */
  stop() {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals = [];
    console.log('[Alerts] Alert monitoring stopped');
  }

  /**
   * Check for low fuel levels
   */
  async checkLowFuel() {
    try {
      const query = `
        SELECT 
          t.id,
          t.tenant_id,
          t.name,
          t.fuel_type,
          t.current_level,
          t.capacity,
          t.low_alert,
          ROUND((t.current_level::numeric / t.capacity::numeric) * 100, 1) as percentage,
          tenant.name as station_name,
          tenant.owner_phone
        FROM tanks t
        JOIN tenants tenant ON t.tenant_id = tenant.id
        WHERE t.current_level <= t.low_alert
          AND t.current_level > 0
        ORDER BY percentage ASC
      `;

      const result = await this.db.query(query);
      
      if (result.rows.length === 0) {
        return;
      }

      // Group tanks by tenant
      const tanksByTenant = {};
      result.rows.forEach(tank => {
        if (!tanksByTenant[tank.tenant_id]) {
          tanksByTenant[tank.tenant_id] = {
            stationName: tank.station_name,
            ownerPhone: tank.owner_phone,
            tanks: []
          };
        }
        tanksByTenant[tank.tenant_id].tanks.push(tank);
      });

      // Send alerts for each tenant
      for (const [tenantId, data] of Object.entries(tanksByTenant)) {
        console.log(`[Alerts] Low fuel detected for tenant ${tenantId}: ${data.tanks.length} tanks`);
        
        if (data.ownerPhone) {
          await whatsapp.sendLowFuelAlert(data.ownerPhone, data.tanks);
        }

        // Log alert to database
        await this.logAlert(tenantId, 'LOW_FUEL', {
          tanks: data.tanks.map(t => ({
            id: t.id,
            name: t.name,
            level: t.current_level,
            percentage: t.percentage
          }))
        });
      }
    } catch (error) {
      console.error('[Alerts] Error checking low fuel:', error);
    }
  }

  /**
   * Check for high cash in drawer
   */
  async checkHighCash() {
    try {
      const query = `
        SELECT 
          s.tenant_id,
          tenant.name as station_name,
          tenant.owner_phone,
          tenant.manager_phone,
          SUM(CASE WHEN s.mode = 'cash' THEN s.amount ELSE 0 END) as cash_sales,
          COUNT(*) as transaction_count
        FROM sales s
        JOIN tenants tenant ON s.tenant_id = tenant.id
        WHERE s.date = CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM shifts sh
            WHERE sh.tenant_id = s.tenant_id
              AND sh.shift = s.shift
              AND sh.closed_at IS NOT NULL
              AND sh.date = s.date
          )
        GROUP BY s.tenant_id, tenant.name, tenant.owner_phone, tenant.manager_phone
        HAVING SUM(CASE WHEN s.mode = 'cash' THEN s.amount ELSE 0 END) > $1
      `;

      const result = await this.db.query(query, [this.alertThresholds.highCash]);
      
      for (const row of result.rows) {
        console.log(`[Alerts] High cash detected for ${row.station_name}: ₹${row.cash_sales}`);
        
        // Send to manager first, then owner
        const phone = row.manager_phone || row.owner_phone;
        if (phone) {
          await whatsapp.sendHighCashAlert(phone, row.cash_sales, row.station_name);
        }

        // Log alert
        await this.logAlert(row.tenant_id, 'HIGH_CASH', {
          amount: row.cash_sales,
          transactions: row.transaction_count
        });
      }
    } catch (error) {
      console.error('[Alerts] Error checking high cash:', error);
    }
  }

  /**
   * Check for unclosed shifts
   */
  async checkUnclosedShifts() {
    try {
      const hoursAgo = new Date();
      hoursAgo.setHours(hoursAgo.getHours() - this.alertThresholds.unclosedShiftHours);

      const query = `
        SELECT 
          s.tenant_id,
          s.shift,
          s.employee_id,
          e.name as employee_name,
          s.created_at,
          tenant.name as station_name,
          tenant.manager_phone,
          tenant.owner_phone,
          EXTRACT(EPOCH FROM (NOW() - s.created_at))/3600 as hours_open
        FROM shifts s
        JOIN employees e ON s.employee_id = e.id AND s.tenant_id = e.tenant_id
        JOIN tenants tenant ON s.tenant_id = tenant.id
        WHERE s.closed_at IS NULL
          AND s.created_at < $1
        ORDER BY s.created_at ASC
      `;

      const result = await this.db.query(query, [hoursAgo]);
      
      for (const shift of result.rows) {
        console.log(`[Alerts] Unclosed shift: ${shift.employee_name} (${shift.hours_open.toFixed(1)} hours)`);
        
        const phone = shift.manager_phone || shift.owner_phone;
        if (phone) {
          await whatsapp.sendUnclosedShiftAlert(phone, {
            employeeName: shift.employee_name,
            shift: shift.shift,
            startedAt: shift.created_at.toLocaleString('en-IN'),
            hoursOpen: shift.hours_open.toFixed(1)
          });
        }

        // Log alert
        await this.logAlert(shift.tenant_id, 'UNCLOSED_SHIFT', {
          employeeId: shift.employee_id,
          employeeName: shift.employee_name,
          shift: shift.shift,
          hoursOpen: shift.hours_open
        });
      }
    } catch (error) {
      console.error('[Alerts] Error checking unclosed shifts:', error);
    }
  }

  /**
   * Check for unusual sales activity
   */
  async checkUnusualSale(tenantId, saleId) {
    try {
      const query = `
        SELECT 
          s.id,
          s.amount,
          s.liters,
          s.rate,
          s.employee_id,
          e.name as employee_name,
          tenant.manager_phone,
          tenant.owner_phone
        FROM sales s
        JOIN employees e ON s.employee_id = e.id AND s.tenant_id = e.tenant_id
        JOIN tenants tenant ON s.tenant_id = tenant.id
        WHERE s.id = $1 AND s.tenant_id = $2
      `;

      const result = await this.db.query(query, [saleId, tenantId]);
      
      if (result.rows.length === 0) return;

      const sale = result.rows[0];

      // Check if sale amount is unusual
      if (sale.amount > this.alertThresholds.unusualSaleAmount) {
        console.log(`[Alerts] Unusual sale detected: ₹${sale.amount} by ${sale.employee_name}`);
        
        const phone = sale.manager_phone || sale.owner_phone;
        if (phone) {
          const message = `⚠️ *Unusual Sale Alert*\n\n` +
            `Amount: ₹${sale.amount.toLocaleString('en-IN')}\n` +
            `Liters: ${sale.liters} L\n` +
            `Employee: ${sale.employee_name}\n\n` +
            `Please verify this transaction.`;
          
          await whatsapp.send(phone, message);
        }

        await this.logAlert(tenantId, 'UNUSUAL_SALE', {
          saleId,
          amount: sale.amount,
          employeeName: sale.employee_name
        });
      }
    } catch (error) {
      console.error('[Alerts] Error checking unusual sale:', error);
    }
  }

  /**
   * Send price change notification to all employees
   */
  async notifyPriceChange(tenantId, fuelType, oldPrice, newPrice) {
    try {
      const query = `
        SELECT 
          e.id,
          e.name,
          e.phone,
          tenant.name as station_name
        FROM employees e
        JOIN tenants tenant ON e.tenant_id = tenant.id
        WHERE e.tenant_id = $1 
          AND e.active = 1
          AND e.phone IS NOT NULL
      `;

      const result = await this.db.query(query, [tenantId]);
      
      const message = `💵 *Price Update*\n\n` +
        `${fuelType}: ₹${oldPrice} → ₹${newPrice}\n\n` +
        `Effective immediately.`;

      for (const employee of result.rows) {
        await whatsapp.send(employee.phone, message);
      }

      console.log(`[Alerts] Price change notified to ${result.rows.length} employees`);
    } catch (error) {
      console.error('[Alerts] Error notifying price change:', error);
    }
  }

  /**
   * Log alert to database
   */
  async logAlert(tenantId, alertType, data) {
    try {
      const query = `
        INSERT INTO audit_log (tenant_id, entity, action, entity_id, details, user_id, ip_address)
        VALUES ($1, 'alert', $2, NULL, $3, NULL, 'system')
      `;

      await this.db.query(query, [
        tenantId,
        alertType,
        JSON.stringify(data)
      ]);
    } catch (error) {
      console.error('[Alerts] Error logging alert:', error);
    }
  }

  /**
   * Get alert history for a tenant
   */
  async getAlertHistory(tenantId, limit = 50) {
    try {
      const query = `
        SELECT 
          id,
          action as alert_type,
          details,
          timestamp,
          ip_address
        FROM audit_log
        WHERE tenant_id = $1
          AND entity = 'alert'
        ORDER BY timestamp DESC
        LIMIT $2
      `;

      const result = await this.db.query(query, [tenantId, limit]);
      return result.rows;
    } catch (error) {
      console.error('[Alerts] Error getting alert history:', error);
      return [];
    }
  }
}

module.exports = AlertsSystem;
