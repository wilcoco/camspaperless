import { Router } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { requireAdmin } from '../auth.js';
import { periodKey, prevPeriodKey, periodRange, computeStatus, CYCLE_LABELS } from '../periodicity.js';

const router = Router();
router.use(requireAdmin);

const CYCLE_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];

/* ---------------- 업무(tasks) ---------------- */

router.get('/tasks', async (req, res) => {
  const { rows } = await query(
    `SELECT t.*,
            (SELECT count(*) FROM assignments a WHERE a.task_id = t.id AND a.active) AS assignee_count
     FROM tasks t ORDER BY t.active DESC, t.id DESC`
  );
  res.json({ tasks: rows.map((t) => ({ ...t, cycle_label: CYCLE_LABELS[t.cycle_type] || t.cycle_type })) });
});

router.post('/tasks', async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ message: '업무명을 입력하세요.' });
  const cycleType = CYCLE_TYPES.includes(b.cycle_type) ? b.cycle_type : 'monthly';
  const requireQr = !!b.require_qr;
  const qrToken = requireQr ? crypto.randomUUID() : null;

  const { rows } = await query(
    `INSERT INTO tasks
      (title, description, category, cycle_type, cycle_days, warn_before_days,
       require_photo, require_gps, require_qr, location_name, qr_token,
       gps_lat, gps_lng, checklist, start_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      b.title, b.description || null, b.category || null, cycleType,
      cycleType === 'custom' ? (parseInt(b.cycle_days, 10) || 30) : null,
      parseInt(b.warn_before_days, 10) || 3,
      b.require_photo !== false, !!b.require_gps, requireQr,
      b.location_name || null, qrToken,
      b.gps_lat != null ? Number(b.gps_lat) : null,
      b.gps_lng != null ? Number(b.gps_lng) : null,
      JSON.stringify(Array.isArray(b.checklist) ? b.checklist : []),
      b.start_date || new Date().toISOString().slice(0, 10),
      req.user.employee_id,
    ]
  );
  res.json({ task: rows[0] });
});

router.put('/tasks/:id', async (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id, 10);
  const cur = (await query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
  if (!cur) return res.status(404).json({ message: '업무를 찾을 수 없습니다.' });

  const cycleType = CYCLE_TYPES.includes(b.cycle_type) ? b.cycle_type : cur.cycle_type;
  const requireQr = b.require_qr != null ? !!b.require_qr : cur.require_qr;
  // QR 사용으로 바뀌었는데 토큰이 없으면 발급
  const qrToken = requireQr ? (cur.qr_token || crypto.randomUUID()) : cur.qr_token;

  const { rows } = await query(
    `UPDATE tasks SET
       title=$1, description=$2, category=$3, cycle_type=$4, cycle_days=$5,
       warn_before_days=$6, require_photo=$7, require_gps=$8, require_qr=$9,
       location_name=$10, qr_token=$11, gps_lat=$12, gps_lng=$13,
       checklist=$14, start_date=$15, active=$16
     WHERE id=$17 RETURNING *`,
    [
      b.title ?? cur.title, b.description ?? cur.description, b.category ?? cur.category,
      cycleType, cycleType === 'custom' ? (parseInt(b.cycle_days, 10) || cur.cycle_days || 30) : null,
      b.warn_before_days != null ? parseInt(b.warn_before_days, 10) : cur.warn_before_days,
      b.require_photo != null ? !!b.require_photo : cur.require_photo,
      b.require_gps != null ? !!b.require_gps : cur.require_gps,
      requireQr,
      b.location_name ?? cur.location_name, qrToken,
      b.gps_lat != null ? Number(b.gps_lat) : cur.gps_lat,
      b.gps_lng != null ? Number(b.gps_lng) : cur.gps_lng,
      JSON.stringify(Array.isArray(b.checklist) ? b.checklist : cur.checklist),
      b.start_date ?? cur.start_date,
      b.active != null ? !!b.active : cur.active,
      id,
    ]
  );
  res.json({ task: rows[0] });
});

router.delete('/tasks/:id', async (req, res) => {
  await query('DELETE FROM tasks WHERE id = $1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// QR 코드 PNG(dataURL) 생성 — 부착용
router.get('/tasks/:id/qr', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = (await query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
  if (!task) return res.status(404).json({ message: '업무 없음' });
  if (!task.qr_token) return res.status(400).json({ message: 'QR 사용 업무가 아닙니다.' });
  // 스캔 시 앱이 인식할 페이로드
  const payload = `CAMSP:${id}:${task.qr_token}`;
  const dataUrl = await QRCode.toDataURL(payload, { width: 480, margin: 2 });
  res.json({ taskId: id, title: task.title, location: task.location_name, payload, dataUrl });
});

/* ---------------- 사용자(users) ---------------- */

router.get('/users', async (req, res) => {
  const { rows } = await query(
    'SELECT employee_id, name, department, role, last_login FROM users ORDER BY name NULLS LAST, employee_id'
  );
  res.json({ users: rows });
});

// 사번으로 미리 등록(placeholder). 로그인 시 CAMS 정보로 갱신됨.
router.post('/users', async (req, res) => {
  const list = Array.isArray(req.body?.users) ? req.body.users : [req.body];
  const created = [];
  for (const u of list) {
    const id = String(u.employee_id || '').trim();
    if (!id) continue;
    const { rows } = await query(
      `INSERT INTO users (employee_id, name, department)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, users.name),
         department = COALESCE(EXCLUDED.department, users.department)
       RETURNING employee_id, name, department, role`,
      [id, u.name || null, u.department || null]
    );
    created.push(rows[0]);
  }
  res.json({ users: created });
});

/* ---------------- 배정(assignments) ---------------- */

router.get('/tasks/:id/assignments', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await query(
    `SELECT a.id, a.employee_id, a.active, u.name, u.department
     FROM assignments a JOIN users u ON u.employee_id = a.employee_id
     WHERE a.task_id = $1 ORDER BY u.name NULLS LAST`,
    [id]
  );
  res.json({ assignments: rows });
});

// 업무에 담당자 배정 (employee_id 배열 또는 {employee_id,name} 배열)
router.post('/tasks/:id/assignments', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const items = Array.isArray(req.body?.employees) ? req.body.employees : [];
  const out = [];
  for (const raw of items) {
    const item = typeof raw === 'string' ? { employee_id: raw } : raw;
    const empId = String(item.employee_id || '').trim();
    if (!empId) continue;
    await query(
      `INSERT INTO users (employee_id, name, department)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)`,
      [empId, item.name || null, item.department || null]
    );
    const { rows } = await query(
      `INSERT INTO assignments (task_id, employee_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_id, employee_id) DO UPDATE SET active = true
       RETURNING id, employee_id`,
      [taskId, empId, req.user.employee_id]
    );
    out.push(rows[0]);
  }
  res.json({ assignments: out });
});

router.delete('/assignments/:id', async (req, res) => {
  await query('DELETE FROM assignments WHERE id = $1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

/* ---------------- 리포트 ---------------- */

// 전체 현황: 활성 업무별 현재 주기 완료율
router.get('/reports/overview', async (req, res) => {
  const today = new Date();
  const tasks = (await query('SELECT * FROM tasks WHERE active = true ORDER BY id')).rows;
  const out = [];
  for (const t of tasks) {
    const curKey = periodKey(today, t.cycle_type, t.cycle_days, t.start_date);
    const assignees = (await query(
      'SELECT employee_id FROM assignments WHERE task_id = $1 AND active', [t.id]
    )).rows.map((r) => r.employee_id);
    const doneRows = (await query(
      'SELECT DISTINCT employee_id FROM records WHERE task_id = $1 AND period_key = $2',
      [t.id, curKey]
    )).rows.map((r) => r.employee_id);
    const doneSet = new Set(doneRows);
    const total = assignees.length;
    const done = assignees.filter((e) => doneSet.has(e)).length;
    const { end } = periodRange(today, t.cycle_type, t.cycle_days, t.start_date);
    const daysLeft = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate()) -
      new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    out.push({
      id: t.id, title: t.title, category: t.category,
      cycle_type: t.cycle_type, cycle_label: CYCLE_LABELS[t.cycle_type] || t.cycle_type,
      location_name: t.location_name, period_key: curKey,
      total, done, pending: total - done,
      rate: total ? Math.round((done / total) * 100) : 0,
      days_left: daysLeft, period_end: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`,
    });
  }
  res.json({ today: today.toISOString().slice(0, 10), tasks: out });
});

// 업무 상세 리포트: 담당자별 수행/미수행
router.get('/reports/task/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = (await query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
  if (!task) return res.status(404).json({ message: '업무 없음' });
  const today = new Date();
  const curKey = req.query.period || periodKey(today, task.cycle_type, task.cycle_days, task.start_date);
  const prevKey = prevPeriodKey(today, task.cycle_type, task.cycle_days, task.start_date);

  const assignees = (await query(
    `SELECT a.id AS assignment_id, a.created_at AS assignment_created_at, a.employee_id, u.name, u.department
     FROM assignments a JOIN users u ON u.employee_id = a.employee_id
     WHERE a.task_id = $1 AND a.active ORDER BY u.name NULLS LAST`,
    [id]
  )).rows;

  const recs = (await query(
    `SELECT * FROM records WHERE task_id = $1 AND period_key IN ($2, $3) ORDER BY performed_at DESC`,
    [id, curKey, prevKey]
  )).rows;
  const curByEmp = new Map();
  const prevByEmp = new Map();
  for (const r of recs) {
    if (r.period_key === curKey && !curByEmp.has(r.employee_id)) curByEmp.set(r.employee_id, r);
    if (r.period_key === prevKey && !prevByEmp.has(r.employee_id)) prevByEmp.set(r.employee_id, r);
  }

  const rows = assignees.map((a) => {
    const rec = curByEmp.get(a.employee_id) || null;
    const since = task.start_date && a.assignment_created_at &&
      new Date(task.start_date) > new Date(a.assignment_created_at)
      ? task.start_date : (a.assignment_created_at || task.start_date);
    const st = computeStatus(today, task, !!rec, prevByEmp.has(a.employee_id), since);
    return {
      employee_id: a.employee_id, name: a.name, department: a.department,
      done: !!rec, status: st.status, days_left: st.daysLeft,
      record: rec ? {
        id: rec.id, performed_at: rec.performed_at, note: rec.note, issue: rec.status === 'issue',
        photo_url: rec.photo_url, gps_lat: rec.gps_lat, gps_lng: rec.gps_lng,
        qr_verified: rec.qr_verified, checklist_results: rec.checklist_results,
      } : null,
    };
  });

  res.json({
    task: { ...task, cycle_label: CYCLE_LABELS[task.cycle_type] || task.cycle_type },
    period_key: curKey, prev_period_key: prevKey, rows,
  });
});

// 지도용: 특정 업무/주기의 GPS 기록
router.get('/reports/map', async (req, res) => {
  const taskId = parseInt(req.query.taskId, 10);
  const task = (await query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  if (!task) return res.status(404).json({ message: '업무 없음' });
  const today = new Date();
  const key = req.query.period || periodKey(today, task.cycle_type, task.cycle_days, task.start_date);
  const { rows } = await query(
    `SELECT r.id, r.employee_id, u.name, r.performed_at, r.gps_lat, r.gps_lng,
            r.photo_url, r.status, r.qr_verified
     FROM records r LEFT JOIN users u ON u.employee_id = r.employee_id
     WHERE r.task_id = $1 AND r.period_key = $2 AND r.gps_lat IS NOT NULL`,
    [taskId, key]
  );
  res.json({
    task: { id: task.id, title: task.title, gps_lat: task.gps_lat, gps_lng: task.gps_lng, location_name: task.location_name },
    period_key: key, points: rows,
  });
});

export default router;
