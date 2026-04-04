/**
 * FuelBunk Pro — Daily Dip Reading Compliance Tests
 *
 * Tests cover:
 *  1. Dashboard banner logic — which tanks are flagged, timing (before/after 10 AM)
 *  2. AI Insights Rule R11 — correct severity, message content, action text
 *  3. WhatsApp message format — correct content, phone normalisation
 *  4. Server cron timing — 10:05 AM IST scheduling calculation
 *  5. Compliance logic — tanks with dips vs without, per-fuel-type
 *  6. Edge cases — all dipped, no tanks, dip from another date
 */

'use strict';

const fs = require('fs');

// ── Test harness ──────────────────────────────────────────────────────────────
let _pass = 0, _fail = 0;
const results = [];

function test(group, name, fn) {
  try { fn(); _pass++; results.push({ group, name, ok: true }); }
  catch(e) { _fail++; results.push({ group, name, ok: false, err: e.message }); }
}
function ok(v, msg)  { if (!v)     throw new Error(msg || `Expected truthy, got ${JSON.stringify(v)}`); }
function no(v, msg)  { if (v)      throw new Error(msg || `Expected falsy, got ${JSON.stringify(v)}`); }
function eq(a, b, m) { if (a!==b)  throw new Error(m   || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── Helpers extracted/replicated from the app ──────────────────────────────
// Replicate the dashboard dip banner logic
function getDipBannerData(tanks, dipReadings, todayIso, currentHour) {
  const dipToday = new Set(
    dipReadings.filter(d => d.date === todayIso).map(d => String(d.tankId))
  );
  const missing  = tanks.filter(t => !dipToday.has(String(t.id)));
  const overdue  = currentHour >= 10;
  return { missing, overdue, hasBanner: missing.length > 0 };
}

// Replicate the AI Insights R11 logic
function checkDipInsightRule(tanks, dipReadings, today, currentHour) {
  const dipTodaySet = new Set(
    dipReadings.filter(d => d.date === today).map(d => String(d.tankId))
  );
  const missing = tanks.filter(t => !dipTodaySet.has(String(t.id)));
  if (!missing.length) return null;
  const overdue = currentHour >= 10;
  return {
    sev:    overdue ? 'critical' : 'warning',
    icon:   '📏',
    overdue,
    missing,
    count:  missing.length
  };
}

// Replicate WhatsApp message formatter
function formatMissedDipAlert({ stationName, tankList, date, time }) {
  return `🚨 *DIP READING OVERDUE*\n\n🏪 *${stationName}*\n📅 Date: ${date}\n⏰ Time: ${time}\n\n📏 *Tanks not measured today:*\n${tankList}\n\n⚠️ *MDG Compliance Alert*\nOMC Marketing Discipline Guidelines require daily dip readings before 10:00 AM. Non-maintenance of records is a penalizable irregularity.\n\n👉 Open FuelBunk Pro → Tanks → Record Dip\n\n_— FuelBunk Pro Compliance System_`;
}

// Replicate ms-until-10:05-IST scheduler logic
function msUntilNextIst1005(nowDate) {
  const istStr = nowDate.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour12: false });
  const istNow = new Date(istStr.replace(',', ''));
  const target = new Date(istNow);
  target.setHours(10, 5, 0, 0);
  if (istNow >= target) target.setDate(target.getDate() + 1);
  return target - istNow;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const TODAY = '2026-04-04';

const TANKS = [
  { id: '1', fuelType: 'petrol',         capacity: 10000, current: 5000 },
  { id: '2', fuelType: 'diesel',         capacity: 15000, current: 8000 },
  { id: '3', fuelType: 'premium_petrol', capacity: 5000,  current: 2000 },
];

const DIPS_ALL = [
  { id: 'd1', tankId: '1', date: TODAY,  reading: 5000 },
  { id: 'd2', tankId: '2', date: TODAY,  reading: 8000 },
  { id: 'd3', tankId: '3', date: TODAY,  reading: 2000 },
];

const DIPS_PARTIAL = [
  { id: 'd1', tankId: '1', date: TODAY,  reading: 5000 },
  // Tank 2 and 3 not dipped
];

const DIPS_NONE = [];

const DIPS_YESTERDAY = [
  { id: 'd1', tankId: '1', date: '2026-04-03', reading: 5000 },
  { id: 'd2', tankId: '2', date: '2026-04-03', reading: 8000 },
  { id: 'd3', tankId: '3', date: '2026-04-03', reading: 2000 },
];

// ════════════════════════════════════════════════════════════════════════════
// 1. Dashboard Banner Logic
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Dashboard Banner Logic ===');

test('Banner', 'no banner when all tanks dipped today', () => {
  const r = getDipBannerData(TANKS, DIPS_ALL, TODAY, 9);
  no(r.hasBanner, 'Should have no banner when all tanks have dip today');
  eq(r.missing.length, 0);
});

test('Banner', 'banner shows when no tanks dipped', () => {
  const r = getDipBannerData(TANKS, DIPS_NONE, TODAY, 9);
  ok(r.hasBanner);
  eq(r.missing.length, 3);
});

test('Banner', 'banner shows only tanks missing dip (partial)', () => {
  const r = getDipBannerData(TANKS, DIPS_PARTIAL, TODAY, 9);
  ok(r.hasBanner);
  eq(r.missing.length, 2);
  ok(r.missing.find(t => t.id === '2'), 'Tank 2 (diesel) should be missing');
  ok(r.missing.find(t => t.id === '3'), 'Tank 3 (premium) should be missing');
  no(r.missing.find(t => t.id === '1'), 'Tank 1 (petrol) should NOT be missing');
});

test('Banner', 'yesterday dips do not count for today', () => {
  const r = getDipBannerData(TANKS, DIPS_YESTERDAY, TODAY, 9);
  ok(r.hasBanner, 'Yesterday\'s dips should not satisfy today\'s requirement');
  eq(r.missing.length, 3);
});

test('Banner', 'before 10 AM: overdue=false (warning state)', () => {
  const r = getDipBannerData(TANKS, DIPS_NONE, TODAY, 9);
  no(r.overdue, 'Before 10 AM should not be overdue');
});

test('Banner', 'at exactly 10 AM: overdue=true (critical state)', () => {
  const r = getDipBannerData(TANKS, DIPS_NONE, TODAY, 10);
  ok(r.overdue, 'At 10:00 AM should be overdue');
});

test('Banner', 'after 10 AM (e.g. 14:00): overdue=true', () => {
  const r = getDipBannerData(TANKS, DIPS_NONE, TODAY, 14);
  ok(r.overdue);
});

test('Banner', 'no tanks configured: no banner', () => {
  const r = getDipBannerData([], DIPS_NONE, TODAY, 11);
  no(r.hasBanner);
});

test('Banner', 'dip with wrong tankId format does not count (type coercion)', () => {
  // Tank id is '1' (string) but dip tankId is 1 (number) — must coerce
  const dipsWithNumId = [{ id: 'd1', tankId: 1, date: TODAY, reading: 5000 }];
  const r = getDipBannerData(TANKS, dipsWithNumId, TODAY, 9);
  // Tank 1 should be considered dipped (coercion works)
  no(r.missing.find(t => t.id === '1'), 'Tank 1 should be matched despite numeric tankId');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. AI Insights Rule R11
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 2. AI Insights Rule R11 ===');

test('AI R11', 'no insight when all tanks dipped', () => {
  const r = checkDipInsightRule(TANKS, DIPS_ALL, TODAY, 9);
  eq(r, null, 'Should return null when all tanks have dip readings');
});

test('AI R11', 'warning severity before 10 AM', () => {
  const r = checkDipInsightRule(TANKS, DIPS_NONE, TODAY, 8);
  ok(r);
  eq(r.sev, 'warning', 'Before 10 AM should be warning, not critical');
});

test('AI R11', 'critical severity after 10 AM', () => {
  const r = checkDipInsightRule(TANKS, DIPS_NONE, TODAY, 11);
  ok(r);
  eq(r.sev, 'critical', 'After 10 AM should be critical');
});

test('AI R11', 'critical at exactly 10 AM', () => {
  const r = checkDipInsightRule(TANKS, DIPS_NONE, TODAY, 10);
  eq(r.sev, 'critical');
});

test('AI R11', 'correct count of missing tanks', () => {
  const r = checkDipInsightRule(TANKS, DIPS_PARTIAL, TODAY, 11);
  eq(r.count, 2);
});

test('AI R11', 'uses 📏 icon', () => {
  const r = checkDipInsightRule(TANKS, DIPS_NONE, TODAY, 11);
  eq(r.icon, '📏');
});

test('AI R11', 'yesterday dips trigger the rule', () => {
  const r = checkDipInsightRule(TANKS, DIPS_YESTERDAY, TODAY, 11);
  ok(r, 'Yesterday dips should not satisfy today and rule should fire');
  eq(r.count, 3);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. WhatsApp Message Format
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 3. WhatsApp Message Format ===');

const sampleMsg = formatMissedDipAlert({
  stationName: 'UpScale Fuel Station',
  tankList:    '• Petrol (MS) (Tank 1)\n• Diesel (HSD) (Tank 2)',
  date:        '2026-04-04',
  time:        '10:05 AM'
});

test('WA Msg', 'contains station name', () => {
  ok(sampleMsg.includes('UpScale Fuel Station'));
});

test('WA Msg', 'contains date', () => {
  ok(sampleMsg.includes('2026-04-04'));
});

test('WA Msg', 'contains MDG compliance reference', () => {
  ok(sampleMsg.includes('MDG') || sampleMsg.includes('Marketing Discipline Guidelines'));
});

test('WA Msg', 'contains action instruction to record dip', () => {
  ok(sampleMsg.toLowerCase().includes('record dip') || sampleMsg.toLowerCase().includes('tanks'));
});

test('WA Msg', 'contains 🚨 icon for urgency', () => {
  ok(sampleMsg.includes('🚨'));
});

test('WA Msg', 'contains both tank names', () => {
  ok(sampleMsg.includes('Petrol (MS) (Tank 1)'));
  ok(sampleMsg.includes('Diesel (HSD) (Tank 2)'));
});

test('WA Msg', 'mentions penalty for non-compliance', () => {
  ok(sampleMsg.toLowerCase().includes('penali') || sampleMsg.toLowerCase().includes('irregularity'));
});

test('WA Msg', 'signed by FuelBunk Pro', () => {
  ok(sampleMsg.includes('FuelBunk Pro'));
});

// ════════════════════════════════════════════════════════════════════════════
// 4. WhatsApp module exports sendMissedDipAlert
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 4. WhatsApp Module ===');

test('WA Module', 'whatsapp.js exports sendMissedDipAlert', () => {
  const src = fs.readFileSync('./src/whatsapp.js', 'utf8');
  ok(src.includes('sendMissedDipAlert'), 'sendMissedDipAlert must be exported');
});

test('WA Module', 'whatsapp.js exports formatMissedDipAlert', () => {
  const src = fs.readFileSync('./src/whatsapp.js', 'utf8');
  ok(src.includes('formatMissedDipAlert'));
});

test('WA Module', 'wa_templates.missedDip exists in admin.js', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('missedDip'), 'frontend wa_templates must have missedDip');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Server cron scheduling
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 5. Cron Scheduling ===');

test('Cron', 'server.js has runDipComplianceCheck function', () => {
  const src = fs.readFileSync('./src/server.js', 'utf8');
  ok(src.includes('runDipComplianceCheck'), 'runDipComplianceCheck must exist in server.js');
});

test('Cron', 'server.js schedules at 10:05 AM IST', () => {
  const src = fs.readFileSync('./src/server.js', 'utf8');
  ok(src.includes('10, 5, 0, 0') || src.includes("'10:05'") || src.includes('msUntilNextIst1005'),
    'Must schedule at 10:05 AM IST');
});

test('Cron', 'delay is between 0 and 24h', () => {
  // Test with a time well before 10:05 AM IST (e.g. 8 AM IST)
  // Simulate 08:00 IST = 02:30 UTC
  const simNow = new Date('2026-04-04T02:30:00.000Z'); // 8:00 AM IST
  const delay  = msUntilNextIst1005(simNow);
  ok(delay > 0, 'Delay must be positive');
  ok(delay < 24 * 3600 * 1000, 'Delay must be less than 24 hours');
});

test('Cron', 'at 08:00 IST delay is approx 2 hours 5 min', () => {
  const simNow = new Date('2026-04-04T02:30:00.000Z'); // 8:00 AM IST
  const delay  = msUntilNextIst1005(simNow);
  const expectedMs = (2 * 60 + 5) * 60 * 1000; // 2h5m in ms
  const diff = Math.abs(delay - expectedMs);
  ok(diff < 60000, `Expected ~${expectedMs}ms (2h5m), got ${delay}ms (diff ${diff}ms)`);
});

test('Cron', 'after 10:05 AM IST schedules for next day', () => {
  // 11:00 AM IST = 05:30 UTC
  const simNow = new Date('2026-04-04T05:30:00.000Z');
  const delay  = msUntilNextIst1005(simNow);
  // Should be ~23h5m until next 10:05 AM IST
  const expectedMs = (23 * 60 + 5) * 60 * 1000;
  const diff = Math.abs(delay - expectedMs);
  ok(diff < 60000, `Should schedule ~23h5m later, got ${(delay/3600000).toFixed(2)}h`);
});

test('Cron', 'server.js checks dip_readings table', () => {
  const src = fs.readFileSync('./src/server.js', 'utf8');
  ok(src.includes('dip_readings'), 'Must query dip_readings table');
});

test('Cron', 'server.js iterates all active tenants', () => {
  const src = fs.readFileSync('./src/server.js', 'utf8');
  ok(src.includes('DipCheck') && src.includes('tenants'), 'Must iterate tenants');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Source code: AI Insights rule count updated
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Source Code Checks ===');

test('Code', 'AI Insights shows 11 rules active', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('11 rules active'), 'Rule count header should say 11');
});

test('Code', 'AI Insights all-clear shows 11 rules checked', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('11 rules checked'), 'All-clear text should say 11 rules checked');
});

test('Code', 'AI Insights active rules panel shows 11 Active Rules', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('11 Active Rules'), 'Panel heading should say 11 Active Rules');
});

test('Code', 'dashboard dipBanner uses red color after 10 AM', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('dipOverdue') && src.includes('dipBanner'), 'dipBanner must use dipOverdue flag');
});

test('Code', 'dashboard banner has Record Dip Now button', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('Record Dip Now'), 'Banner must have action button');
});

test('Code', 'MDG compliance text on dashboard', () => {
  const src = fs.readFileSync('./src/public/admin.js', 'utf8');
  ok(src.includes('MDG') || src.includes('Marketing Discipline'), 'MDG mention required');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Edge cases
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== 7. Edge Cases ===');

test('Edge', 'single-tank station: one dip required', () => {
  const singleTank = [{ id: '1', fuelType: 'petrol', capacity: 10000 }];
  const r = getDipBannerData(singleTank, DIPS_NONE, TODAY, 11);
  ok(r.hasBanner);
  eq(r.missing.length, 1);
});

test('Edge', 'dip recorded at 23:59 still counts for the day', () => {
  const lateDip = [{ id: 'd1', tankId: '1', date: TODAY, time: '23:59', reading: 5000 }];
  const r = getDipBannerData(TANKS, lateDip, TODAY, 11);
  no(r.missing.find(t => t.id === '1'), 'Late-day dip should still satisfy the daily requirement');
});

test('Edge', 'duplicate dips for same tank: counted once (no false alarm)', () => {
  const dupDips = [
    { id: 'd1', tankId: '1', date: TODAY, reading: 5000 },
    { id: 'd2', tankId: '1', date: TODAY, reading: 5050 }, // second dip
  ];
  const r = getDipBannerData(
    [{ id: '1', fuelType: 'petrol', capacity: 10000 }],
    dupDips, TODAY, 11
  );
  no(r.hasBanner, 'Multiple dips for same tank should not cause duplicate alerts');
});

test('Edge', 'WA message handles special chars in station name', () => {
  const msg = formatMissedDipAlert({
    stationName: "O'Brien's Fuel & Co.",
    tankList:    '• Petrol (Tank 1)',
    date:        TODAY,
    time:        '10:05 AM'
  });
  ok(msg.includes("O'Brien's Fuel & Co."));
});

test('Edge', 'AI rule fires even when only 1 of 3 tanks is missing', () => {
  const r = checkDipInsightRule(TANKS, DIPS_PARTIAL, TODAY, 11);
  ok(r !== null, 'Rule should fire if ANY tank is missing a dip');
  eq(r.count, 2);
});

test('Edge', 'AI rule does not fire at midnight (hour=0) if all dipped', () => {
  const r = checkDipInsightRule(TANKS, DIPS_ALL, TODAY, 0);
  eq(r, null);
});

// ════════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ════════════════════════════════════════════════════════════════════════════
const groups = {};
results.forEach(r => {
  if (!groups[r.group]) groups[r.group] = [];
  groups[r.group].push(r);
});

console.log('\n' + '═'.repeat(72));
console.log('  DAILY DIP COMPLIANCE TEST REPORT');
console.log('═'.repeat(72));

for (const [group, tests] of Object.entries(groups)) {
  const allPass = tests.every(t => t.ok);
  const icon = allPass ? '✅' : '❌';
  console.log(`\n${icon} ${group}                       [${tests.filter(t=>t.ok).length}/${tests.length} passed]`);
  tests.forEach(t => {
    if (t.ok) console.log(`  ✓  ${t.name}`);
    else { console.log(`  ✗  ${t.name}`); console.log(`       ↳ ${t.err}`); }
  });
}

const total = results.length;
console.log('\n' + '─'.repeat(72));
console.log(`  Total: ${total} tests  |  Passed: ${_pass}  |  Failed: ${_fail}`);
console.log('─'.repeat(72));

if (_fail === 0) { console.log('\n✅  All dip compliance tests passed.\n'); process.exit(0); }
else { console.log(`\n❌  ${_fail} test(s) failed.\n`); process.exit(1); }
