import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { saveImage } from '../storage.js';
import { periodKey, prevPeriodKey, computeStatus, CYCLE_LABELS } from '../periodicity.js';

const router = Router();
router.use(requireAuth);

// 두 날짜 중 더 늦은(이후) 날짜 반환
function maxDate(a, b) {
  const da = a ? new Date(a) : null;
  const db = b ? new Date(b) : null;
  if (!da) return db;
  if (!db) return da;
  return da > db ? da : db;
}

// 내가 담당한 업무 + 현재 주기 상태
async function loadMyAssignments(employeeId) {
  const today = new Date();
  const rows = (await query(
    `SELECT a.id AS assignment_id, a.created_at AS assignment_created_at,
            a.location_name AS asg_location, a.checklist AS asg_checklist,
            a.gps_lat AS asg_gps_lat, a.gps_lng AS asg_gps_lng,
            (a.qr_token IS NOT NULL) AS asg_has_qr,
            t.*
     FROM assignments a JOIN tasks t ON t.id = a.task_id
     WHERE a.employee_id = $1 AND a.active AND t.active
     ORDER BY t.title`,
    [employeeId]
  )).rows;

  const out = [];
  for (const t of rows) {
    const curKey = periodKey(today, t.cycle_type, t.cycle_days, t.start_date);
    const prevKey = prevPeriodKey(today, t.cycle_type, t.cycle_days, t.start_date);
    const recs = (await query(
      `SELECT * FROM records WHERE assignment_id = $1 AND period_key IN ($2, $3)
       ORDER BY performed_at DESC`,
      [t.assignment_id, curKey, prevKey]
    )).rows;
    const cur = recs.find((r) => r.period_key === curKey) || null;
    const donePrev = recs.some((r) => r.period_key === prevKey);
    const since = maxDate(t.start_date, t.assignment_created_at);
    const st = computeStatus(today, t, !!cur, donePrev, since);
    out.push({
      assignment_id: t.assignment_id,
      task_id: t.id,
      title: t.title,
      description: t.description,
      category: t.category,
      // 장소/체크리스트/GPS 는 배정(구성원)별 값을 우선, 없으면 업무 기본값
      location_name: t.asg_location != null ? t.asg_location : t.location_name,
      cycle_type: t.cycle_type,
      cycle_label: CYCLE_LABELS[t.cycle_type] || t.cycle_type,
      require_photo: t.require_photo,
      require_gps: t.require_gps,
      require_qr: t.require_qr,
      checklist: (Array.isArray(t.asg_checklist) && t.asg_checklist.length) ? t.asg_checklist : t.checklist,
      gps_lat: t.asg_gps_lat != null ? t.asg_gps_lat : t.gps_lat,
      gps_lng: t.asg_gps_lng != null ? t.asg_gps_lng : t.gps_lng,
      period_key: curKey,
      status: st.status,
      days_left: st.daysLeft,
      period_end: st.periodEnd,
      done: !!cur,
      last_record: cur ? { performed_at: cur.performed_at, note: cur.note, issue: cur.status === 'issue' } : null,
    });
  }
  return out;
}

router.get('/assignments', async (req, res) => {
  res.json({ assignments: await loadMyAssignments(req.user.employee_id) });
});

// 다가오는/누락 워닝
router.get('/warnings', async (req, res) => {
  const all = await loadMyAssignments(req.user.employee_id);
  const warnings = all
    .filter((a) => a.status === 'due_soon' || a.status === 'overdue')
    .sort((a, b) => (a.status === b.status ? a.days_left - b.days_left : a.status === 'overdue' ? -1 : 1));
  res.json({ warnings });
});

// 수행 기록 제출
router.post('/records', async (req, res) => {
  const b = req.body || {};
  const assignmentId = parseInt(b.assignment_id, 10);
  if (!assignmentId) return res.status(400).json({ message: '배정 정보가 없습니다.' });

  const assignment = (await query(
    `SELECT t.require_photo, t.require_gps, t.require_qr,
            t.cycle_type, t.cycle_days, t.start_date,
            a.employee_id, a.qr_token AS asg_qr_token,
            a.id AS assignment_id, t.id AS task_id
     FROM assignments a JOIN tasks t ON t.id = a.task_id
     WHERE a.id = $1`,
    [assignmentId]
  )).rows[0];
  if (!assignment) return res.status(404).json({ message: '배정을 찾을 수 없습니다.' });
  if (assignment.employee_id !== req.user.employee_id) {
    return res.status(403).json({ message: '본인에게 배정된 업무가 아닙니다.' });
  }

  // 필수값 검증
  if (assignment.require_photo && !b.photo) {
    return res.status(400).json({ message: '사진 첨부가 필요합니다.' });
  }

  // QR 검증 (배정별 토큰 — 해당 구역의 QR)
  let qrVerified = false;
  if (assignment.require_qr) {
    const payload = String(b.qr_payload || '');
    const expected = `CAMSP:A${assignment.assignment_id}:${assignment.asg_qr_token}`;
    if (!assignment.asg_qr_token || payload !== expected) {
      return res.status(400).json({ message: '현장 QR 코드 인증에 실패했습니다. 해당 위치의 QR을 스캔하세요.' });
    }
    qrVerified = true;
  }

  let gpsLat = null, gpsLng = null;
  if (b.gps_lat != null && b.gps_lng != null) {
    gpsLat = Number(b.gps_lat);
    gpsLng = Number(b.gps_lng);
  }
  if (assignment.require_gps && (gpsLat == null || gpsLng == null)) {
    return res.status(400).json({ message: '위치(GPS) 정보가 필요합니다.' });
  }

  let photoUrl = null;
  if (b.photo) {
    try {
      photoUrl = await saveImage(b.photo);
    } catch (err) {
      console.error('[records] 이미지 저장 실패:', err.message);
      return res.status(500).json({ message: '사진 저장에 실패했습니다.' });
    }
  }

  // 체크리스트 항목별 입력 처리 (타입: check/text/photo/gps/qr)
  const expectedQr = `CAMSP:A${assignment.assignment_id}:${assignment.asg_qr_token}`;
  const items = Array.isArray(b.checklist_results) ? b.checklist_results : [];
  const processedItems = [];
  for (const it of items) {
    const out = { label: it.label, type: it.type || 'check' };
    switch (out.type) {
      case 'text':
        out.text = it.text != null ? String(it.text) : '';
        break;
      case 'photo':
        if (it.photo) {
          try { out.photo_url = await saveImage(it.photo); }
          catch (err) { console.error('[records] 항목 사진 저장 실패:', err.message); }
        }
        break;
      case 'gps':
        if (it.gps_lat != null && it.gps_lng != null) {
          out.gps_lat = Number(it.gps_lat);
          out.gps_lng = Number(it.gps_lng);
        }
        break;
      case 'qr':
        out.qr_verified = !!assignment.asg_qr_token && String(it.qr_payload || '') === expectedQr;
        break;
      default:
        out.checked = !!it.checked;
    }
    processedItems.push(out);
  }

  const today = new Date();
  const curKey = periodKey(today, assignment.cycle_type, assignment.cycle_days, assignment.start_date);

  const { rows } = await query(
    `INSERT INTO records
      (assignment_id, task_id, employee_id, period_key, note, status, photo_url,
       gps_lat, gps_lng, qr_verified, checklist_results)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      assignmentId, assignment.task_id, req.user.employee_id, curKey,
      b.note || null, b.issue ? 'issue' : 'ok', photoUrl,
      gpsLat, gpsLng, qrVerified,
      JSON.stringify(processedItems),
    ]
  );
  res.json({ record: rows[0] });
});

// 내 과거 수행 이력
router.get('/records', async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, t.title FROM records r JOIN tasks t ON t.id = r.task_id
     WHERE r.employee_id = $1 ORDER BY r.performed_at DESC LIMIT 100`,
    [req.user.employee_id]
  );
  res.json({ records: rows });
});

export default router;
