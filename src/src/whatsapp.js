/**
 * WhatsApp Integration Module
 * Uses CallMeBot API (FREE) for WhatsApp notifications
 * 
 * Setup: Get API key from https://www.callmebot.com/blog/free-api-whatsapp-messages/
 * 1. Save CallMeBot number: +34 644 17 76 66
 * 2. Send: "I allow callmebot to send me messages" to get API key
 * 3. Add WHATSAPP_API_KEY to environment variables
 */

const fetch = require('node-fetch');

class WhatsAppService {
  constructor() {
    this.apiKey = process.env.WHATSAPP_API_KEY || '';
    this.enabled = !!this.apiKey;
    
    if (!this.enabled) {
      console.log('[WhatsApp] API key not set - WhatsApp notifications disabled');
      console.log('[WhatsApp] To enable: Set WHATSAPP_API_KEY environment variable');
    } else {
      console.log('[WhatsApp] WhatsApp notifications enabled');
    }
  }

  /**
   * Send WhatsApp message using CallMeBot
   * @param {string} phone - Phone number with country code (e.g., +919876543210)
   * @param {string} message - Message text
   * @returns {Promise<boolean>} Success status
   */
  async send(phone, message) {
    if (!this.enabled) {
      console.log('[WhatsApp] Skipped (not configured):', message);
      return false;
    }

    try {
      // Remove + and spaces from phone
      const cleanPhone = phone.replace(/[+\s]/g, '');
      
      // CallMeBot API URL
      const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodeURIComponent(message)}&apikey=${this.apiKey}`;
      
      const response = await fetch(url, {
        method: 'GET',
        timeout: 10000
      });

      if (response.ok) {
        console.log(`[WhatsApp] Sent to ${phone}: ${message.substring(0, 50)}...`);
        return true;
      } else {
        console.error(`[WhatsApp] Failed to send: ${response.statusText}`);
        return false;
      }
    } catch (error) {
      console.error('[WhatsApp] Error sending message:', error.message);
      return false;
    }
  }

  /**
   * Send daily sales report
   */
  async sendDailyReport(phone, report) {
    const message = `📊 *Daily Sales Report*\n` +
      `Date: ${report.date}\n\n` +
      `💰 Total Sales: ₹${report.totalSales.toLocaleString('en-IN')}\n` +
      `💵 Cash: ₹${report.cashSales.toLocaleString('en-IN')}\n` +
      `📱 UPI: ₹${report.upiSales.toLocaleString('en-IN')}\n` +
      `💳 Card: ₹${report.cardSales.toLocaleString('en-IN')}\n\n` +
      `⛽ Total Liters: ${report.totalLiters.toLocaleString('en-IN')} L\n` +
      `👤 Transactions: ${report.transactionCount}\n\n` +
      `${report.vsYesterday > 0 ? '📈' : '📉'} vs Yesterday: ${report.vsYesterday > 0 ? '+' : ''}${report.vsYesterday}%`;

    return this.send(phone, message);
  }

  /**
   * Send low fuel alert
   */
  async sendLowFuelAlert(phone, tanks) {
    const tankList = tanks.map(t => 
      `  • ${t.name}: ${t.current_level}L (${t.percentage}%)`
    ).join('\n');

    const message = `🚨 *Low Fuel Alert*\n\n` +
      `The following tanks are running low:\n\n${tankList}\n\n` +
      `Please arrange fuel delivery soon.`;

    return this.send(phone, message);
  }

  /**
   * Send high cash alert
   */
  async sendHighCashAlert(phone, amount, location) {
    const message = `💰 *High Cash Alert*\n\n` +
      `Cash in drawer: ₹${amount.toLocaleString('en-IN')}\n` +
      `Location: ${location}\n\n` +
      `Please deposit cash at earliest.`;

    return this.send(phone, message);
  }

  /**
   * Send unclosed shift alert
   */
  async sendUnclosedShiftAlert(phone, shift) {
    const message = `⚠️ *Unclosed Shift Alert*\n\n` +
      `Employee: ${shift.employeeName}\n` +
      `Shift: ${shift.shift}\n` +
      `Started: ${shift.startedAt}\n\n` +
      `Shift has been open for ${shift.hoursOpen} hours. Please close it.`;

    return this.send(phone, message);
  }

  /**
   * Send shift summary
   */
  async sendShiftSummary(phone, summary) {
    const message = `✅ *Shift Closed*\n\n` +
      `Employee: ${summary.employeeName}\n` +
      `Shift: ${summary.shift}\n\n` +
      `💰 Total Sales: ₹${summary.totalSales.toLocaleString('en-IN')}\n` +
      `⛽ Liters Sold: ${summary.totalLiters.toLocaleString('en-IN')} L\n` +
      `📊 Transactions: ${summary.transactionCount}\n\n` +
      `${summary.discrepancy === 0 ? '✅' : '⚠️'} Discrepancy: ₹${summary.discrepancy}`;

    return this.send(phone, message);
  }

  /**
   * Query handler for WhatsApp commands
   */
  parseCommand(message) {
    const msg = message.toLowerCase().trim();

    if (msg.includes('sales') || msg.includes('today')) {
      return { type: 'SALES_QUERY' };
    }
    
    if (msg.includes('tank') || msg.includes('fuel')) {
      const tankMatch = msg.match(/tank\s*(\d+)/i);
      return { 
        type: 'TANK_QUERY',
        tankId: tankMatch ? parseInt(tankMatch[1]) : null
      };
    }

    if (msg.includes('price') && msg.includes('update')) {
      // Extract fuel type and price
      const priceMatch = msg.match(/(\d+\.?\d*)/);
      return {
        type: 'PRICE_UPDATE',
        price: priceMatch ? parseFloat(priceMatch[1]) : null
      };
    }

    if (msg.includes('shift')) {
      return { type: 'SHIFT_QUERY' };
    }

    return { type: 'UNKNOWN' };
  }
}

// Export singleton instance
module.exports = new WhatsAppService();
