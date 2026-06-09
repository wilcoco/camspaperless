// CAMS ERP 로그인 API 연동
const LOGIN_URL = process.env.CAMS_LOGIN_URL || 'https://selfservice.icams.co.kr/api/erp/login';

/**
 * CAMS ERP 로그인.
 * @returns {Promise<{ok:boolean, status:number, employee?:object, message?:string}>}
 */
// 설정 요약 (키 값은 길이·끝4자만). 진단용.
export function camsConfigSummary() {
  const raw = process.env.CAMS_API_KEY || '';
  const key = cleanApiKey(raw);
  return {
    url: LOGIN_URL,
    keySet: !!key,
    keyLen: key.length,
    keyTail: key ? key.slice(-4) : null,
    trimmed: !!key && raw !== key,
  };
}

// 시작 시 CAMS 설정 상태를 로그로 남긴다 (키 값은 길이·끝4자만 노출).
export function logCamsConfig() {
  const key = cleanApiKey(process.env.CAMS_API_KEY);
  const raw = process.env.CAMS_API_KEY || '';
  console.log(`[cams] 로그인 URL: ${LOGIN_URL}`);
  if (!key) {
    console.warn('[cams] 경고: CAMS_API_KEY 가 비어 있습니다. Railway Variables를 확인하세요.');
    return;
  }
  const trimmedNote = raw !== key ? ' (앞뒤 따옴표/공백 제거됨)' : '';
  console.log(`[cams] CAMS_API_KEY 인식됨: 길이 ${key.length}자, 끝4자 ...${key.slice(-4)}${trimmedNote}`);
}

// 환경변수에 따옴표/공백/줄바꿈이 섞여 들어간 경우를 보정한다 (가장 흔한 설정 실수).
function cleanApiKey(raw) {
  if (!raw) return '';
  let k = raw.trim();
  // 앞뒤를 감싼 따옴표 제거 ("abc" 또는 'abc')
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  return k;
}

export async function camsLogin(employeeId, password) {
  const apiKey = cleanApiKey(process.env.CAMS_API_KEY);
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
  let rawText = '';
  try {
    rawText = await res.text();
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    /* JSON 아님 — rawText 유지 */
  }

  if (res.ok && body && body.authenticated) {
    return { ok: true, status: 200, employee: body.employee || {} };
  }

  const upstreamMsg = (body && body.message) || rawText || '';
  // API Key 자체가 거부된 경우(키 설정 문제) — 사용자에게는 관리자 문의 안내, 로그에 진단정보.
  if (/api[\s_-]?key/i.test(upstreamMsg) || res.status === 403) {
    console.error(
      `[cams] API Key 거부됨 (status ${res.status}). 보낸 키 길이=${apiKey.length}자, ` +
      `끝4자=...${apiKey.slice(-4)}. CAMS_API_KEY 값(따옴표/공백/오타)을 확인하세요. 응답: ${upstreamMsg}`
    );
    return {
      ok: false,
      status: 500,
      message: '서버 인증 키(CAMS_API_KEY) 설정 오류입니다. 관리자에게 문의하세요.',
    };
  }

  return {
    ok: false,
    status: res.status || 401,
    message: upstreamMsg || '사번 또는 비밀번호가 올바르지 않습니다.',
  };
}
