import { Router } from 'express';
import { camsLogin } from '../cams.js';
import { query } from '../db.js';
import { signSession, setSessionCookie, clearSessionCookie, requireAuth } from '../auth.js';

const router = Router();

function adminIds() {
  return (process.env.ADMIN_EMPLOYEE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

router.post('/login', async (req, res) => {
  const { employeeId, password } = req.body || {};
  if (!employeeId || !password) {
    return res.status(400).json({ message: '사번과 비밀번호를 입력하세요.' });
  }

  const result = await camsLogin(String(employeeId), String(password));
  if (!result.ok) {
    return res.status(result.status).json({ message: result.message });
  }

  const emp = result.employee;
  const id = String(emp.employeeId || employeeId);
  const role = adminIds().includes(id) ? 'admin' : 'member';

  // upsert (관리자 지정 시 role 갱신, 단 기존 admin은 유지)
  const { rows } = await query(
    `INSERT INTO users (employee_id, name, department, join_date, role, last_login)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (employee_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, users.name),
       department = COALESCE(EXCLUDED.department, users.department),
       join_date = COALESCE(EXCLUDED.join_date, users.join_date),
       role = CASE WHEN $5 = 'admin' OR users.role = 'admin' THEN 'admin' ELSE users.role END,
       last_login = now()
     RETURNING employee_id, name, department, role`,
    [id, emp.name || null, emp.department || null, emp.joinDate || null, role]
  );

  const user = rows[0];
  const token = signSession({ ...user });
  setSessionCookie(res, token);
  res.json({ user });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
