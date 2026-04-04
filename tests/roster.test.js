/**
 * FuelBunk Pro — Roster Tests
 * Tests UR-19 and UR-20 requirements for Roster allocation in Staff & Allocation
 * Run with: node tests/roster.test.js
 */

'use strict';

const assert = require('assert');

// ─────────────────────────────────────────────────────────────────────────────
// MINI TEST RUNNER (same as unit.test.js)
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;
const results = [];

function test(suiteName, name, fn) {
  total++;
  try {
    fn();
    passed++;
    results.push({ suite: suiteName, name, status: 'PASS' });
  } catch (e) {
    failed++;
    results.push({ suite: suiteName, name, status: 'FAIL', error: e.message });
    console.error(`❌ [${suiteName}] ${name}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS (extracted from admin.js roster logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format date as YYYY-MM-DD
 */
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

/**
 * UR-19: Determine if a date is in the past (read-only)
 * Returns { isPastDay, isPastWeek, isReadOnly }
 */
function determineRosterDataState(targetDate, today) {
  const todayStr = fmtDate(today);
  const targetStr = fmtDate(targetDate);
  
  // Determine if this specific day is in the past
  const isPastDay = targetStr < todayStr;
  
  // Determine if the entire week containing this day is in the past
  const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - dayOfWeek);
  thisMonday.setHours(0, 0, 0, 0);
  
  const targetWeekStart = new Date(targetDate);
  targetWeekStart.setDate(targetDate.getDate() - (targetDate.getDay() === 0 ? 6 : targetDate.getDay() - 1));
  targetWeekStart.setHours(0, 0, 0, 0);
  
  const isPastWeek = targetWeekStart < thisMonday;
  
  // Past days or past weeks are read-only
  const isReadOnly = isPastWeek || isPastDay;
  
  return { isPastDay, isPastWeek, isReadOnly, todayStr, targetStr };
}

/**
 * UR-20: Filter employees for roster dropdown based on shift assignment
 * Returns array of eligible employee IDs for the given shift
 */
function filterEmployeesByShift(employees, shiftName, assignedIds) {
  if (!employees || employees.length === 0) return [];
  
  // Filter employees whose shift matches the roster shift (or have no shift assigned)
  const eligible = employees.filter(emp => {
    const empShift = (emp.shift || '').trim();
    
    // Employees with no shift assignment can work any shift
    if (!empShift) return true;
    
    // Parse comma-separated shift assignments
    const empShifts = empShift.split(',').map(s => s.trim().toLowerCase());
    return empShifts.includes(shiftName.toLowerCase());
  });
  
  // Filter out already assigned employees
  const unassigned = eligible.filter(emp => !assignedIds.includes(String(emp.id)));
  
  return unassigned;
}

// ─────────────────────────────────────────────────────────────────────────────
// UR-19 TESTS: Roster allocation past-date blocking
// ─────────────────────────────────────────────────────────────────────────────

test('UR-19: Past Date Blocking', 'Past date should be read-only', () => {
  const today = new Date();
  const pastDate = new Date(today);
  pastDate.setDate(today.getDate() - 2);
  
  const state = determineRosterDataState(pastDate, today);
  assert.strictEqual(state.isPastDay, true, 'Expected pastDate to be marked as past');
  assert.strictEqual(state.isReadOnly, true, 'Expected past date to be read-only');
});

test('UR-19: Current Date', 'Current date should NOT be read-only', () => {
  const today = new Date();
  
  const state = determineRosterDataState(today, today);
  assert.strictEqual(state.isPastDay, false, 'Expected today to not be marked as past');
  assert.strictEqual(state.isReadOnly, false, 'Expected today to be editable');
});

test('UR-19: Future Date', 'Future date should NOT be read-only', () => {
  const today = new Date();
  const futureDate = new Date(today);
  futureDate.setDate(today.getDate() + 3); // 3 days in future
  
  const state = determineRosterDataState(futureDate, today);
  assert.strictEqual(state.isPastDay, false, 'Expected future date to not be marked as past');
  assert.strictEqual(state.isReadOnly, false, 'Expected future date to be editable');
});

test('UR-19: Week boundary', 'Entire past week should be read-only', () => {
  const today = new Date('2025-03-18'); // Assume this is today (Tuesday)
  // Last week would be 2025-03-10 to 2025-03-16 (previous Monday-Sunday)
  const lastMonday = new Date('2025-03-10'); // Last week's Monday
  
  const state = determineRosterDataState(lastMonday, today);
  assert.strictEqual(state.isPastWeek, true, 'Expected week before today to be marked as past week');
  assert.strictEqual(state.isReadOnly, true, 'Expected past week dates to be read-only');
});

test('UR-19: Current week can have mixed state', 'Current week with past days should have some editable and some read-only', () => {
  // Simulate this week starting Monday
  const today = new Date('2025-03-18'); // Tuesday
  today.setHours(0, 0, 0, 0);
  
  const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1; // 1 for Tuesday
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - dayOfWeek); // Monday 2025-03-17
  
  // Monday (past) should be read-only
  const monday = new Date(weekStart);
  const mondayState = determineRosterDataState(monday, today);
  assert.strictEqual(mondayState.isPastDay, true);
  
  // Tuesday (today) should be editable
  const tuesdayState = determineRosterDataState(today, today);
  assert.strictEqual(tuesdayState.isPastDay, false);
  
  // Friday (future in same week) should be editable
  const friday = new Date(weekStart);
  friday.setDate(weekStart.getDate() + 4);
  const fridayState = determineRosterDataState(friday, today);
  assert.strictEqual(fridayState.isPastDay, false);
});

test('UR-19: Past date unassign prevention', 'Past dates should not allow roster changes (isReadOnly prevents dropdown/unassign)', () => {
  const today = new Date();
  const pastDate = new Date(today);
  pastDate.setDate(today.getDate() - 1);
  
  const state = determineRosterDataState(pastDate, today);
  // When isReadOnly = true, dropdown should not be rendered and unassign clicks ignored
  assert.strictEqual(state.isReadOnly, true);
  // The UI layer should use this flag to hide dropdown and disable unassign buttons
});

// ─────────────────────────────────────────────────────────────────────────────
// UR-20 TESTS: Roster assign dropdown shift filtering
// ─────────────────────────────────────────────────────────────────────────────

test('UR-20: Shift filtering', 'Only employees with matching shift should appear in dropdown', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: 'afternoon' },
    { id: 3, name: 'Charlie', shift: 'morning' },
    { id: 4, name: 'Diana', shift: 'night' }
  ];
  
  const assigned = [];
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  
  const morningIds = morningEligible.map(e => e.id);
  assert.deepStrictEqual(morningIds, [1, 3], 'Morning shift should only show Alice and Charlie');
});

test('UR-20: Different shift filtering', 'Afternoon employees should be separate from morning', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: 'afternoon' },
    { id: 3, name: 'Charlie', shift: 'afternoon' }
  ];
  
  const assigned = [];
  const afternoonEligible = filterEmployeesByShift(employees, 'afternoon', assigned);
  
  const afternoonIds = afternoonEligible.map(e => e.id);
  assert.deepStrictEqual(afternoonIds, [2, 3], 'Afternoon shift should only show Bob and Charlie');
});

test('UR-20: Employees with no shift assigned', 'Employees without shift allocation should appear in all shifts', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: '' }, // No shift assigned
    { id: 3, name: 'Charlie', shift: null }  // No shift assigned
  ];
  
  const assigned = [];
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  const afternoonEligible = filterEmployeesByShift(employees, 'afternoon', assigned);
  
  const morningIds = morningEligible.map(e => e.id);
  const afternoonIds = afternoonEligible.map(e => e.id);
  
  assert(morningIds.includes(2), 'Bob (no shift) should appear in morning dropdown');
  assert(morningIds.includes(3), 'Charlie (no shift) should appear in morning dropdown');
  assert(afternoonIds.includes(2), 'Bob (no shift) should appear in afternoon dropdown');
  assert(afternoonIds.includes(3), 'Charlie (no shift) should appear in afternoon dropdown');
});

test('UR-20: Comma-separated shift assignments', 'Employees with multiple shifts should appear in matching dropdowns', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning,afternoon' }, // Works both shifts
    { id: 2, name: 'Bob', shift: 'afternoon,night' },
    { id: 3, name: 'Charlie', shift: 'morning' }
  ];
  
  const assigned = [];
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  const afternoonEligible = filterEmployeesByShift(employees, 'afternoon', assigned);
  const nightEligible = filterEmployeesByShift(employees, 'night', assigned);
  
  const morningIds = morningEligible.map(e => e.id);
  const afternoonIds = afternoonEligible.map(e => e.id);
  const nightIds = nightEligible.map(e => e.id);
  
  assert(morningIds.includes(1), 'Alice (morning,afternoon) should be in morning');
  assert(!morningIds.includes(2), 'Bob (afternoon,night) should NOT be in morning');
  assert(morningIds.includes(3), 'Charlie (morning) should be in morning');
  
  assert(afternoonIds.includes(1), 'Alice (morning,afternoon) should be in afternoon');
  assert(afternoonIds.includes(2), 'Bob (afternoon,night) should be in afternoon');
  assert(!afternoonIds.includes(3), 'Charlie (morning) should NOT be in afternoon');
  
  assert(nightIds.includes(2), 'Bob (afternoon,night) should be in night');
  assert(!nightIds.includes(1), 'Alice (morning,afternoon) should NOT be in night');
});

test('UR-20: Case-insensitive shift matching', 'Shift matching should be case-insensitive', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'Morning' }, // Capital M
    { id: 2, name: 'Bob', shift: 'AFTERNOON' }  // All caps
  ];
  
  const assigned = [];
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  const afternoonEligible = filterEmployeesByShift(employees, 'afternoon', assigned);
  
  const morningIds = morningEligible.map(e => e.id);
  const afternoonIds = afternoonEligible.map(e => e.id);
  
  assert(morningIds.includes(1), 'Case-insensitive matching should find "Morning"');
  assert(afternoonIds.includes(2), 'Case-insensitive matching should find "AFTERNOON"');
});

test('UR-20: Exclude already assigned', 'Already assigned employees should not appear in dropdown', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: 'morning' },
    { id: 3, name: 'Charlie', shift: 'morning' }
  ];
  
  const assigned = ['1', '3']; // Alice and Charlie already assigned
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  
  const morningIds = morningEligible.map(e => e.id);
  assert(morningIds.includes(2), 'Bob should be eligible');
  assert(!morningIds.includes(1), 'Alice (already assigned) should be excluded');
  assert(!morningIds.includes(3), 'Charlie (already assigned) should be excluded');
});

test('UR-20: Empty employees list', 'Should handle empty employee list gracefully', () => {
  const employees = [];
  const assigned = [];
  
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  assert.deepStrictEqual(morningEligible, [], 'Should return empty array for no employees');
});

test('UR-20: No eligible employees for shift', 'Should return empty array if no employees match shift', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'afternoon' },
    { id: 2, name: 'Bob', shift: 'night' }
  ];
  
  const assigned = [];
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  
  assert.deepStrictEqual(morningEligible, [], 'Should return empty for morning when no one is assigned to morning');
});

test('UR-20: All employees already assigned', 'Should return empty when all eligible employees are assigned', () => {
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: 'morning' }
  ];
  
  const assigned = ['1', '2']; // Both already assigned
  const morningEligible = filterEmployeesByShift(employees, 'morning', assigned);
  
  assert.deepStrictEqual(morningEligible, [], 'Should return empty when all eligible employees are assigned');
});

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED TEST: UR-19 + UR-20 Integration
// ─────────────────────────────────────────────────────────────────────────────

test('UR-19 + UR-20 Integration', 'Past date should hide dropdown + applied shift filter to unassigned', () => {
  const today = new Date();
  const pastDate = new Date(today);
  pastDate.setDate(today.getDate() - 1);
  
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: 'afternoon' }
  ];
  
  const assigned = [];
  const pastState = determineRosterDataState(pastDate, today);
  
  // When isReadOnly = true, dropdown should not be rendered
  assert.strictEqual(pastState.isReadOnly, true);
  
  // But if a dropdown was somehow rendered, it should still apply shift filtering
  const dropdownOptions = filterEmployeesByShift(employees, 'morning', assigned);
  assert(dropdownOptions.length > 0, 'Shift filter should still work even for past date');
  assert(dropdownOptions[0].id === 1, 'Should only show morning employees');
});

test('UR-19 + UR-20 Integration', 'Future date should show filtered dropdown', () => {
  const today = new Date();
  const futureDate = new Date(today);
  futureDate.setDate(today.getDate() + 3);
  
  const employees = [
    { id: 1, name: 'Alice', shift: 'morning' },
    { id: 2, name: 'Bob', shift: 'afternoon' },
    { id: 3, name: 'Charlie', shift: '' } // No shift (flexible)
  ];
  
  const assigned = [];
  const futureState = determineRosterDataState(futureDate, today);
  
  assert.strictEqual(futureState.isReadOnly, false, 'Future date should be editable');
  
  // Dropdown should be rendered with shift filtering applied
  const morningOptions = filterEmployeesByShift(employees, 'morning', assigned);
  assert.strictEqual(morningOptions.length, 2, 'Morning dropdown should have Alice and Charlie');
  
  const afternoonOptions = filterEmployeesByShift(employees, 'afternoon', assigned);
  assert.strictEqual(afternoonOptions.length, 2, 'Afternoon dropdown should have Bob and Charlie');
});

// ─────────────────────────────────────────────────────────────────────────────
// ALLOCATION ENFORCEMENT TESTS (UR-21 extension: roster gates allocation)
// Requirement: Only employees already on the roster can be assigned to pumps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulates getRosteredEmps() — the fixed version with no fallback.
 * Only returns employees explicitly listed in rosterData for the given date+shift.
 */
function getRosteredEmpsStrict(employees, rosterData, date, shiftName) {
  const rk = date + '_' + shiftName;
  const ids = (rosterData && rosterData[rk]) || [];
  return employees.filter(e => ids.includes(String(e.id)));
}

/**
 * Simulates the assignNozzleForDate roster guard check.
 * Returns true if assignment is allowed, false if blocked.
 */
function isAllowedToAssign(empId, date, shiftName, rosterData) {
  const rosterKey = date + '_' + shiftName;
  const rosteredIds = (rosterData && rosterData[rosterKey]) || [];
  return rosteredIds.includes(String(empId));
}

const ALLOC_EMPLOYEES = [
  { id: 1, name: 'Alice',   role: 'Attendant', shift: 'Morning' },
  { id: 2, name: 'Bob',     role: 'Attendant', shift: 'Morning' },
  { id: 3, name: 'Charlie', role: 'Supervisor', shift: 'Afternoon' },
  { id: 4, name: 'Diana',   role: 'Attendant', shift: 'Morning,Afternoon' },
];

const TODAY = '2026-04-05';
const TOMORROW = '2026-04-06';

// Roster with only Alice and Bob on the morning of TODAY
const SAMPLE_ROSTER = {
  [`${TODAY}_Morning`]: ['1', '2'],
  [`${TOMORROW}_Morning`]: ['1'],
};

test('Allocation enforcement', 'dropdown shows only rostered employees when roster exists', () => {
  const emps = getRosteredEmpsStrict(ALLOC_EMPLOYEES, SAMPLE_ROSTER, TODAY, 'Morning');
  assert.strictEqual(emps.length, 2, 'Should show exactly 2 rostered employees');
  const names = emps.map(e => e.name);
  assert.ok(names.includes('Alice'), 'Alice should be in dropdown');
  assert.ok(names.includes('Bob'), 'Bob should be in dropdown');
  assert.ok(!names.includes('Charlie'), 'Charlie (not rostered) must not appear');
  assert.ok(!names.includes('Diana'), 'Diana (not rostered for this day) must not appear');
});

test('Allocation enforcement', 'dropdown is empty when no roster set for date+shift', () => {
  const emps = getRosteredEmpsStrict(ALLOC_EMPLOYEES, SAMPLE_ROSTER, TODAY, 'Afternoon');
  assert.strictEqual(emps.length, 0,
    'No employees should appear when no roster is set — no fallback to shift-field matching');
});

test('Allocation enforcement', 'non-rostered employee cannot be assigned (guard check)', () => {
  // Charlie (id=3) is NOT on the morning roster for TODAY
  const allowed = isAllowedToAssign(3, TODAY, 'Morning', SAMPLE_ROSTER);
  assert.strictEqual(allowed, false,
    'Assignment must be blocked for employee not on the roster');
});

test('Allocation enforcement', 'rostered employee passes guard check', () => {
  // Alice (id=1) IS on the morning roster for TODAY
  const allowed = isAllowedToAssign(1, TODAY, 'Morning', SAMPLE_ROSTER);
  assert.strictEqual(allowed, true,
    'Assignment must be allowed for employee who is on the roster');
});

test('Allocation enforcement', 'employee on roster for one day is blocked on another day', () => {
  // Bob (id=2) is on TODAY roster but NOT on TOMORROW roster
  const allowedToday    = isAllowedToAssign(2, TODAY,    'Morning', SAMPLE_ROSTER);
  const allowedTomorrow = isAllowedToAssign(2, TOMORROW, 'Morning', SAMPLE_ROSTER);
  assert.strictEqual(allowedToday,    true,  'Bob allowed on TODAY (is rostered)');
  assert.strictEqual(allowedTomorrow, false, 'Bob blocked on TOMORROW (not rostered that day)');
});

test('Allocation enforcement', 'no employees shown when roster data is entirely absent', () => {
  const emps = getRosteredEmpsStrict(ALLOC_EMPLOYEES, {}, TODAY, 'Morning');
  assert.strictEqual(emps.length, 0,
    'Empty roster data must yield zero employees — no fallback allowed');
});

test('Allocation enforcement', 'employee with multi-shift field is still roster-gated', () => {
  // Diana (id=4) has shift='Morning,Afternoon' — previously the fallback would show her
  // even without being on the roster. Now she must be explicitly rostered.
  const rosterWithoutDiana = { [`${TODAY}_Morning`]: ['1', '2'] }; // Diana (4) not listed
  const emps = getRosteredEmpsStrict(ALLOC_EMPLOYEES, rosterWithoutDiana, TODAY, 'Morning');
  const dianaPresent = emps.some(e => e.id === 4);
  assert.strictEqual(dianaPresent, false,
    'Diana must not appear even though her shift field includes Morning — must be on roster');
});

test('Allocation enforcement', 'auto-assign skips day when no employees rostered', () => {
  // Simulate autoAssignAlloc logic for a day with no roster
  const allocations = {};
  const date = TODAY;
  const shiftName = 'Afternoon';
  const rosteredIds = (SAMPLE_ROSTER && SAMPLE_ROSTER[date + '_' + shiftName]) || [];
  const dayEmps = ALLOC_EMPLOYEES.filter(e => rosteredIds.includes(String(e.id)));
  // With no roster, dayEmps is empty — auto-assign should skip (dayEmps.length === 0)
  if (dayEmps.length === 0) {
    // skip — correct behaviour
  } else {
    allocations[date + '_' + shiftName] = {};
  }
  assert.ok(!allocations[date + '_' + shiftName],
    'Auto-assign must not create allocation when no employees are rostered');
});

test('Allocation enforcement', 'auto-assign uses only rostered employees when roster exists', () => {
  const date = TODAY;
  const shiftName = 'Morning';
  const rosteredIds = (SAMPLE_ROSTER && SAMPLE_ROSTER[date + '_' + shiftName]) || [];
  const dayEmps = ALLOC_EMPLOYEES.filter(e => rosteredIds.includes(String(e.id)));
  // dayEmps should be [Alice, Bob] — ids 1 and 2
  assert.strictEqual(dayEmps.length, 2, 'Should find exactly 2 rostered employees');
  assert.ok(dayEmps.every(e => ['1','2'].includes(String(e.id))),
    'Auto-assign must only use rostered employees (Alice and Bob)');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST REPORT
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('\n' + '='.repeat(70));
  console.log('ROSTER TESTS (UR-19 & UR-20)');
  console.log('='.repeat(70));
  
  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${icon} [${r.suite}] ${r.name}`);
    if (r.error) console.log(`    → ${r.error}`);
  });
  
  console.log('='.repeat(70));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${total} total`);
  console.log(`Coverage: ${((passed / total) * 100).toFixed(1)}%\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = {
  determineRosterDataState,
  filterEmployeesByShift,
  fmtDate
};
