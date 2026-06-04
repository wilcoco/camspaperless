import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'cams_session';
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const MAX_AGE_MS = 1000 * 60 * 60 * 12; // 12시간

export function signSession(user) {
  return jwt.sign(
    { sub: user.employee_id, name: user.name, role: user.role, department: user.department },
    SECRET,
    { expiresIn: '12h' }
  );
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// 로그인 사용자를 req.user에 채운다 (비로그인 허용).
export function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, SECRET);
      req.user = {
        employee_id: payload.sub,
        name: payload.name,
        role: payload.role,
        department: payload.department,
      };
    } catch {
      /* 만료/위조 토큰 무시 */
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  if (req.user.role !== 'admin') return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  next();
}
