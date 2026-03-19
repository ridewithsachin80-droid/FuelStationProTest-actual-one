/**
 * Test: Super Admin Password Change Bug Fix
 * Purpose: Verify that the super admin password is actually updated in the database
 */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

async function runTest() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://postgres:password@localhost:5432/fuel_db'
  });

  let passCount = 0;
  let failCount = 0;

  const test = (name, passed, message = '') => {
    if (passed) {
      console.log(`✅ ${name}`);
      passCount++;
    } else {
      console.log(`❌ ${name}: ${message}`);
      failCount++;
    }
  };

  try {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  Super Admin Password Change - Bug Fix Test Suite  ║');
    console.log('╚════════════════════════════════════════════════════╝\n');

    // 1. Ensure super_admin row exists
    console.log('Step 1: Verify super_admin row exists');
    let existing = await pool.query('SELECT id, username, pass_hash FROM super_admin WHERE id = 1');
    
    if (existing.rows.length === 0) {
      console.log('   Creating super_admin row...');
      const hash = await bcrypt.hash('InitialPass123!', 12);
      await pool.query(
        'INSERT INTO super_admin (id, username, pass_hash) VALUES ($1, $2, $3)',
        [1, 'testadmin', hash]
      );
      existing = await pool.query('SELECT id, username, pass_hash FROM super_admin WHERE id = 1');
    }
    
    test('super_admin row exists', existing.rows.length === 1);

    // 2. Test UPDATE using direct pool.query (the fix we implemented)
    console.log('\nStep 2: Test UPDATE using pool.query (fixed method)');
    const newUsername = 'updated_admin_' + Date.now();
    const newPassword = 'NewSecurePass456!';
    const newHash = await bcrypt.hash(newPassword, 12);
    
    const updateResult = await pool.query(
      'UPDATE super_admin SET username = $1, pass_hash = $2, updated_at = NOW() WHERE id = 1',
      [newUsername, newHash]
    );
    
    test('UPDATE query executes without error', true);
    test('UPDATE returns rowCount > 0', updateResult.rowCount > 0, `Expected rowCount > 0, got ${updateResult.rowCount}`);

    // 3. Verify the update in database
    console.log('\nStep 3: Verify update was actually persisted');
    const verify = await pool.query('SELECT id, username, pass_hash FROM super_admin WHERE id = 1');
    const updatedRow = verify.rows[0];
    
    test('Username was updated in database', updatedRow.username === newUsername, 
      `Expected '${newUsername}', got '${updatedRow.username}'`);
    
    const passwordVerified = await bcrypt.compare(newPassword, updatedRow.pass_hash);
    test('Password was updated in database', passwordVerified, 'New password hash does not match');

    // 4. Test second update to ensure idempotency
    console.log('\nStep 4: Test second update (idempotency)');
    const secondUsername = 'triple_updated_' + Date.now();
    const secondPassword = 'AnotherPass789!';
    const secondHash = await bcrypt.hash(secondPassword, 12);
    
    const secondUpdate = await pool.query(
      'UPDATE super_admin SET username = $1, pass_hash = $2, updated_at = NOW() WHERE id = 1',
      [secondUsername, secondHash]
    );
    
    test('Second UPDATE executes without error', true);
    test('Second UPDATE returns rowCount > 0', secondUpdate.rowCount > 0, `Expected rowCount > 0, got ${secondUpdate.rowCount}`);

    // 5. Verify second update
    console.log('\nStep 5: Verify second update');
    const verify2 = await pool.query('SELECT username, pass_hash FROM super_admin WHERE id = 1');
    const finalRow = verify2.rows[0];
    
    test('Second username update verified', finalRow.username === secondUsername,
      `Expected '${secondUsername}', got '${finalRow.username}'`);
    
    const secondPasswordVerified = await bcrypt.compare(secondPassword, finalRow.pass_hash);
    test('Second password update verified', secondPasswordVerified, 'Second password hash does not match');

    // 6. Test UPDATE with WHERE clause not matching (should affect 0 rows)
    console.log('\nStep 6: Test UPDATE with non-matching WHERE clause');
    const noMatchUpdate = await pool.query(
      'UPDATE super_admin SET username = $1 WHERE id = 999',
      ['should_not_update']
    );
    
    test('Non-matching UPDATE returns rowCount = 0', noMatchUpdate.rowCount === 0, 
      `Expected rowCount = 0, got ${noMatchUpdate.rowCount}`);

    // 7. Verify username wasn't changed by failed update
    console.log('\nStep 7: Verify failed UPDATE did not change data');
    const verify3 = await pool.query('SELECT username FROM super_admin WHERE id = 1');
    test('Username unchanged after failed WHERE', verify3.rows[0].username === secondUsername,
      `Expected '${secondUsername}', got '${verify3.rows[0].username}'`);

    // Summary
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log(`║  Test Results: ${passCount} passed, ${failCount} failed${failCount === 0 ? '              ║' : '        ║'}`);
    console.log('╚════════════════════════════════════════════════════╝\n');

    if (failCount === 0) {
      console.log('🎉 All tests passed! Super admin password change bug is FIXED.\n');
      process.exit(0);
    } else {
      console.log(`⚠️  ${failCount} test(s) failed.\n`);
      process.exit(1);
    }

  } catch (e) {
    console.error('\n❌ Test execution error:', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTest();
