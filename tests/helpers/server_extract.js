'use strict';
// Extracts pure business logic from server.js for isolated unit testing
// No Express, no DB, no network — pure functions only.

// ── Tank stock enforcement (TC-019) ──────────────────────────────────────────
function checkStockEnforcement(tank, requestedLiters) {
  if (!tank) return { blocked: false };
  const tankLevel = parseFloat(tank.current_level) || 0;
  const capacity  = parseFloat(tank.capacity) || 0;
  // Only enforce if tank has been filled (> 5% capacity)
  if (tankLevel > capacity * 0.05 && requestedLiters > tankLevel) {
    return {
      blocked: true,
      error: `Insufficient stock: tank has ${tankLevel.toFixed(0)}L, sale requires ${requestedLiters}L`,
      available: tankLevel,
      requested: requestedLiters,
    };
  }
  return { blocked: false, available: tankLevel, requested: requestedLiters };
}

// ── Liters validation ─────────────────────────────────────────────────────────
function checkSaleLitersValidation(liters) {
  if (isNaN(liters) || liters <= 0 || liters > 50000) {
    return { invalid: true, error: 'Invalid liters: must be between 0 and 50,000' };
  }
  return { invalid: false };
}

// ── Amount validation ─────────────────────────────────────────────────────────
function checkSaleAmountValidation(amount) {
  if (isNaN(amount) || amount <= 0 || amount > 10000000) {
    return { invalid: true, error: 'Invalid amount: must be between 0 and ₹1 crore' };
  }
  return { invalid: false };
}

// ── Fuel type validation ──────────────────────────────────────────────────────
const VALID_FUEL_TYPES = [
  'Petrol','petrol','Diesel','diesel','CNG','cng',
  'premium_petrol','Premium_Petrol','premium','Premium',
  'speed','Speed','power','Power',
];

function checkFuelTypeValidation(fuelType) {
  if (!fuelType || !VALID_FUEL_TYPES.includes(fuelType)) {
    return { invalid: true, error: 'Invalid fuel type' };
  }
  return { invalid: false };
}

// ── Date validation (IST-aware) ───────────────────────────────────────────────
function checkSaleDateValidation(saleDate) {
  if (!saleDate) return { invalid: false };
  const saleDateStr = String(saleDate).slice(0, 10);
  const now = new Date();
  now.setDate(now.getDate() + 1); // tomorrow
  const istTomorrow = now.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
  if (saleDateStr > istTomorrow) {
    return { invalid: true, error: 'Sale date cannot be in the future' };
  }
  return { invalid: false };
}

// ── Credit limit enforcement ──────────────────────────────────────────────────
function checkCreditLimit(customer, saleAmount) {
  const outstanding = parseFloat(customer.outstanding) || 0;
  const limit = parseFloat(customer.limit) || 0;
  if (limit > 0 && (outstanding + saleAmount) > limit) {
    return {
      blocked: true,
      error: 'Credit limit exceeded',
      available: Math.max(0, limit - outstanding),
      outstanding,
      limit,
    };
  }
  return { blocked: false, available: Math.max(0, limit - outstanding) };
}

// ── Available stock calculation (employee shift) ─────────────────────────────
function calcAvailableStock(tankCurrent, soldThisShift) {
  return Math.max(0, (tankCurrent || 0) - (soldThisShift || 0));
}

module.exports = {
  checkStockEnforcement,
  checkSaleLitersValidation,
  checkSaleAmountValidation,
  checkFuelTypeValidation,
  checkSaleDateValidation,
  checkCreditLimit,
  calcAvailableStock,
};
