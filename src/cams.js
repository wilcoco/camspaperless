// CAMS ERP 로그인 API 연동
const LOGIN_URL = process.env.CAMS_LOGIN_URL || 'https://selfservice.icams.co.kr/api/erp/login';

/**
 * CAMS ERP 로그인.
 * @returns {Promise<{ok:boolean, status:number, employee?:object, message?:string}>}
 */
export async function camsLogin(employeeId, password) {
  const apiKey = process.env.CAMS_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, message: '서버에 CAMS_API_KEY가 설정되지 않았습니다.' };
  }

  let res;
  try {
    res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ employeeId, password }),
    });
  } catch (err) {
    console.error('[cams] 네트워크 오류:', err.message);
    return { ok: false, status: 502, message: '인증 서버에 연결할 수 없습니다.' };
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    /* ignore parse error */
  }

  if (res.ok && body && body.authenticated) {
    return { ok: true, status: 200, employee: body.employee || {} };
  }

  return {
    ok: false,
    status: res.status || 401,
    message: (body && body.message) || '사번 또는 비밀번호가 올바르지 않습니다.',
  };
}
