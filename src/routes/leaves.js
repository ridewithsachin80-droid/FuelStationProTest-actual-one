const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
router.use(requireAuth);
router.get('/', async (req,res) => {
  const isAdmin=['admin','hr'].includes(req.role);
  const { rows }=await req.db.query(`
    SELECT l.*,e.name as emp_name,e.emp_code,a.name as approved_by_name
    FROM leaves l JOIN employees e ON e.id=l.emp_id LEFT JOIN employees a ON a.id=l.approved_by
    ${isAdmin?'':'WHERE l.emp_id=$1'} ORDER BY l.applied_at DESC`,
    isAdmin?[]:[req.actorId]
  );
  res.json(rows);
});
router.post('/', async (req,res) => {
  const { type,from_date,to_date,reason }=req.body;
  if(!type||!from_date||!to_date) return res.status(400).json({error:'Missing fields'});
  const days=Math.ceil((new Date(to_date)-new Date(from_date))/86400000)+1;
  if(days<1) return res.status(400).json({error:'Invalid dates'});
  const { rows }=await req.db.query(`INSERT INTO leaves (tenant_id,emp_id,type,from_date,to_date,days,reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.tenantId,req.actorId,type,from_date,to_date,days,reason||null]);
  res.status(201).json(rows[0]);
});
router.patch('/:id/status', requireRole('admin','hr'), async (req,res) => {
  const { status }=req.body;
  if(!['approved','rejected'].includes(status)) return res.status(400).json({error:'Invalid status'});
  const { rows }=await req.db.query(`UPDATE leaves SET status=$2,approved_by=$3,resolved_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,status,req.actorId]);
  res.json(rows[0]||{});
});
module.exports = router;
