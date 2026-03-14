/**
 * Security utilities for FuelStation Pro
 * Rate limiting, brute force protection, and security middleware
 */

// Simple in-memory rate limiter
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map();
  }
  
  middleware() {
    return (req, res, next) => {
      const key = req.ip || 'unknown';
      const now = Date.now();
      
      if (!this.requests.has(key)) {
        this.requests.set(key, []);
      }
      
      const timestamps = this.requests.get(key).filter(t => now - t < this.windowMs);
      
      if (timestamps.length >= this.maxRequests) {
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil((timestamps[0] + this.windowMs - now) / 1000)
        });
      }
      
      timestamps.push(now);
      this.requests.set(key, timestamps);
      
      // Cleanup old entries periodically
      if (Math.random() < 0.01) {
        this.cleanup(now);
      }
      
      next();
    };
  }
  
  cleanup(now) {
    for (const [key, timestamps] of this.requests.entries()) {
      const valid = timestamps.filter(t => now - t < this.windowMs);
      if (valid.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, valid);
      }
    }
  }
}

// Brute force protection for login attempts
class BruteForceProtection {
  constructor(maxAttempts = 5, lockoutMs = 15 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.attempts = new Map();
  }
  
  recordAttempt(identifier, success) {
    const now = Date.now();
    
    if (!this.attempts.has(identifier)) {
      this.attempts.set(identifier, { count: 0, lockedUntil: null });
    }
    
    const record = this.attempts.get(identifier);
    
    if (success) {
      // Reset on successful login
      this.attempts.delete(identifier);
      return { allowed: true };
    }
    
    // Check if currently locked out
    if (record.lockedUntil && now < record.lockedUntil) {
      return {
        allowed: false,
        lockedUntil: record.lockedUntil,
        remainingMs: record.lockedUntil - now
      };
    }
    
    // Increment failed attempts
    record.count++;
    
    if (record.count >= this.maxAttempts) {
      record.lockedUntil = now + this.lockoutMs;
      return {
        allowed: false,
        lockedUntil: record.lockedUntil,
        remainingMs: this.lockoutMs
      };
    }
    
    this.attempts.set(identifier, record);
    return {
      allowed: true,
      attemptsRemaining: this.maxAttempts - record.count
    };
  }
  
  isLocked(identifier) {
    const record = this.attempts.get(identifier);
    if (!record) return false;
    
    const now = Date.now();
    return record.lockedUntil && now < record.lockedUntil;
  }
}

// Input validation
function validateRequired(data, requiredFields) {
  const missing = [];
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      missing.push(field);
    }
  }
  return missing;
}

// Sanitize input to prevent injection
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[<>]/g, '');
}

module.exports = {
  RateLimiter,
  BruteForceProtection,
  validateRequired,
  sanitizeInput
};
