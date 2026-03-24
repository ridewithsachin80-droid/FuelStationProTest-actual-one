const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
router.use(requireAuth, requireRole('admin','hr'));
router.get('/dashboard', async (req,res) => {
  const today=new Date().toISOString().split('T')[0];
  const [e,a,l]=await Promise.all([
    req.db.query(`SELECT COUNT(*) FROM employees WHERE status='active'`),
    req.db.query(`SELECT COUNT(DISTINCT emp_id) FROM attendance WHERE date=$1`,[today]),
    req.db.query(`SELECT COUNT(*) FROM leaves WHERE status='pending'`),
  ]);
  res.json({total_employees:parseInt(e.rows[0].count),present_today:parseInt(a.rows[0].count),pending_leaves:parseInt(l.rows[0].count),date:today});
});
module.exports = router;
