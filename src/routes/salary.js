const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);
router.get('/', async (req,res) => {
  const month=req.query.month||new Date().getMonth()+1;
  const year=req.query.year||new Date().getFullYear();
  const isAdmin=['admin','hr'].includes(req.role);
  try {
    const { rows: cfg }=await req.db.query(`SELECT * FROM tenant_config WHERE tenant_id=$1`,[req.tenantId]);
    const c=cfg[0]||{work_hours:8,ot_multiplier:1.5,deduct_per_absent:2000};
    const dInMonth=new Date(year,month,0).getDate();
    let workDays=0;
    for(let d=1;d<=dInMonth;d++){const dow=new Date(year,month-1,d).getDay();if(dow!==0&&dow!==6)workDays++;}
    const empFilter=isAdmin?'':`AND e.id='${req.actorId}'`;
    const { rows }=await req.db.query(`
      SELECT e.id,e.emp_code,e.name,e.salary_monthly,e.hourly_rate,d.name as dept_name,
        COUNT(DISTINCT a.date) FILTER (WHERE a.check_out IS NOT NULL) as days_present,
        COALESCE(SUM(a.duration_hr) FILTER (WHERE a.check_out IS NOT NULL),0) as total_hours
      FROM employees e
      LEFT JOIN attendance a ON a.emp_id=e.id
        AND EXTRACT(MONTH FROM a.date)=$1 AND EXTRACT(YEAR FROM a.date)=$2
      LEFT JOIN departments d ON d.id=e.dept_id
      WHERE e.status='active' ${empFilter}
      GROUP BY e.id,e.emp_code,e.name,e.salary_monthly,e.hourly_rate,d.name
      ORDER BY e.name
    `,[month,year]);
    const result=rows.map(r=>{
      const dp=parseInt(r.days_present)||0,th=parseFloat(r.total_hours)||0;
      const ab=Math.max(0,workDays-dp),reg=Math.min(th,dp*parseFloat(c.work_hours));
      const ot=Math.max(0,th-reg),base=(r.salary_monthly/workDays)*dp;
      const otPay=ot*r.hourly_rate*parseFloat(c.ot_multiplier);
      const ded=ab*parseFloat(c.deduct_per_absent),net=Math.max(0,base+otPay-ded);
      return{...r,work_days:workDays,days_absent:ab,regular_hours:Math.round(reg*100)/100,
        overtime_hours:Math.round(ot*100)/100,base_pay:Math.round(base),
        overtime_pay:Math.round(otPay),deductions:Math.round(ded),net_salary:Math.round(net)};
    });
    res.json(result);
  } catch(err){res.status(500).json({error:'Salary calculation failed'});}
});
module.exports = router;
