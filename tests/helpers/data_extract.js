'use strict';
// Extracts pure functions from data.js for isolated unit testing
// We re-implement the pure functions here (they have no DB dependency)

const READ_ALIAS = {
  current_level: 'current', low_alert: 'lowAlert', fuel_type: 'fuelType',
  tank_id: 'tankId', customer_id: 'customerId', sale_id: 'saleId',
  employee_id: 'employeeId', employee_name: 'employeeName', invoice_no: 'invoiceNo',
  paid_to: 'paidTo', receipt_ref: 'receiptRef', approved_by: 'approvedBy',
  start_time: 'startTime', end_time: 'endTime', balance: 'outstanding',
  credit_limit: 'limit', last_payment: 'lastPayment', computed_volume: 'calculated',
  recorded_by: 'recordedBy', pin_hash: 'pinHash', pass_hash: null,
  nozzle_readings: 'nozzleReadings', nozzle_open: 'nozzleOpen',
  nozzle_fuels: 'nozzleFuels', nozzle_labels: 'nozzleLabels',
  open_reading: 'openReading', current_reading: 'currentReading',
  color_light: 'colorLight', owner_name: 'ownerName', station_code: 'stationCode',
  join_date: 'joinDate', description: 'desc', last_dip: 'lastDip',
};

const JSON_TEXT_COLS = new Set(['nozzle_readings', 'nozzle_open', 'nozzle_fuels', 'nozzle_labels']);

function parseRow(r) {
  let obj = {};
  if (r.data_json) {
    try { obj = JSON.parse(r.data_json); } catch {}
  }
  for (const [col, val] of Object.entries(r)) {
    if (col === 'data_json' || col === 'tenant_id') continue;
    const alias = READ_ALIAS[col];
    if (alias === null) continue;
    let v = val;
    if (JSON_TEXT_COLS.has(col) && typeof val === 'string' && val) {
      try { v = JSON.parse(val); } catch {}
    }
    if (alias) {
      obj[alias] = v;
      obj[col] = v;
      if (col === 'start_time') { obj.start = v; obj.startTime = v; }
      if (col === 'end_time') { obj.end = v; obj.endTime = v; }
    } else {
      obj[col] = v;
    }
  }
  return obj;
}

function camelToSnake(s) {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase();
}

module.exports = { parseRow, camelToSnake };
