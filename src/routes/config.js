const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
router.use(requireAuth);
router.get('/', async (req,res) => {
  const { rows }=await req.db.query(`SELECT * FROM tenant_config WHERE tenant_id=$1`,[req.tenantId]);
  res.json(rows[0]||{work_hours:8,ot_multiplier:1.5,grace_min:15,shift_start:'09:00',shift_end:'18:00',deduct_per_absent:2000,half_day_hr:4});
});
router.put('/', requireRole('admin'), async (req,res) => {
  const f=req.body;
  await req.db.query(`
    INSERT INTO tenant_config (tenant_id,work_hours,ot_multiplier,grace_min,shift_start,shift_end,deduct_per_absent,half_day_hr)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (tenant_id) DO UPDATE SET work_hours=$2,ot_multiplier=$3,grace_min=$4,shift_start=$5,shift_end=$6,deduct_per_absent=$7,half_day_hr=$8,updated_at=NOW()
  `,[req.tenantId,f.work_hours||8,f.ot_multiplier||1.5,f.grace_min||15,f.shift_start||'09:00',f.shift_end||'18:00',f.deduct_per_absent||2000,f.half_day_hr||4]);
  res.json({message:'Config saved'});
});
module.exports = router;
