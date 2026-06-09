import { Router } from 'express';
import { camsConfigSummary } from '../cams.js';
import { query } from '../db.js';

const router = Router();

// 토큰으로 보호되는 설정 진단. ?token=<JWT_SECRET> 필요.
// 로그인 자체가 CAMS에 의존하므로(관리자도 로그인 불가 상황) 별도 토큰으로 접근한다.
router.get('/', async (req, res) => {
  const gate = process.env.DIAG_TOKEN || process.env.JWT_SECRET;
  if (!gate || req.query.token !== gate) {
    return res.status(403).json({ message: '접근 거부: ?token=<JWT_SECRET> 가 필요합니다.' });
  }

  const cams = camsConfigSummary();

  let dbConnected = false;
  let dbError = null;
  try {
    await query('SELECT 1');
    dbConnected = true;
  } catch (e) {
    dbError = e.message;
  }

  res.json({
    cams: {
      loginUrl: cams.url,
      keySet: cams.keySet,
      keyLength: cams.keyLen,
      keyTail: cams.keyTail,        // 끝 4자만 (발급키와 대조용)
      trimmedFromRaw: cams.trimmed, // 따옴표/공백이 제거됐는지
    },
    db: {
      configured: !!process.env.DATABASE_URL,
      connected: dbConnected,
      error: dbError,
    },
    adminEmployeeIds: (process.env.ADMIN_EMPLOYEE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    time: new Date().toISOString(),
  });
});

export default router;
