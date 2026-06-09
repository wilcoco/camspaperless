// 공통 유틸
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const msg = (data && data.message) || `요청 실패 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function getMe() {
  try {
    const { user } = await api('/api/auth/me');
    return user;
  } catch {
    return null;
  }
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.href = '/';
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('<div class="toast"></div>'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

export const STATUS_LABEL = {
  done: '완료', pending: '대기', due_soon: '마감임박', overdue: '미수행',
};

// 체크리스트 항목 입력 타입
export const ITEM_TYPES = ['check', 'text', 'photo', 'gps', 'qr'];
export const ITEM_TYPE_LABEL = { check: '체크', text: '텍스트', photo: '사진', gps: '위치', qr: 'QR' };
const ITEM_TYPE_ALIASES = {
  '체크': 'check', 'check': 'check', '확인': 'check',
  '텍스트': 'text', 'text': 'text', '글자': 'text', '메모': 'text',
  '사진': 'photo', 'photo': 'photo', 'img': 'photo', 'image': 'photo',
  '위치': 'gps', 'gps': 'gps', '좌표': 'gps',
  'qr': 'qr', 'QR': 'qr',
};
export function normalizeItemType(s) {
  if (!s) return 'check';
  return ITEM_TYPE_ALIASES[String(s).trim().toLowerCase()] || ITEM_TYPE_ALIASES[String(s).trim()] || 'check';
}
// textarea 한 줄 -> {label, type}.  "라벨 | 타입"
export function parseChecklistLine(line) {
  const parts = line.split('|');
  const label = parts[0].trim();
  const type = parts.length > 1 ? normalizeItemType(parts[1]) : 'check';
  return { label, type };
}
// {label,type} -> textarea 한 줄
export function checklistItemToLine(it) {
  const label = it.label || it;
  const type = normalizeItemType(it.type);
  return type === 'check' ? label : `${label} | ${ITEM_TYPE_LABEL[type]}`;
}

// 카메라 입력 이미지를 캔버스로 리사이즈/압축 → dataURL(jpeg)
export function compressImage(file, maxSize = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > height && width > maxSize) { height = Math.round(height * maxSize / width); width = maxSize; }
      else if (height > maxSize) { width = Math.round(width * maxSize / height); height = maxSize; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// 현재 위치
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS를 지원하지 않는 기기입니다.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error('위치 권한이 필요합니다: ' + e.message)),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

export function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
