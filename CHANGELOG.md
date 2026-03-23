
## v57–v67 — Session 3 (2026-03-23)

### Security Hardening
- **PIN auth SC7**: Legacy `pinHash` path now only allows SHA-256↔SHA-256 comparison. Bcrypt-stored employees always require raw `pin` through full bcrypt verify.
- **PIN auth SC9**: Tenant existence validated before any PIN attempt is processed — prevents phantom-tenantId DB pollution.
- **Sales FIND-02**: Server-side price validation added. Sales where amount deviates >20% from `liters × configured_price` return 422 with clear error. Tolerates discounts and rounding.

### Bug Fixes — Lubes & Products
- **Delete race**: `_lubesSaveInProgress` flag blocks 30-second auto-refresh timer from restoring just-deleted products during the async save window.
- **Edit stock**: `saveLubeProduct` now sets `_stockChanged:true` so `lubes_save` merge preserves the admin's new stock instead of reverting to old DB value.
- **Finance COGS**: `lubesCost` in P&L now uses `costPrice÷qtyPerCarton` per piece (not full carton price). Was showing 300× too high for carton products.
- **Stock value card**: Same per-piece cost fix applied to Lubes page stat card and both balance sheet instances.
- **Credit lube sales**: Lube sale modal now shows credit customer dropdown and requires selection when mode=credit. Previously recorded debt with no customer linked.
- **Sell price auto-fill**: `toggleLpCarton()` now marks sell field as auto-fillable when enabling carton mode on a blank form. `addEventListener` stacking bug removed — replaced with dedicated `lpSellManualInput()` handler.
- **Partial carton warning**: Edit modal now shows "⚠️ Actual: N pieces (M full cartons + K loose)" when editing would silently truncate fractional cartons.

### Bug Fixes — General
- **Vehicle mandatory**: Changed from "required for non-cash" to "required for credit only". UPI/Card sales no longer block without vehicle number.
- **renderPage retry loop**: Fixed infinite loop where failed retry called `renderPage()` which scheduled another retry. Now only re-renders on success. `APP.data` initialised to SEED before retry `loadData()` to prevent null-write errors.
- **Lube stock value** (existing note: also fixed in balance sheet — 3 locations total).

### New Features
- **UTR capture panel**: 3 capture methods on employee UPI sale screen — 📷 camera QR scan (jsQR), 📸 screenshot OCR (Claude Vision via `/api/utr-extract`), 🎤 voice (Web Speech API).
- **UPI Verification Policy**: Admin setting (None/Optional/Encouraged/Required) controls whether employees must capture UTR. Saved to `settings` table.
- **Bank Recon CSV upload**: Parses SBI/HDFC/ICICI/Axis/Kotak/generic CSV. Auto-fills Cash/UPI/Card totals. Mode toggle: Total Match vs Entry-by-Entry with ✅🔴🟡 per-transaction table.
- **Dashboard UPI badge**: Shows count + amount of unverified UPI sales; tapping navigates to Bank Recon.
- **Invoice scan multi-select**: Checkboxes on each scanned product, Select All toggle, "Add All Selected (N)" button. Existing products updated silently; new products queued as sequential Add Product modals.
- **`/api/utr-extract`**: New endpoint using Claude Haiku Vision to extract UTR from payment screenshots.

### Schema
- `sales.utr_ref TEXT DEFAULT ''`
- `sales.payment_status TEXT DEFAULT 'na'`

### Versions: v57→v67
