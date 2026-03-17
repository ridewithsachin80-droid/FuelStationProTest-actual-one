'use strict';
// Extracts pure functions from security.js for isolated unit testing
const { sanitizeString, sanitizeObject, generateToken } = require('../../src/security');

// Pure logic extraction of requireRole — testable without Express req/res
function checkRequireRole(user, ...roles) {
  const { userType, userRole } = user;
  if (!userType) return false;
  if (userType === 'super') return true;
  if (roles.includes(userType)) return true;
  if (userRole && roles.some(r => r.toLowerCase() === userRole.toLowerCase())) return true;
  if (roles.includes('admin') && userType === 'admin') return true;
  return false;
}

module.exports = { sanitizeString, sanitizeObject, generateToken, checkRequireRole };
