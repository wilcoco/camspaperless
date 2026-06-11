import { Router } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { requireAdmin } from '../auth.js';
import { camsEmployees, camsEmployee } from '../cams.js';
import { periodKey, prevPeriodKey, periodRange, computeStatus, cycleLabel, ymd } from '../periodicity.js';

const router = Router();
router.use(requireAdmin);

const CYCLE_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];

// 체크리스트에 QR 입력 항목이 있으면 배정 QR 토큰이 필요하다.
// 항목은 {label, inputs:[...]} (신) 또는 {label, type} (구) 형태.
function checklistHasQr(list) {
  return Array.isArray(list) && list.some((it) => it && (
    (Array.isArray(it.inputs) && it.inputs.includes('qr')) || it.type === 'qr'
  ));
}

// 주기 간격은 매주/매월에서만 의미가 있다 (격주=weekly 2, 반기=monthly 6).
function normCycleInterval(cycleType, raw, fallback = 1) {
  if (cycleType !== 'weekly' && cycleType !== 'monthly') return 1;
  return Math.max(1, parseInt(raw, 10) || fallback);
}

/* ---------------- 업무(tasks) ---------------- */

router.get('/tasks', async (req, res) => {
  const { rows } = await query(
    `SELECT t.*,
            (SELECT count(*) FROM assignments a WHERE a.task_id = t.id AND a.active) AS assignee_count
     FROM tasks t ORDER BY t.active DESC, t.id DESC`
  );
  res.json({ tasks: rows.map((t) => ({ ...t, cycle_label: cycleLabel(t) })) });
});

router.post('/tasks', async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ message: '업무명을 입력하세요.' });
  const cycleType = CYCLE_TYPES.includes(b.cycle_type) ? b.cycle_type : 'monthly';
  const requireQr = !!b.require_qr;
  const qrToken = requireQr ? crypto.randomUUID() : null;

  const { rows } = await query(
    `INSERT INTO tasks
      (title, description, category, cycle_type, cycle_days, cycle_interval, times_per_period,
       warn_before_days, require_photo, require_gps, require_qr, location_name, qr_token,
       gps_lat, gps_lng, checklist, start_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      b.title, b.description || null, b.category || null, cycleType,
      cycleType === 'custom' ? (parseInt(b.cycle_days, 10) || 30) : null,
      normCycleInterval(cycleType, b.cycle_interval),
      Math.max(1, parseInt(b.times_per_period, 10) || 1),
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
       cycle_interval=$6, times_per_period=$7,
       warn_before_days=$8, require_photo=$9, require_gps=$10, require_qr=$11,
       location_name=$12, qr_token=$13, gps_lat=$14, gps_lng=$15,
       checklist=$16, start_date=$17, active=$18
     WHERE id=$19 RETURNING *`,
    [
      b.title ?? cur.title, b.description ?? cur.description, b.category ?? cur.category,
      cycleType, cycleType === 'custom' ? (parseInt(b.cycle_days, 10) || cur.cycle_days || 30) : null,
      normCycleInterval(cycleType, b.cycle_interval, cur.cycle_interval || 1),
      b.times_per_period != null ? Math.max(1, parseInt(b.times_per_period, 10) || 1) : (cur.times_per_period || 1),
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

// CAMS ERP 전체 사원 목록을 가져와 구성원 디렉터리에 동기화
router.post('/sync-employees', async (req, res) => {
  const r = await camsEmployees();
  if (!r.ok) return res.status(r.status).json({ message: r.message });
  let synced = 0;
  for (const e of r.employees) {
    const id = String(e.employeeId || e.employee_id || '').trim();
    if (!id) continue;
    await query(
      `INSERT INTO users (employee_id, name, department)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, users.name),
         department = COALESCE(EXCLUDED.department, users.department)`,
      [id, e.name || null, e.department || null]
    );
    synced += 1;
  }
  res.json({ synced });
});

// 특정 사원 상세 (CAMS 원본)
router.get('/employees/:id', async (req, res) => {
  const r = await camsEmployee(req.params.id);
  if (!r.ok) return res.status(r.status).json({ message: r.message });
  res.json({ employee: r.employee });
});

/* ---------------- 배정(assignments) ---------------- */

router.get('/tasks/:id/assignments', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await query(
    `SELECT a.id, a.employee_id, a.active, a.location_name, a.checklist,
            a.gps_lat, a.gps_lng, (a.qr_token IS NOT NULL) AS has_qr,
            u.name, u.department
     FROM assignments a JOIN users u ON u.employee_id = a.employee_id
     WHERE a.task_id = $1 ORDER BY u.name NULLS LAST`,
    [id]
  );
  res.json({ assignments: rows });
});

// 부서(팀) 목록 — 배정 대상 선택용
router.get('/departments', async (req, res) => {
  const { rows } = await query(
    `SELECT department, count(*)::int AS member_count
     FROM users WHERE department IS NOT NULL AND department <> ''
     GROUP BY department ORDER BY department`
  );
  res.json({ departments: rows });
});

// 업무에 담당자 배정. 대상(target)으로 전체/팀/개인을 지정한다.
//   { target: 'all' | 'team' | 'individual', department?, employee_ids?[] }
// (레거시: { employees: [...] } 도 허용)
router.post('/tasks/:id/assignments', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = (await query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  if (!task) return res.status(404).json({ message: '업무 없음' });

  const b = req.body || {};
  // 대상 해석 → 사번 목록
  let empList = [];
  if (b.target === 'all') {
    empList = (await query('SELECT employee_id FROM users')).rows.map((r) => r.employee_id);
  } else if (b.target === 'team') {
    if (!b.department) return res.status(400).json({ message: '팀(부서)을 선택하세요.' });
    empList = (await query('SELECT employee_id FROM users WHERE department = $1', [b.department])).rows.map((r) => r.employee_id);
  } else if (b.target === 'individual') {
    empList = (Array.isArray(b.employee_ids) ? b.employee_ids : []).map((x) => String(x).trim()).filter(Boolean);
  } else if (Array.isArray(b.employees)) {
    // 레거시: 디렉터리에 없는 사번도 즉시 생성
    for (const raw of b.employees) {
      const item = typeof raw === 'string' ? { employee_id: raw } : raw;
      const empId = String(item.employee_id || '').trim();
      if (!empId) continue;
      await query(
        `INSERT INTO users (employee_id, name, department) VALUES ($1,$2,$3)
         ON CONFLICT (employee_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)`,
        [empId, item.name || null, item.department || null]
      );
      empList.push(empId);
    }
  }

  if (!empList.length) return res.status(400).json({ message: '배정할 대상이 없습니다. 먼저 구성원을 등록/선택하세요.' });

  const checklist = JSON.stringify(Array.isArray(task.checklist) ? task.checklist : []);
  const needQr = task.require_qr || checklistHasQr(task.checklist);
  const out = [];
  for (const empId of empList) {
    const qrToken = needQr ? crypto.randomUUID() : null;
    const { rows } = await query(
      `INSERT INTO assignments (task_id, employee_id, assigned_by, checklist, qr_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id, employee_id) DO UPDATE SET
         active = true,
         qr_token = COALESCE(assignments.qr_token, EXCLUDED.qr_token)
       RETURNING id, employee_id`,
      [taskId, empId, req.user.employee_id, checklist, qrToken]
    );
    out.push(rows[0]);
  }
  res.json({ assignments: out, count: out.length });
});

// 배정별 장소/체크리스트/GPS 수정 (구성원마다 다르게 부여)
router.put('/assignments/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const cur = (await query(
    'SELECT a.*, t.require_qr FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.id = $1', [id]
  )).rows[0];
  if (!cur) return res.status(404).json({ message: '배정을 찾을 수 없습니다.' });
  const newChecklist = Array.isArray(b.checklist) ? b.checklist : cur.checklist;
  // require_qr 이거나 QR 입력 항목이 있으면 토큰 발급(기존 토큰 유지)
  const needQr = cur.require_qr || checklistHasQr(newChecklist);
  const qrToken = needQr ? (cur.qr_token || crypto.randomUUID()) : cur.qr_token;
  const { rows } = await query(
    `UPDATE assignments SET location_name = $1, checklist = $2, gps_lat = $3, gps_lng = $4, qr_token = $5
     WHERE id = $6 RETURNING id, location_name, checklist, gps_lat, gps_lng, (qr_token IS NOT NULL) AS has_qr`,
    [
      b.location_name != null ? b.location_name : cur.location_name,
      JSON.stringify(newChecklist),
      b.gps_lat != null ? Number(b.gps_lat) : cur.gps_lat,
      b.gps_lng != null ? Number(b.gps_lng) : cur.gps_lng,
      qrToken, id,
    ]
  );
  res.json({ assignment: rows[0] });
});

// 배정별 QR (현장 구역에 부착) — 구역마다 다른 코드
router.get('/assignments/:id/qr', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = (await query(
    `SELECT a.*, t.title, t.require_qr, u.name FROM assignments a
     JOIN tasks t ON t.id = a.task_id JOIN users u ON u.employee_id = a.employee_id
     WHERE a.id = $1`, [id]
  )).rows[0];
  if (!a) return res.status(404).json({ message: '배정 없음' });
  let token = a.qr_token;
  if (!token) {
    token = crypto.randomUUID();
    await query('UPDATE assignments SET qr_token = $1 WHERE id = $2', [token, id]);
  }
  const payload = `CAMSP:A${id}:${token}`;
  const dataUrl = await QRCode.toDataURL(payload, { width: 480, margin: 2 });
  res.json({
    assignmentId: id, title: a.title, assignee: a.name || a.employee_id,
    location: a.location_name, payload, dataUrl,
  });
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
    const curKey = periodKey(today, t);
    const required = Math.max(1, t.times_per_period || 1);
    const assignees = (await query(
      'SELECT employee_id FROM assignments WHERE task_id = $1 AND active', [t.id]
    )).rows.map((r) => r.employee_id);
    // 담당자별 이번 주기 수행 횟수 — 요구 횟수를 채워야 완료
    const cntByEmp = new Map((await query(
      'SELECT employee_id, count(*) AS n FROM records WHERE task_id = $1 AND period_key = $2 GROUP BY employee_id',
      [t.id, curKey]
    )).rows.map((r) => [r.employee_id, parseInt(r.n, 10)]));
    const total = assignees.length;
    const done = assignees.filter((e) => (cntByEmp.get(e) || 0) >= required).length;
    const { end } = periodRange(today, t);
    const daysLeft = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate()) -
      new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    out.push({
      id: t.id, title: t.title, category: t.category,
      cycle_type: t.cycle_type, cycle_label: cycleLabel(t),
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
  const curKey = req.query.period || periodKey(today, task);
  const prevKey = prevPeriodKey(today, task);

  const assignees = (await query(
    `SELECT a.id AS assignment_id, a.created_at AS assignment_created_at, a.employee_id,
            a.location_name, u.name, u.department
     FROM assignments a JOIN users u ON u.employee_id = a.employee_id
     WHERE a.task_id = $1 AND a.active ORDER BY u.name NULLS LAST`,
    [id]
  )).rows;

  const recs = (await query(
    `SELECT * FROM records WHERE task_id = $1 AND period_key IN ($2, $3) ORDER BY performed_at DESC`,
    [id, curKey, prevKey]
  )).rows;
  const curByEmp = new Map();   // 가장 최근 기록(표시용)
  const curCntByEmp = new Map();
  const prevCntByEmp = new Map();
  for (const r of recs) {
    if (r.period_key === curKey) {
      if (!curByEmp.has(r.employee_id)) curByEmp.set(r.employee_id, r);
      curCntByEmp.set(r.employee_id, (curCntByEmp.get(r.employee_id) || 0) + 1);
    }
    if (r.period_key === prevKey) {
      prevCntByEmp.set(r.employee_id, (prevCntByEmp.get(r.employee_id) || 0) + 1);
    }
  }

  const rows = assignees.map((a) => {
    const rec = curByEmp.get(a.employee_id) || null;
    const since = task.start_date && a.assignment_created_at &&
      new Date(task.start_date) > new Date(a.assignment_created_at)
      ? task.start_date : (a.assignment_created_at || task.start_date);
    const st = computeStatus(today, task,
      curCntByEmp.get(a.employee_id) || 0, prevCntByEmp.get(a.employee_id) || 0, since);
    return {
      employee_id: a.employee_id, name: a.name, department: a.department,
      location_name: a.location_name,
      done: st.status === 'done', done_count: st.doneCount, required: st.required,
      status: st.status, days_left: st.daysLeft,
      record: rec ? {
        id: rec.id, performed_at: rec.performed_at, note: rec.note, issue: rec.status === 'issue',
        photo_url: rec.photo_url, gps_lat: rec.gps_lat, gps_lng: rec.gps_lng,
        qr_verified: rec.qr_verified, checklist_results: rec.checklist_results,
      } : null,
    };
  });

  res.json({
    task: { ...task, cycle_label: cycleLabel(task) },
    period_key: curKey, prev_period_key: prevKey, rows,
  });
});

// 주기 설정 미리보기 — 업무 등록 폼에서 "이번 주기/다음 주기" 확인용
router.get('/cycle-preview', (req, res) => {
  const q = req.query || {};
  const cycleType = CYCLE_TYPES.includes(q.cycle_type) ? q.cycle_type : 'monthly';
  const opts = {
    cycle_type: cycleType,
    cycle_days: parseInt(q.cycle_days, 10) || 30,
    cycle_interval: normCycleInterval(cycleType, q.cycle_interval),
    times_per_period: Math.max(1, parseInt(q.times_per_period, 10) || 1),
    start_date: q.start_date || new Date().toISOString().slice(0, 10),
  };
  const today = new Date();
  const cur = periodRange(today, opts);
  const nextDate = new Date(cur.end.getTime() + 86400000);
  const next = periodRange(nextDate, opts);
  res.json({
    label: cycleLabel(opts),
    required: opts.times_per_period,
    current: { key: periodKey(today, opts), start: ymd(cur.start), end: ymd(cur.end) },
    next: { key: periodKey(nextDate, opts), start: ymd(next.start), end: ymd(next.end) },
  });
});

// 지도용: 특정 업무/주기의 GPS 기록
router.get('/reports/map', async (req, res) => {
  const taskId = parseInt(req.query.taskId, 10);
  const task = (await query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  if (!task) return res.status(404).json({ message: '업무 없음' });
  const today = new Date();
  const key = req.query.period || periodKey(today, task);
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
