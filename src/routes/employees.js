const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const validate = (req,res,next) => { const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({errors:e.array()}); next(); };
router.use(requireAuth);

router.get('/', requireRole('admin','hr'), async (req,res) => {
  const { rows } = await req.db.query(`
    SELECT e.id,e.emp_code,e.name,e.email,e.designation,e.phone,e.salary_monthly,
           e.hourly_rate,e.leave_quota,e.joined_date,e.status,e.role,e.dept_id,
           d.name as dept_name,e.created_at
    FROM employees e LEFT JOIN departments d ON d.id=e.dept_id ORDER BY e.name`);
  res.json(rows);
});

router.get('/:id', param('id').isUUID(), validate, async (req,res) => {
  const id = req.role==='employee' ? req.actorId : req.params.id;
  const { rows } = await req.db.query(`SELECT e.*,d.name as dept_name FROM employees e LEFT JOIN departments d ON d.id=e.dept_id WHERE e.id=$1`,[id]);
  if (!rows.length) return res.status(404).json({ error:'Not found' });
  const { password_hash, ...safe } = rows[0];
  res.json(safe);
});

router.post('/', requireRole('admin','hr'),
  body('name').trim().isLength({min:2,max:100}),
  body('email').isEmail().normalizeEmail(),
  body('emp_code').trim().isLength({min:2,max:20}),
  body('password').isLength({min:8,max:128}),
  body('salary_monthly').isFloat({min:0}),
  validate,
  async (req,res) => {
    // Check employee limit from subscription
    const { rows: [sub] } = await req.db.query(`
      SELECT COALESCE(ts.custom_max_emp, sp.max_employees) as max_emp
      FROM tenant_subscriptions ts JOIN subscription_plans sp ON sp.id=ts.plan_id
      WHERE ts.tenant_id=$1 AND ts.status='active' LIMIT 1
    `, [req.tenantId]);
    if (sub) {
      const { rows: [cnt] } = await req.db.query(`SELECT COUNT(*) FROM employees WHERE status='active'`);
      if (parseInt(cnt.count) >= sub.max_emp) {
        return res.status(402).json({ error:`Employee limit reached (${sub.max_emp}). Upgrade your plan.` });
      }
    }
    const { name,email,emp_code,password,dept_id,designation,phone,salary_monthly,hourly_rate=0,leave_quota=18,joined_date,role='employee' } = req.body;
    try {
      const hash = await bcrypt.hash(password,12);
      const { rows } = await req.db.query(
        `INSERT INTO employees (tenant_id,emp_code,name,email,dept_id,designation,phone,salary_monthly,hourly_rate,leave_quota,joined_date,role,password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,emp_code,name,email,role,status,created_at`,
        [req.tenantId,emp_code,name,email,dept_id||null,designation||null,phone||null,salary_monthly,hourly_rate,leave_quota,joined_date||null,role,hash]
      );
      res.status(201).json(rows[0]);
    } catch(err) {
      if (err.code==='23505') return res.status(409).json({ error:'Employee code or email already exists' });
      res.status(500).json({ error:'Failed to create employee' });
    }
  }
);

router.patch('/:id', requireRole('admin','hr'), param('id').isUUID(), validate, async (req,res) => {
  const allowed = ['name','designation','phone','dept_id','salary_monthly','hourly_rate','leave_quota','status','role'];
  const fields = allowed.filter(k=>req.body[k]!==undefined);
  if (!fields.length) return res.status(400).json({ error:'Nothing to update' });
  const sets = fields.map((k,i)=>`${k}=$${i+2}`).join(', ');
  const { rows } = await req.db.query(
    `UPDATE employees SET ${sets},updated_at=NOW() WHERE id=$1 RETURNING id,name,email,role,status`,
    [req.params.id,...fields.map(k=>req.body[k])]
  );
  if (!rows.length) return res.status(404).json({ error:'Not found' });
  res.json(rows[0]);
});

router.delete('/:id', requireRole('admin'), param('id').isUUID(), validate, async (req,res) => {
  await req.db.query(`UPDATE employees SET status='inactive',updated_at=NOW() WHERE id=$1`,[req.params.id]);
  res.json({ message:'Employee deactivated' });
});
module.exports = router;
