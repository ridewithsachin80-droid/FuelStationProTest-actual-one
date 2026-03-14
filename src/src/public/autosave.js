/**
 * Auto-Save Drafts Module
 * Automatically saves form data to localStorage every 5 seconds
 * Restores draft on page load if available
 * 
 * Usage:
 * 1. Include this file in your HTML
 * 2. Call AutoSave.init() when page loads
 * 3. Call AutoSave.register(formId, fields) for each form
 * 
 * Features:
 * - Auto-saves every 5 seconds
 * - Restores on page load
 * - Clears after successful submit
 * - Shows visual indicator when saving
 * - Works offline
 */

const AutoSave = {
  interval: 5000, // 5 seconds
  timers: {},
  
  /**
   * Initialize auto-save system
   */
  init() {
    console.log('[AutoSave] Initialized');
    this.cleanupOldDrafts();
  },

  /**
   * Register a form for auto-saving
   * @param {string} formId - Unique identifier for this form
   * @param {Array} fields - Array of field IDs to save
   */
  register(formId, fields) {
    console.log(`[AutoSave] Registered form: ${formId}`);
    
    // Try to restore draft on registration
    this.restore(formId, fields);
    
    // Start auto-save timer
    this.timers[formId] = setInterval(() => {
      this.save(formId, fields);
    }, this.interval);
  },

  /**
   * Unregister a form (stop auto-saving)
   */
  unregister(formId) {
    if (this.timers[formId]) {
      clearInterval(this.timers[formId]);
      delete this.timers[formId];
      console.log(`[AutoSave] Unregistered form: ${formId}`);
    }
  },

  /**
   * Save form data to localStorage
   */
  save(formId, fields) {
    try {
      const data = {};
      let hasData = false;

      fields.forEach(fieldId => {
        const element = document.getElementById(fieldId);
        if (element) {
          const value = element.type === 'checkbox' 
            ? element.checked 
            : element.value;
          
          if (value !== '' && value !== null && value !== undefined) {
            data[fieldId] = value;
            hasData = true;
          }
        }
      });

      if (hasData) {
        const draft = {
          formId,
          data,
          timestamp: Date.now(),
          expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
        };

        localStorage.setItem(`draft_${formId}`, JSON.stringify(draft));
        this.showSaveIndicator();
        
        console.log(`[AutoSave] Saved draft for ${formId}`, data);
      }
    } catch (error) {
      console.error('[AutoSave] Error saving draft:', error);
    }
  },

  /**
   * Restore form data from localStorage
   */
  restore(formId, fields) {
    try {
      const draftStr = localStorage.getItem(`draft_${formId}`);
      if (!draftStr) return false;

      const draft = JSON.parse(draftStr);
      
      // Check if draft is expired
      if (Date.now() > draft.expiresAt) {
        localStorage.removeItem(`draft_${formId}`);
        return false;
      }

      // Ask user if they want to continue
      const timeSince = this.formatTimeSince(draft.timestamp);
      const shouldRestore = confirm(
        `You have unsaved work from ${timeSince}. Continue where you left off?`
      );

      if (!shouldRestore) {
        localStorage.removeItem(`draft_${formId}`);
        return false;
      }

      // Restore data to form fields
      Object.keys(draft.data).forEach(fieldId => {
        const element = document.getElementById(fieldId);
        if (element) {
          if (element.type === 'checkbox') {
            element.checked = draft.data[fieldId];
          } else {
            element.value = draft.data[fieldId];
          }
        }
      });

      console.log(`[AutoSave] Restored draft for ${formId}`);
      this.showRestoreNotification();
      return true;

    } catch (error) {
      console.error('[AutoSave] Error restoring draft:', error);
      return false;
    }
  },

  /**
   * Clear saved draft (call after successful submit)
   */
  clear(formId) {
    localStorage.removeItem(`draft_${formId}`);
    console.log(`[AutoSave] Cleared draft for ${formId}`);
  },

  /**
   * Clear all drafts for this tenant
   */
  clearAll() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('draft_')) {
        localStorage.removeItem(key);
      }
    });
    console.log('[AutoSave] Cleared all drafts');
  },

  /**
   * Clean up expired drafts
   */
  cleanupOldDrafts() {
    const keys = Object.keys(localStorage);
    let cleaned = 0;

    keys.forEach(key => {
      if (key.startsWith('draft_')) {
        try {
          const draft = JSON.parse(localStorage.getItem(key));
          if (Date.now() > draft.expiresAt) {
            localStorage.removeItem(key);
            cleaned++;
          }
        } catch (error) {
          // Invalid draft, remove it
          localStorage.removeItem(key);
          cleaned++;
        }
      }
    });

    if (cleaned > 0) {
      console.log(`[AutoSave] Cleaned up ${cleaned} expired drafts`);
    }
  },

  /**
   * Show save indicator (brief visual feedback)
   */
  showSaveIndicator() {
    // Create or get indicator element
    let indicator = document.getElementById('autosave-indicator');
    
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'autosave-indicator';
      indicator.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4CAF50;
        color: white;
        padding: 10px 20px;
        border-radius: 4px;
        font-size: 14px;
        opacity: 0;
        transition: opacity 0.3s;
        z-index: 10000;
      `;
      indicator.textContent = '✓ Draft saved';
      document.body.appendChild(indicator);
    }

    // Show indicator
    indicator.style.opacity = '1';
    
    // Hide after 2 seconds
    setTimeout(() => {
      indicator.style.opacity = '0';
    }, 2000);
  },

  /**
   * Show restore notification
   */
  showRestoreNotification() {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #2196F3;
      color: white;
      padding: 15px 20px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 10000;
      animation: slideIn 0.3s;
    `;
    notification.textContent = '✓ Draft restored';
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  },

  /**
   * Format time since timestamp
   */
  formatTimeSince(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  },

  /**
   * Get all saved drafts (for debugging)
   */
  getAllDrafts() {
    const drafts = {};
    const keys = Object.keys(localStorage);
    
    keys.forEach(key => {
      if (key.startsWith('draft_')) {
        try {
          drafts[key] = JSON.parse(localStorage.getItem(key));
        } catch (error) {
          console.error(`Error parsing draft ${key}:`, error);
        }
      }
    });

    return drafts;
  }
};

// Auto-initialize on page load
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    AutoSave.init();
  });
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoSave;
}

// Make available globally
if (typeof window !== 'undefined') {
  window.AutoSave = AutoSave;
}
