const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

/**
 * Hash a PIN for storage
 */
async function hashPin(pin) {
  return bcrypt.hash(pin.toString(), SALT_ROUNDS);
}

/**
 * Verify a PIN against stored hash
 */
async function verifyPin(pin, hash) {
  return bcrypt.compare(pin.toString(), hash);
}

/**
 * Generate a random PIN
 */
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

module.exports = {
  hashPin,
  verifyPin,
  generatePin
};
