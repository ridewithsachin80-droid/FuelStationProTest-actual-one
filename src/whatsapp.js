/**
 * FuelStation Pro - WhatsApp Integration via CallMeBot
 * FREE WhatsApp notifications without official Business API
 */

const https = require('https');

// Check if WhatsApp is configured
const WHATSAPP_ENABLED = !!process.env.WHATSAPP_API_KEY;
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY;

if (!WHATSAPP_ENABLED) {
  console.log('[WhatsApp] API key not set - WhatsApp notifications disabled');
  console.log('[WhatsApp] To enable: Set WHATSAPP_API_KEY environment variable');
  console.log('[WhatsApp] Get your key from: https://www.callmebot.com/blog/free-api-whatsapp-messages/');
}

/**
 * Send WhatsApp message via CallMeBot
 */
async function sendMessage(phoneNumber, message) {
  if (!WHATSAPP_ENABLED) {
    console.log('[WhatsApp] Skipped (not configured):', message.substring(0, 50));
    return { success: false, error: 'WhatsApp not configured' };
  }

  return new Promise((resolve) => {
    const encodedMessage = encodeURIComponent(message);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phoneNumber}&text=${encodedMessage}&apikey=${WHATSAPP_API_KEY}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[WhatsApp] Message sent to ${phoneNumber}`);
          resolve({ success: true });
        } else {
          console.error(`[WhatsApp] Send failed: ${data}`);
          resolve({ success: false, error: data });
        }
      });
    }).on('error', (err) => {
      console.error('[WhatsApp] Send error:', err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Format daily report for WhatsApp
 */
function formatDailyReport(reportData) {
  const { date, totals, employees, fuelTypes } = reportData;
  
  let message = `📊 *Daily Report - ${date}*\n\n`;
  message += `💰 *Total Sales:* ₹${totals.amount.toFixed(2)}\n`;
  message += `⛽ *Fuel Sold:* ${totals.liters.toFixed(0)}L\n`;
  message += `🧾 *Transactions:* ${totals.transactions}\n\n`;
  
  message += `💳 *Payment Breakdown:*\n`;
  message += `• Cash: ₹${totals.cash.toFixed(0)}\n`;
  message += `• Card: ₹${totals.card.toFixed(0)}\n`;
  message += `• UPI: ₹${totals.upi.toFixed(0)}\n\n`;
  
  if (fuelTypes && Object.keys(fuelTypes).length > 0) {
    message += `⛽ *By Fuel Type:*\n`;
    Object.entries(fuelTypes).forEach(([type, data]) => {
      message += `• ${type}: ${data.liters.toFixed(0)}L = ₹${data.amount.toFixed(0)}\n`;
    });
    message += '\n';
  }
  
  if (employees && employees.length > 0) {
    message += `👥 *Top Performers:*\n`;
    employees.slice(0, 3).forEach((emp, i) => {
      message += `${i + 1}. ${emp.name}: ₹${emp.amount.toFixed(0)}\n`;
    });
  }
  
  message += `\n🚀 *FuelStation Pro*`;
  
  return message;
}

/**
 * Format shift summary for WhatsApp
 */
function formatShiftSummary(shiftData) {
  const { employee, shift_type, summary, duration_hours } = shiftData;
  
  let message = `🔄 *Shift Closed*\n\n`;
  message += `👤 *Employee:* ${employee}\n`;
  message += `⏰ *Shift:* ${shift_type}\n`;
  message += `⏱️ *Duration:* ${duration_hours}h\n\n`;
  message += `💰 *Sales:* ₹${summary.total_amount.toFixed(2)}\n`;
  message += `🧾 *Transactions:* ${summary.total_transactions}\n`;
  message += `⛽ *Fuel:* ${summary.total_liters.toFixed(0)}L\n\n`;
  message += `💳 *Cash:* ₹${summary.cash_amount.toFixed(0)}\n`;
  message += `💳 *Card:* ₹${summary.card_amount.toFixed(0)}\n`;
  message += `💳 *UPI:* ₹${summary.upi_amount.toFixed(0)}\n`;
  message += `\n✅ *Shift successfully closed*`;
  
  return message;
}

/**
 * Format alert notification for WhatsApp
 */
function formatAlert(alertData) {
  const { type, severity, title, message } = alertData;
  
  const emoji = severity === 'critical' ? '🚨' : '⚠️';
  const typeEmoji = {
    low_fuel: '⛽',
    high_cash: '💰',
    unclosed_shift: '🔄'
  }[type] || '📢';
  
  return `${emoji} *ALERT*\n\n${typeEmoji} *${title}*\n\n${message}\n\n_FuelStation Pro Alert System_`;
}

/**
 * Send daily report via WhatsApp
 */
async function sendDailyReport(phoneNumber, reportData) {
  const message = formatDailyReport(reportData);
  return sendMessage(phoneNumber, message);
}

/**
 * Send shift summary via WhatsApp
 */
async function sendShiftSummary(phoneNumber, shiftData) {
  const message = formatShiftSummary(shiftData);
  return sendMessage(phoneNumber, message);
}

/**
 * Send alert via WhatsApp
 */
async function sendAlert(phoneNumber, alertData) {
  const message = formatAlert(alertData);
  return sendMessage(phoneNumber, message);
}

/**
 * Format missed dip reading alert for WhatsApp
 */
function formatMissedDipAlert(data) {
  const { stationName, tankList, date, time } = data;
  return `🚨 *DIP READING OVERDUE*\n\n🏪 *${stationName}*\n📅 Date: ${date}\n⏰ Time: ${time}\n\n📏 *Tanks not measured today:*\n${tankList}\n\n⚠️ *MDG Compliance Alert*\nOMC Marketing Discipline Guidelines require daily dip readings before 10:00 AM. Non-maintenance of records is a penalizable irregularity.\n\n👉 Open FuelBunk Pro → Tanks → Record Dip\n\n_— FuelBunk Pro Compliance System_`;
}

/**
 * Send missed dip alert via WhatsApp
 */
async function sendMissedDipAlert(phoneNumber, data) {
  const message = formatMissedDipAlert(data);
  return sendMessage(phoneNumber, message);
}

module.exports = {
  enabled: WHATSAPP_ENABLED,
  sendMessage,
  sendDailyReport,
  sendShiftSummary,
  sendAlert,
  sendMissedDipAlert,
  formatDailyReport,
  formatShiftSummary,
  formatAlert,
  formatMissedDipAlert
};
