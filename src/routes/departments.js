const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
router.use(requireAuth);
router.get('/', async (req,res) => { const { rows }=await req.db.query(`SELECT * FROM departments ORDER BY name`); res.json(rows); });
router.post('/', requireRole('admin'), async (req,res) => {
  const { name,head,color='#10b981' }=req.body;
  if(!name) return res.status(400).json({error:'Name required'});
  const { rows }=await req.db.query(`INSERT INTO departments (tenant_id,name,head,color) VALUES ($1,$2,$3,$4) RETURNING *`,[req.tenantId,name,head||null,color]);
  res.status(201).json(rows[0]);
});
router.patch('/:id', requireRole('admin'), async (req,res) => {
  const { name,head,color }=req.body;
  const { rows }=await req.db.query(`UPDATE departments SET name=COALESCE($2,name),head=COALESCE($3,head),color=COALESCE($4,color) WHERE id=$1 RETURNING *`,[req.params.id,name,head,color]);
  res.json(rows[0]||{});
});
router.delete('/:id', requireRole('admin'), async (req,res) => {
  await req.db.query(`DELETE FROM departments WHERE id=$1`,[req.params.id]); res.json({message:'Deleted'});
});
module.exports = router;
