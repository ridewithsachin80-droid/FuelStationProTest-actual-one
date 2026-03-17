'use strict';
// Extracts pure functions from utils.js (browser-side) for Node.js unit testing
// These functions have no browser/DOM dependencies.

// XSS sanitizer
function sanitize(str) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') return String(str);
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

// djb2 synchronous hash
function hashSync(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8,'0');
}

// ── Session validators ──────────────────────────────────────────────────────
function validateSessionShape(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.loggedIn !== 'boolean') return false;
  if (!['admin', 'employee', null].includes(data.role)) return false;
  if (data.loggedIn && !data.timestamp) return false;
  return true;
}

function validateEmpSessionShape(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.active !== 'boolean') return false;
  if (data.active && (!data.user || typeof data.user.id !== 'number')) return false;
  if (typeof data.openReadings !== 'object') return false;
  if (!Array.isArray(data.sales)) return false;
  if (data.closeReadings !== undefined && typeof data.closeReadings !== 'object') return false;
  if (data.dipReadings !== undefined && !Array.isArray(data.dipReadings)) return false;
  if (!data.page || typeof data.page !== 'string') data.page = 'readings';
  return true;
}

// ── Input validators ────────────────────────────────────────────────────────
function validateSaleInput(fuelType, liters, amount, vehicle, prices, mode) {
  const errors = [];
  if (!fuelType || !['petrol','diesel','premium','premium_petrol'].includes(fuelType))
    errors.push('Invalid fuel type');
  if (isNaN(liters) || liters <= 0)
    errors.push('Liters must be positive');
  if (isNaN(amount) || amount <= 0)
    errors.push('Amount must be positive');
  if (amount > 10000000)
    errors.push('Amount exceeds ₹1,00,00,000 limit');
  const price = prices?.[fuelType] || 0;
  if (price > 0 && liters > 0) {
    const expected = liters * price;
    const tolerance = Math.max(1, expected * 0.01);
    if (Math.abs(amount - expected) > tolerance)
      errors.push('Amount mismatch with rate. Expected ≈₹' + expected.toFixed(2));
  }
  if (mode !== 'cash') {
    if (!vehicle || vehicle.length < 2)
      errors.push('Enter valid vehicle number');
  }
  if (vehicle && vehicle.length > 0 && !/^[A-Z0-9\s\-\.]+$/i.test(vehicle))
    errors.push('Vehicle number has invalid characters');
  return errors;
}

function validateReading(opening, closing) {
  if (isNaN(closing) || closing < 0) return 'Invalid reading';
  if (opening !== undefined && closing < opening)
    return 'Closing reading cannot be less than opening';
  if (closing - (opening || 0) > 10000)
    return 'Reading difference too large (>10000L). Verify.';
  return null;
}

function validateExpenseInput(amount, category, desc) {
  const errors = [];
  if (isNaN(amount) || amount <= 0) errors.push('Amount must be positive');
  if (amount > 500000) errors.push('Amount exceeds ₹5,00,000 limit');
  if (!category) errors.push('Select category');
  if (!desc || desc.trim().length < 3) errors.push('Enter description (min 3 chars)');
  return errors;
}

// ── Rate limit pure logic (without toast calls) ─────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;

function checkRateLimitLogic(loginAttempts, key) {
  const r = loginAttempts[key];
  if (!r) return true;
  if (r.lockedUntil && Date.now() < r.lockedUntil) return false;
  if (r.lockedUntil && Date.now() >= r.lockedUntil) {
    delete loginAttempts[key];
    return true;
  }
  return r.count < MAX_LOGIN_ATTEMPTS;
}

// ── IOCL 10K Dip Chart (subset for testing) ─────────────────────────────────
// Full table from utils.js (spot values)
const IOCL_DIP_10K = {
  1:{vol:6.95,diff:null},5:{vol:77.26,diff:2.19},10:{vol:216.79,diff:3.14},
  15:{vol:395.09,diff:3.83},20:{vol:603.32,diff:4.38},25:{vol:836.19,diff:4.83},
  30:{vol:1089.95,diff:5.23},40:{vol:1649.24,diff:5.87},50:{vol:2263.85,diff:6.36},
  60:{vol:2920.96,diff:6.73},70:{vol:3610.26,diff:7.01},80:{vol:4322.96,diff:7.21},
  87:{vol:4831.56,diff:7.30},90:{vol:5051.24,diff:7.33},97:{vol:5566.38,diff:7.37},
  100:{vol:5787.52,diff:7.37},110:{vol:6476.36,diff:7.28},120:{vol:7196.19,diff:7.12},
  130:{vol:7895.84,diff:6.88},140:{vol:8566.97,diff:6.56},150:{vol:9199.94,diff:6.13},
  160:{vol:9783.12,diff:5.57},170:{vol:10301.33,diff:4.83},180:{vol:10732.36,diff:3.83},
  190:{vol:11033.81,diff:2.19},194:{vol:11089.78,diff:0.70},
};

function ioclDipToLiters(dipCm, dipMm) {
  dipCm = Math.max(1, Math.min(194, Math.round(dipCm)));
  dipMm = Math.max(0, Math.min(9, Math.round(dipMm)));
  // Find the entry — use exact match or nearest lower
  let row = IOCL_DIP_10K[dipCm];
  if (!row) {
    // Find nearest lower key
    const keys = Object.keys(IOCL_DIP_10K).map(Number).sort((a,b)=>a-b);
    const lower = keys.filter(k => k <= dipCm).pop();
    row = IOCL_DIP_10K[lower];
  }
  if (!row) return 0;
  const mmAdd = dipMm > 0 && row.diff ? dipMm * row.diff : 0;
  return Math.round((row.vol + mmAdd) * 100) / 100;
}

// ── BPCL 15K Dip Chart (official spot values for testing) ────────────────────
const BPCL_DIP_15K_SPOTS = {
  1:{vol:11.12,diff:2.096},4:{vol:74.49,diff:3.176},10:{vol:291.22,diff:4.38},
  15:{vol:531.80,diff:5.274},16:{vol:584.93,diff:5.352},50:{vol:3853.35,diff:11.616},
  97:{vol:7505.68,diff:9.932},100:{vol:7803.71,diff:9.936},150:{vol:12556.16,diff:8.62},
  185:{vol:15075.62,diff:5.274},199:{vol:15598.07,diff:1.562},200:{vol:15604.12,diff:1.21},
};

function bpclDipLookup(dipCm, dipMm) {
  dipCm = Math.max(1, Math.min(200, Math.round(dipCm)));
  dipMm = Math.max(0, Math.min(9, Math.round(dipMm)));
  let row = BPCL_DIP_15K_SPOTS[dipCm];
  if (!row) {
    const keys = Object.keys(BPCL_DIP_15K_SPOTS).map(Number).sort((a,b)=>a-b);
    const lower = keys.filter(k => k <= dipCm).pop();
    row = BPCL_DIP_15K_SPOTS[lower];
  }
  if (!row) return 0;
  const mmAdd = dipMm > 0 && row.diff ? dipMm * row.diff : 0;
  return Math.round((row.vol + mmAdd) * 100) / 100;
}

module.exports = {
  sanitize, hashSync,
  validateSaleInput, validateReading, validateExpenseInput,
  validateSessionShape, validateEmpSessionShape,
  ioclDipToLiters, bpclDipLookup,
  checkRateLimitLogic,
};
