const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, param, body, validationResult } = require('express-validator');
const crypto = require('crypto');
const validate = (req,res,next) => { const e=validationResult(req); if(!e.isEmpty()) return res.status(400).json({errors:e.array()}); next(); };

router.use(requireAuth);

router.get('/',
  query('date').optional().isISO8601(),
  query('month').optional().isInt({min:1,max:12}),
  query('year').optional().isInt({min:2020,max:2100}),
  query('empId').optional().isUUID(),
  validate,
  async (req,res) => {
    const { date, month, year, empId } = req.query;
    try {
      let sql, params;
      if (month && year) {
        sql = `SELECT a.*,e.name as emp_name,e.emp_code,d.name as dept_name
               FROM attendance a JOIN employees e ON e.id=a.emp_id
               LEFT JOIN departments d ON d.id=e.dept_id
               WHERE EXTRACT(MONTH FROM a.date)=$1 AND EXTRACT(YEAR FROM a.date)=$2
               ${empId?'AND a.emp_id=$3':''} ORDER BY a.date DESC,e.name,a.session_no`;
        params = empId ? [month,year,empId] : [month,year];
      } else {
        const d = date ? date.split('T')[0] : new Date().toISOString().split('T')[0];
        sql = `SELECT a.*,e.name as emp_name,e.emp_code,d.name as dept_name
               FROM attendance a JOIN employees e ON e.id=a.emp_id
               LEFT JOIN departments d ON d.id=e.dept_id
               WHERE a.date=$1 ${empId?'AND a.emp_id=$2':''} ORDER BY e.name,a.session_no`;
        params = empId ? [d,empId] : [d];
      }
      const { rows } = await req.db.query(sql, params);
      res.json(rows);
    } catch(err) { res.status(500).json({ error:'Failed to fetch attendance' }); }
  }
);

router.post('/checkin',
  body('session_no').optional().isInt({min:1,max:3}),
  body('location').optional().isString().trim().isLength({max:200}),
  validate,
  async (req,res) => {
    const { session_no=1, location, qr_token } = req.body;
    const today = new Date().toISOString().split('T')[0];
    try {
      const { rows: ex } = await req.db.query(
        `SELECT id FROM attendance WHERE emp_id=$1 AND date=$2 AND session_no=$3`,
        [req.actorId,today,session_no]
      );
      if (ex.length) return res.status(409).json({ error:'Already checked in for this session' });
      const tokenHash = qr_token ? crypto.createHash('sha256').update(qr_token).digest('hex') : null;
      const { rows } = await req.db.query(
        `INSERT INTO attendance (tenant_id,emp_id,date,session_no,check_in,location,qr_token_hash)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6) RETURNING *`,
        [req.tenantId,req.actorId,today,session_no,location||null,tokenHash]
      );
      res.status(201).json(rows[0]);
    } catch(err) { res.status(500).json({ error:'Check-in failed' }); }
  }
);

router.patch('/:id/checkout', param('id').isUUID(), validate, async (req,res) => {
  try {
    const { rows } = await req.db.query(
      `UPDATE attendance SET check_out=NOW(),
         duration_hr=ROUND(EXTRACT(EPOCH FROM (NOW()-check_in))/3600,2)
       WHERE id=$1 AND emp_id=$2 AND check_out IS NULL RETURNING *`,
      [req.params.id,req.actorId]
    );
    if (!rows.length) return res.status(404).json({ error:'Record not found or already checked out' });
    res.json(rows[0]);
  } catch(err) { res.status(500).json({ error:'Check-out failed' }); }
});

router.get('/summary', requireRole('admin','hr'),
  query('month').isInt({min:1,max:12}), query('year').isInt({min:2020,max:2100}), validate,
  async (req,res) => {
    const { month, year } = req.query;
    const { rows } = await req.db.query(`
      SELECT e.id,e.emp_code,e.name,d.name as dept_name,
        COUNT(DISTINCT a.date) FILTER (WHERE a.check_out IS NOT NULL) as days_present,
        COALESCE(SUM(a.duration_hr) FILTER (WHERE a.check_out IS NOT NULL),0) as total_hours
      FROM employees e
      LEFT JOIN attendance a ON a.emp_id=e.id
        AND EXTRACT(MONTH FROM a.date)=$1 AND EXTRACT(YEAR FROM a.date)=$2
      LEFT JOIN departments d ON d.id=e.dept_id
      WHERE e.status='active' GROUP BY e.id,e.emp_code,e.name,d.name ORDER BY e.name
    `, [month,year]);
    res.json(rows);
  }
);

router.get('/my', async (req,res) => {
  const month = req.query.month || new Date().getMonth()+1;
  const year  = req.query.year  || new Date().getFullYear();
  const { rows } = await req.db.query(
    `SELECT * FROM attendance WHERE emp_id=$1
     AND EXTRACT(MONTH FROM date)=$2 AND EXTRACT(YEAR FROM date)=$3
     ORDER BY date DESC, session_no`,
    [req.actorId,month,year]
  );
  res.json(rows);
});

module.exports = router;
