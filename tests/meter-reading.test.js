/**
 * FuelBunk Pro — Meter Reading Validation Tests
 *
 * Tests the validateMeterReading() function extracted from admin.js.
 * Covers all 8 validation rules:
 *  1. Must be a number
 *  2. Must be >= 0
 *  3. Must be <= 999999.99
 *  4. Max 2 decimal places
 *  5. Closing: must be >= previous reading
 *  6. Closing: difference <= 50000 L
 *  7. Opening: warn if dramatically lower than previous (possible pump replacement)
 *  8. Opening: block if < 1 but previous > 100 (catches the .35689 screenshot bug)
 */

'use strict';

// ── Replicate validateMeterReading from admin.js ──────────────────────────────
function validateMeterReading(rawValue, previousReading, mode) {
  const METER_MAX = 999999.99;

  if (rawValue === '' || rawValue === null || rawValue === undefined) {
    return { ok: false, error: 'Enter a meter reading', warn: false };
  }
  const strCheck = String(rawValue).trim();
  if (!/^\d*\.?\d+$/.test(strCheck)) {
    return { ok: false, error: 'Must be a number (e.g. 9450 or 9450.12)', warn: false };
  }
  const val = parseFloat(strCheck);
  if (isNaN(val)) {
    return { ok: false, error: 'Must be a number (e.g. 9450 or 9450.12)', warn: false };
  }
  if (val < 0) {
    return { ok: false, error: 'Meter reading cannot be negative', warn: false };
  }
  if (val > METER_MAX) {
    return { ok: false, error: `Reading cannot exceed ${METER_MAX.toLocaleString()} (pump maximum)`, warn: false };
  }
  const strVal   = String(rawValue).trim();
  const dotIndex = strVal.indexOf('.');
  if (dotIndex !== -1 && strVal.length - dotIndex - 1 > 2) {
    return {
      ok: false,
      error: `Pump meters show max 2 decimal places — did you mean ${val.toFixed(2)}?`,
      warn: false
    };
  }
  const prev = parseFloat(previousReading) || 0;

  if (mode === 'closing') {
    if (val < prev) {
      return {
        ok: false,
        error: `Closing reading (${val.toLocaleString()}) cannot be less than opening reading (${prev.toLocaleString()})`,
        warn: false
      };
    }
    const diff = val - prev;
    if (diff > 50000) {
      return {
        ok: false,
        error: `Difference of ${diff.toLocaleString()} L in one shift is unusually high — please verify`,
        warn: false
      };
    }
  }

  if (mode === 'opening') {
    if (val < 1 && prev >= 100) {
      return {
        ok: false,
        error: `Reading of ${val} is too low — previous reading was ${prev.toLocaleString()}. Did you type a decimal by mistake?`,
        warn: false
      };
    }
    if (prev > 0 && val < prev * 0.5 && val > 0) {
      return {
        ok: true,
        warn: true,
        error: `⚠️ Opening (${val.toLocaleString()}) is much lower than last reading (${prev.toLocaleString()}). Save only if pump was replaced.`
      };
    }
  }

  return { ok: true, warn: false };
}

// ── Test harness ──────────────────────────────────────────────────────────────
let _pass = 0, _fail = 0, _total = 0;
const results = [];

function test(group, name, fn) {
  _total++;
  try {
    fn();
    _pass++;
    results.push({ group, name, ok: true });
  } catch (e) {
    _fail++;
    results.push({ group, name, ok: false, err: e.message });
  }
}
function ok(v, msg)   { if (!v) throw new Error(msg || `Expected truthy, got ${v}`); }
function eq(a, b, m)  { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function no(v, msg)   { if (v) throw new Error(msg || `Expected falsy, got ${v}`); }

// ════════════════════════════════════════════════════════════════════════════
// Rule 1 — Must be a number
// ════════════════════════════════════════════════════════════════════════════
test('Rule 1', 'empty string is rejected', () => {
  const r = validateMeterReading('', 1000, 'opening');
  no(r.ok); ok(r.error);
});
test('Rule 1', 'null is rejected', () => {
  no(validateMeterReading(null, 1000, 'opening').ok);
});
test('Rule 1', 'undefined is rejected', () => {
  no(validateMeterReading(undefined, 1000, 'opening').ok);
});
test('Rule 1', 'letters are rejected', () => {
  no(validateMeterReading('abc', 1000, 'opening').ok);
});
test('Rule 1', 'mixed alphanumeric rejected', () => {
  no(validateMeterReading('9450x', 1000, 'opening').ok);
});
test('Rule 1', 'valid integer passes', () => {
  ok(validateMeterReading('9450', 9000, 'opening').ok);
});
test('Rule 1', 'valid decimal passes', () => {
  ok(validateMeterReading('9450.12', 9000, 'opening').ok);
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 2 — Must be >= 0
// ════════════════════════════════════════════════════════════════════════════
test('Rule 2', 'negative number rejected', () => {
  no(validateMeterReading('-1', 0, 'opening').ok);
});
test('Rule 2', 'zero is allowed (new pump)', () => {
  ok(validateMeterReading('0', 0, 'opening').ok);
});
test('Rule 2', 'positive number passes', () => {
  ok(validateMeterReading('100', 0, 'opening').ok);
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 3 — Must be <= 999,999.99
// ════════════════════════════════════════════════════════════════════════════
test('Rule 3', 'exactly 999999.99 is allowed', () => {
  ok(validateMeterReading('999999.99', 0, 'opening').ok);
});
test('Rule 3', '1000000 is rejected', () => {
  no(validateMeterReading('1000000', 0, 'opening').ok);
});
test('Rule 3', '9999999 is rejected', () => {
  no(validateMeterReading('9999999', 0, 'opening').ok);
});
test('Rule 3', 'error mentions pump maximum', () => {
  const r = validateMeterReading('1000000', 0, 'opening');
  ok(r.error.toLowerCase().includes('maximum') || r.error.includes('999'));
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 4 — Max 2 decimal places
// ════════════════════════════════════════════════════════════════════════════
test('Rule 4', '1 decimal place is allowed', () => {
  ok(validateMeterReading('9450.5', 9000, 'opening').ok);
});
test('Rule 4', '2 decimal places is allowed', () => {
  ok(validateMeterReading('9450.12', 9000, 'opening').ok);
});
test('Rule 4', '3 decimal places is rejected', () => {
  no(validateMeterReading('9450.123', 9000, 'opening').ok);
});
test('Rule 4', '5 decimal places rejected (.35689 — exact screenshot bug)', () => {
  no(validateMeterReading('.35689', 0.97, 'opening').ok);
});
test('Rule 4', 'error suggests corrected value for 3dp', () => {
  const r = validateMeterReading('9450.123', 9000, 'opening');
  ok(r.error.includes('9450.12'), `Error should suggest 9450.12, got: ${r.error}`);
});
test('Rule 4', 'integer (no decimal) is always valid', () => {
  ok(validateMeterReading('9450', 9000, 'opening').ok);
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 5 — Closing: must be >= previous reading
// ════════════════════════════════════════════════════════════════════════════
test('Rule 5', 'closing = opening is allowed (no sales)', () => {
  ok(validateMeterReading('9450', 9450, 'closing').ok);
});
test('Rule 5', 'closing > opening is allowed', () => {
  ok(validateMeterReading('9500', 9450, 'closing').ok);
});
test('Rule 5', 'closing < opening is rejected', () => {
  no(validateMeterReading('9000', 9450, 'closing').ok);
});
test('Rule 5', 'error mentions both readings when closing < opening', () => {
  const r = validateMeterReading('9000', 9450, 'closing');
  ok(r.error.includes('9,000') || r.error.includes('9000'));
  ok(r.error.includes('9,450') || r.error.includes('9450'));
});
test('Rule 5', 'closing 0 when previous is 9450 is rejected', () => {
  no(validateMeterReading('0', 9450, 'closing').ok);
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 6 — Closing: difference <= 50,000 L
// ════════════════════════════════════════════════════════════════════════════
test('Rule 6', 'difference of 50000 exactly is allowed', () => {
  ok(validateMeterReading('59450', 9450, 'closing').ok);
});
test('Rule 6', 'difference of 50001 is rejected', () => {
  no(validateMeterReading('59451', 9450, 'closing').ok);
});
test('Rule 6', 'difference of 100000 is rejected (obvious typo)', () => {
  no(validateMeterReading('109450', 9450, 'closing').ok);
});
test('Rule 6', 'error mentions difference amount', () => {
  const r = validateMeterReading('109450', 9450, 'closing');
  ok(r.error.includes('100,000') || r.error.includes('100000'));
});
test('Rule 6', 'normal shift of 2000 L is allowed', () => {
  ok(validateMeterReading('11450', 9450, 'closing').ok);
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 7 — Opening: warn if dramatically lower than previous
// ════════════════════════════════════════════════════════════════════════════
test('Rule 7', 'opening at 40% of previous triggers warn', () => {
  const r = validateMeterReading('4000', 9450, 'opening');
  ok(r.ok, 'Should be ok=true (warning, not error)');
  ok(r.warn, 'Should have warn=true');
});
test('Rule 7', 'opening at 60% of previous is fine (no warn)', () => {
  const r = validateMeterReading('5700', 9450, 'opening');
  ok(r.ok);
  no(r.warn);
});
test('Rule 7', 'opening equal to previous is fine', () => {
  const r = validateMeterReading('9450', 9450, 'opening');
  ok(r.ok);
  no(r.warn);
});
test('Rule 7', 'warn message mentions pump replacement', () => {
  const r = validateMeterReading('1000', 9450, 'opening');
  ok(r.warn);
  ok(r.error.toLowerCase().includes('pump') || r.error.toLowerCase().includes('replaced'));
});
test('Rule 7', 'no previous reading means no warn', () => {
  const r = validateMeterReading('100', 0, 'opening');
  ok(r.ok);
  no(r.warn);
});

// ════════════════════════════════════════════════════════════════════════════
// Rule 8 — Opening: block if < 1 when previous > 100 (screenshot bug)
// ════════════════════════════════════════════════════════════════════════════
test('Rule 8 [SCREENSHOT BUG]', '.35689 with prev=0.97 is rejected (caught here too)', () => {
  // .35689 has 5dp — already caught by Rule 4
  // But what if someone entered .35 (valid 2dp) with previous 9450?
  const r = validateMeterReading('.35', 9450, 'opening');
  no(r.ok, '.35 should be blocked when previous reading is 9450');
  ok(r.error.toLowerCase().includes('decimal') || r.error.toLowerCase().includes('low'));
});
test('Rule 8', '0.97 with prev=9450 is blocked', () => {
  const r = validateMeterReading('0.97', 9450, 'opening');
  no(r.ok);
});
test('Rule 8', '0.5 with prev=200 is blocked', () => {
  no(validateMeterReading('0.5', 200, 'opening').ok);
});
test('Rule 8', '0.5 with prev=0 is allowed (new pump)', () => {
  ok(validateMeterReading('0.5', 0, 'opening').ok);
});
test('Rule 8', '0.97 with prev=0.5 is allowed (low-reading pump, both < 1)', () => {
  ok(validateMeterReading('0.97', 0.5, 'opening').ok);
});
test('Rule 8', '0.00 with prev=100 is blocked', () => {
  no(validateMeterReading('0.00', 100, 'opening').ok);
});
test('Rule 8', 'exactly 1.00 with prev=9450 is allowed (e.g. new pump set to 1)', () => {
  // val=1 is not < 1, so this falls through to Rule 7 warn territory
  const r = validateMeterReading('1.00', 9450, 'opening');
  // Should be warn (not hard block) since 1 is < 50% of 9450
  ok(r.ok, 'ok should be true for val=1 (warn, not block)');
  ok(r.warn, 'Should warn since 1 is much less than 9450');
});

// ════════════════════════════════════════════════════════════════════════════
// Real-world scenario tests
// ════════════════════════════════════════════════════════════════════════════
test('Real world', 'typical morning opening 9450 → valid', () => {
  ok(validateMeterReading('9450', 9000, 'opening').ok);
});
test('Real world', 'closing 9750 after opening 9450 → valid (300L sold)', () => {
  const r = validateMeterReading('9750', 9450, 'closing');
  ok(r.ok); no(r.warn);
});
test('Real world', 'new pump at 0 opening → valid', () => {
  ok(validateMeterReading('0', 0, 'opening').ok);
});
test('Real world', 'pump replaced — new opening 500 vs old 45000 → warns not blocks', () => {
  const r = validateMeterReading('500', 45000, 'opening');
  ok(r.ok, 'Pump replacement should be allowed with warning');
  ok(r.warn, 'Should warn about dramatic drop');
});
test('Real world', 'typo: entered 94500 instead of 9450 for closing', () => {
  // 94500 - 9450 = 85050 > 50000 → blocked
  no(validateMeterReading('94500', 9450, 'closing').ok);
});
test('Real world', 'correct reading after a long shift (40000L sold)', () => {
  ok(validateMeterReading('49450', 9450, 'closing').ok);
});
test('Real world', 'Nozzle B reading 9450 with prev 0 (first shift ever)', () => {
  ok(validateMeterReading('9450', 0, 'opening').ok);
});

// ════════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ════════════════════════════════════════════════════════════════════════════
const groups = {};
results.forEach(r => {
  if (!groups[r.group]) groups[r.group] = [];
  groups[r.group].push(r);
});

console.log('\n════════════════════════════════════════════════════════════════════════');
console.log('  METER READING VALIDATION TEST REPORT');
console.log('════════════════════════════════════════════════════════════════════════');

for (const [group, tests] of Object.entries(groups)) {
  const allPass = tests.every(t => t.ok);
  const icon = allPass ? '✅' : '❌';
  console.log(`\n${icon} ${group}                       [${tests.filter(t=>t.ok).length}/${tests.length} passed]`);
  tests.forEach(t => {
    if (t.ok) {
      console.log(`  ✓  ${t.name}`);
    } else {
      console.log(`  ✗  ${t.name}`);
      console.log(`       ↳ ${t.err}`);
    }
  });
}

console.log('\n' + '─'.repeat(72));
console.log(`  Total: ${_total} tests  |  Passed: ${_pass}  |  Failed: ${_fail}`);
console.log('─'.repeat(72));

if (_fail === 0) {
  console.log('\n✅  All meter reading validation tests passed.\n');
  process.exit(0);
} else {
  console.log(`\n❌  ${_fail} test(s) failed.\n`);
  process.exit(1);
}
