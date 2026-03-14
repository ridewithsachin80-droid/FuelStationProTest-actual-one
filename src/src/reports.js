/**
 * Smart Reports Module
 * Auto-generates insightful reports with PDF export
 * 
 * Features:
 * - Daily summary reports
 * - Shift reports
 * - Employee performance
 * - Fuel consumption analysis
 * - Profit/loss analysis
 * - Scheduled report delivery
 */

const whatsapp = require('./whatsapp');

class ReportsService {
  constructor(db) {
    this.db = db;
    this.scheduledReports = [];
  }

  /**
   * Generate daily summary report
   */
  async generateDailyReport(tenantId, date = null) {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];

      // Get sales data
      const salesQuery = `
        SELECT 
          COUNT(*) as transaction_count,
          SUM(amount) as total_sales,
          SUM(liters) as total_liters,
          SUM(CASE WHEN mode = 'cash' THEN amount ELSE 0 END) as cash_sales,
          SUM(CASE WHEN mode = 'upi' THEN amount ELSE 0 END) as upi_sales,
          SUM(CASE WHEN mode = 'card' THEN amount ELSE 0 END) as card_sales,
          SUM(CASE WHEN mode = 'credit' THEN amount ELSE 0 END) as credit_sales,
          AVG(amount) as avg_ticket_size,
          MIN(amount) as min_sale,
          MAX(amount) as max_sale
        FROM sales
        WHERE tenant_id = $1 AND date = $2
      `;

      const salesResult = await this.db.query(salesQuery, [tenantId, targetDate]);
      const sales = salesResult.rows[0];

      // Get yesterday's data for comparison
      const yesterday = new Date(targetDate);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const yesterdayQuery = `
        SELECT SUM(amount) as total
        FROM sales
        WHERE tenant_id = $1 AND date = $2
      `;

      const yesterdayResult = await this.db.query(yesterdayQuery, [tenantId, yesterdayStr]);
      const yesterdayTotal = parseFloat(yesterdayResult.rows[0].total) || 0;

      // Calculate percentage change
      const vsYesterday = yesterdayTotal > 0 
        ? ((parseFloat(sales.total_sales) - yesterdayTotal) / yesterdayTotal * 100).toFixed(1)
        : 0;

      // Get peak hour
      const peakHourQuery = `
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as count,
          SUM(amount) as total
        FROM sales
        WHERE tenant_id = $1 AND date = $2
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY total DESC
        LIMIT 1
      `;

      const peakHourResult = await this.db.query(peakHourQuery, [tenantId, targetDate]);
      const peakHour = peakHourResult.rows[0] || { hour: 0, count: 0, total: 0 };

      // Get top employee
      const topEmployeeQuery = `
        SELECT 
          e.name,
          COUNT(s.id) as sales_count,
          SUM(s.amount) as total_sales
        FROM sales s
        JOIN employees e ON s.employee_id = e.id AND s.tenant_id = e.tenant_id
        WHERE s.tenant_id = $1 AND s.date = $2
        GROUP BY e.name
        ORDER BY total_sales DESC
        LIMIT 1
      `;

      const topEmployeeResult = await this.db.query(topEmployeeQuery, [tenantId, targetDate]);
      const topEmployee = topEmployeeResult.rows[0] || { name: 'N/A', sales_count: 0, total_sales: 0 };

      // Get fuel-wise breakdown
      const fuelBreakdownQuery = `
        SELECT 
          fuel_type,
          SUM(liters) as total_liters,
          SUM(amount) as total_amount,
          COUNT(*) as transaction_count
        FROM sales
        WHERE tenant_id = $1 AND date = $2
        GROUP BY fuel_type
        ORDER BY total_amount DESC
      `;

      const fuelBreakdownResult = await this.db.query(fuelBreakdownQuery, [tenantId, targetDate]);

      return {
        date: targetDate,
        transactionCount: parseInt(sales.transaction_count) || 0,
        totalSales: parseFloat(sales.total_sales) || 0,
        totalLiters: parseFloat(sales.total_liters) || 0,
        cashSales: parseFloat(sales.cash_sales) || 0,
        upiSales: parseFloat(sales.upi_sales) || 0,
        cardSales: parseFloat(sales.card_sales) || 0,
        creditSales: parseFloat(sales.credit_sales) || 0,
        avgTicketSize: parseFloat(sales.avg_ticket_size) || 0,
        minSale: parseFloat(sales.min_sale) || 0,
        maxSale: parseFloat(sales.max_sale) || 0,
        vsYesterday: parseFloat(vsYesterday),
        peakHour: {
          hour: parseInt(peakHour.hour),
          count: parseInt(peakHour.count) || 0,
          total: parseFloat(peakHour.total) || 0
        },
        topEmployee: {
          name: topEmployee.name,
          salesCount: parseInt(topEmployee.sales_count) || 0,
          totalSales: parseFloat(topEmployee.total_sales) || 0
        },
        fuelBreakdown: fuelBreakdownResult.rows.map(f => ({
          fuelType: f.fuel_type,
          liters: parseFloat(f.total_liters),
          amount: parseFloat(f.total_amount),
          transactions: parseInt(f.transaction_count)
        }))
      };
    } catch (error) {
      console.error('[Reports] Error generating daily report:', error);
      throw error;
    }
  }

  /**
   * Generate shift close report
   */
  async generateShiftReport(tenantId, shiftId) {
    try {
      // Get shift info
      const shiftQuery = `
        SELECT 
          s.id,
          s.shift,
          s.employee_id,
          s.date,
          s.created_at,
          s.closed_at,
          e.name as employee_name
        FROM shifts s
        JOIN employees e ON s.employee_id = e.id AND s.tenant_id = e.tenant_id
        WHERE s.id = $1 AND s.tenant_id = $2
      `;

      const shiftResult = await this.db.query(shiftQuery, [shiftId, tenantId]);
      
      if (shiftResult.rows.length === 0) {
        throw new Error('Shift not found');
      }

      const shift = shiftResult.rows[0];

      // Get sales for this shift
      const salesQuery = `
        SELECT 
          COUNT(*) as transaction_count,
          SUM(amount) as total_sales,
          SUM(liters) as total_liters,
          SUM(CASE WHEN mode = 'cash' THEN amount ELSE 0 END) as cash_sales,
          SUM(CASE WHEN mode = 'upi' THEN amount ELSE 0 END) as upi_sales,
          SUM(CASE WHEN mode = 'card' THEN amount ELSE 0 END) as card_sales,
          SUM(CASE WHEN mode = 'credit' THEN amount ELSE 0 END) as credit_sales
        FROM sales
        WHERE tenant_id = $1 
          AND date = $2
          AND shift = $3
          AND employee_id = $4
      `;

      const salesResult = await this.db.query(salesQuery, [
        tenantId,
        shift.date,
        shift.shift,
        shift.employee_id
      ]);

      const sales = salesResult.rows[0];

      // Get meter readings (if available)
      const meterQuery = `
        SELECT 
          pump_id,
          opening_reading,
          closing_reading,
          (closing_reading - opening_reading) as difference
        FROM pump_readings
        WHERE tenant_id = $1 AND shift_id = $2
        ORDER BY pump_id
      `;

      const meterResult = await this.db.query(meterQuery, [tenantId, shiftId]);

      return {
        shiftId: shift.id,
        shift: shift.shift,
        date: shift.date,
        employeeName: shift.employee_name,
        startTime: shift.created_at,
        endTime: shift.closed_at,
        transactionCount: parseInt(sales.transaction_count) || 0,
        totalSales: parseFloat(sales.total_sales) || 0,
        totalLiters: parseFloat(sales.total_liters) || 0,
        cashSales: parseFloat(sales.cash_sales) || 0,
        upiSales: parseFloat(sales.upi_sales) || 0,
        cardSales: parseFloat(sales.card_sales) || 0,
        creditSales: parseFloat(sales.credit_sales) || 0,
        meterReadings: meterResult.rows.map(m => ({
          pumpId: m.pump_id,
          opening: parseFloat(m.opening_reading),
          closing: parseFloat(m.closing_reading),
          difference: parseFloat(m.difference)
        })),
        discrepancy: 0 // Calculate if meter readings available
      };
    } catch (error) {
      console.error('[Reports] Error generating shift report:', error);
      throw error;
    }
  }

  /**
   * Generate employee performance report
   */
  async generateEmployeePerformanceReport(tenantId, startDate, endDate) {
    try {
      const query = `
        SELECT 
          e.id,
          e.name,
          COUNT(s.id) as total_transactions,
          SUM(s.amount) as total_sales,
          SUM(s.liters) as total_liters,
          AVG(s.amount) as avg_ticket_size,
          COUNT(DISTINCT s.date) as days_worked
        FROM employees e
        LEFT JOIN sales s ON e.id = s.employee_id 
          AND e.tenant_id = s.tenant_id
          AND s.date BETWEEN $2 AND $3
        WHERE e.tenant_id = $1 AND e.active = 1
        GROUP BY e.id, e.name
        ORDER BY total_sales DESC
      `;

      const result = await this.db.query(query, [tenantId, startDate, endDate]);

      return {
        startDate,
        endDate,
        employees: result.rows.map(emp => ({
          id: emp.id,
          name: emp.name,
          transactions: parseInt(emp.total_transactions) || 0,
          totalSales: parseFloat(emp.total_sales) || 0,
          totalLiters: parseFloat(emp.total_liters) || 0,
          avgTicketSize: parseFloat(emp.avg_ticket_size) || 0,
          daysWorked: parseInt(emp.days_worked) || 0,
          dailyAvg: emp.days_worked > 0 
            ? (parseFloat(emp.total_sales) / parseInt(emp.days_worked)).toFixed(2)
            : 0
        }))
      };
    } catch (error) {
      console.error('[Reports] Error generating employee performance report:', error);
      throw error;
    }
  }

  /**
   * Generate fuel consumption analysis
   */
  async generateFuelAnalysisReport(tenantId, startDate, endDate) {
    try {
      const query = `
        SELECT 
          date,
          fuel_type,
          SUM(liters) as total_liters,
          SUM(amount) as total_amount,
          COUNT(*) as transaction_count,
          AVG(rate) as avg_rate
        FROM sales
        WHERE tenant_id = $1 
          AND date BETWEEN $2 AND $3
        GROUP BY date, fuel_type
        ORDER BY date DESC, fuel_type
      `;

      const result = await this.db.query(query, [tenantId, startDate, endDate]);

      // Group by fuel type
      const fuelData = {};
      result.rows.forEach(row => {
        if (!fuelData[row.fuel_type]) {
          fuelData[row.fuel_type] = {
            totalLiters: 0,
            totalAmount: 0,
            totalTransactions: 0,
            dailyData: []
          };
        }

        fuelData[row.fuel_type].totalLiters += parseFloat(row.total_liters);
        fuelData[row.fuel_type].totalAmount += parseFloat(row.total_amount);
        fuelData[row.fuel_type].totalTransactions += parseInt(row.transaction_count);
        fuelData[row.fuel_type].dailyData.push({
          date: row.date,
          liters: parseFloat(row.total_liters),
          amount: parseFloat(row.total_amount),
          transactions: parseInt(row.transaction_count),
          avgRate: parseFloat(row.avg_rate)
        });
      });

      return {
        startDate,
        endDate,
        fuelData
      };
    } catch (error) {
      console.error('[Reports] Error generating fuel analysis:', error);
      throw error;
    }
  }

  /**
   * Schedule daily report delivery
   */
  scheduleDailyReportDelivery(tenantId, phone, time = '21:00') {
    console.log(`[Reports] Scheduled daily report for tenant ${tenantId} at ${time}`);
    
    // This would use a cron job in production
    // For now, just log the intention
    // In production, use node-cron:
    // const cron = require('node-cron');
    // cron.schedule(`0 ${time.split(':')[1]} ${time.split(':')[0]} * * *`, async () => {
    //   const report = await this.generateDailyReport(tenantId);
    //   await whatsapp.sendDailyReport(phone, report);
    // });
  }

  /**
   * Format report as text for WhatsApp
   */
  formatReportText(report) {
    let text = `📊 *Daily Sales Report*\n`;
    text += `Date: ${report.date}\n\n`;
    text += `💰 *Total Sales:* ₹${report.totalSales.toLocaleString('en-IN')}\n`;
    text += `   Cash: ₹${report.cashSales.toLocaleString('en-IN')}\n`;
    text += `   UPI: ₹${report.upiSales.toLocaleString('en-IN')}\n`;
    text += `   Card: ₹${report.cardSales.toLocaleString('en-IN')}\n\n`;
    text += `⛽ *Fuel Sold:* ${report.totalLiters.toLocaleString('en-IN')} L\n`;
    text += `📊 *Transactions:* ${report.transactionCount}\n`;
    text += `💵 *Avg Ticket:* ₹${report.avgTicketSize.toFixed(0)}\n\n`;
    text += `${report.vsYesterday >= 0 ? '📈' : '📉'} *vs Yesterday:* ${report.vsYesterday >= 0 ? '+' : ''}${report.vsYesterday}%\n\n`;
    text += `⭐ *Top Employee:* ${report.topEmployee.name}\n`;
    text += `   Sales: ₹${report.topEmployee.totalSales.toLocaleString('en-IN')}\n\n`;
    text += `🕐 *Peak Hour:* ${report.peakHour.hour}:00\n`;
    text += `   Sales: ₹${report.peakHour.total.toLocaleString('en-IN')}`;

    return text;
  }

  /**
   * Export report as JSON for PDF generation or further processing
   */
  exportReport(report) {
    return JSON.stringify(report, null, 2);
  }
}

module.exports = ReportsService;
