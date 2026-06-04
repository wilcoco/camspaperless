import { api, getMe, logout, el, esc, toast, STATUS_LABEL, compressImage, getPosition, fmtDate } from '/js/common.js';

let me = null;
let current = null;        // 현재 모달의 assignment
let photoData = null;      // 압축된 dataURL
let gps = null;            // {lat,lng}
let qrPayload = null;      // 스캔된 QR
let qrScanner = null;

const $ = (id) => document.getElementById(id);

init();

async function init() {
  me = await getMe();
  if (!me) return (location.href = '/');
  $('whoami').textContent = `${me.name || me.employee_id} · ${me.department || ''}`;
  if (me.role === 'admin') $('adminLink').style.display = '';
  $('logoutBtn').onclick = logout;
  bindModal();
  await refresh();
}

async function refresh() {
  const [{ assignments }, { warnings }] = await Promise.all([
    api('/api/me/assignments'),
    api('/api/me/warnings'),
  ]);
  renderWarnings(warnings);
  renderTasks(assignments);
}

function statusBadge(s) {
  return `<span class="badge ${s}">${STATUS_LABEL[s] || s}</span>`;
}

function renderWarnings(warnings) {
  const card = $('warnCard'), box = $('warnList');
  if (!warnings.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  box.innerHTML = '';
  warnings.forEach((w) => {
    const txt = w.status === 'overdue'
      ? '지난 주기 미수행'
      : `마감 ${w.days_left <= 0 ? '오늘' : w.days_left + '일 전'} (~${w.period_end})`;
    const item = el(`<div class="list-item">
      <div><div class="title">${esc(w.title)}</div><div class="meta">${esc(w.location_name || '')} · ${txt}</div></div>
      <div>${statusBadge(w.status)}</div></div>`);
    item.onclick = () => openModal(w);
    box.appendChild(item);
  });
}

function renderTasks(assignments) {
  const box = $('taskList');
  if (!assignments.length) { box.innerHTML = '<div class="empty">배정된 업무가 없습니다.</div>'; return; }
  box.innerHTML = '';
  assignments.forEach((a) => {
    const meta = `${a.cycle_label} · ${esc(a.location_name || '장소 미지정')} · 마감 ~${a.period_end}` +
      (a.done && a.last_record ? ` · 완료 ${fmtDate(a.last_record.performed_at).slice(5, 16)}` : '');
    const item = el(`<div class="list-item">
      <div><div class="title">${esc(a.title)}</div><div class="meta">${meta}</div></div>
      <div class="right-align">${statusBadge(a.status)}</div></div>`);
    item.onclick = () => openModal(a);
    box.appendChild(item);
  });
}

/* ---------- 모달 ---------- */
function bindModal() {
  $('mClose').onclick = closeModal;
  $('modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

  $('photoInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    photoData = await compressImage(file);
    const img = $('photoPreview');
    img.src = photoData; img.style.display = 'block';
  };

  $('gpsBtn').onclick = async () => {
    $('gpsInfo').textContent = '위치 확인 중...';
    try {
      gps = await getPosition();
      $('gpsInfo').innerHTML = `✅ ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} (정확도 ±${Math.round(gps.acc)}m)`;
    } catch (err) {
      $('gpsInfo').textContent = err.message; gps = null;
    }
  };

  $('qrBtn').onclick = toggleScanner;
  $('submitRecord').onclick = submitRecord;
}

function openModal(a) {
  current = a; photoData = null; gps = null; qrPayload = null;
  $('mTitle').textContent = a.title;
  $('mMeta').textContent = `${a.cycle_label} · ${a.location_name || ''} · 마감 ~${a.period_end}`;
  $('noteInput').value = '';
  $('issueChk').checked = false;
  $('photoInput').value = '';
  $('photoPreview').style.display = 'none';
  $('gpsInfo').textContent = '';
  $('qrInfo').textContent = '';
  $('mErr').textContent = '';

  // 사진
  $('photoReq').textContent = a.require_photo ? '(필수)' : '(선택)';
  // GPS
  $('gpsWrap').style.display = (a.require_gps || true) ? '' : 'none'; // GPS는 항상 허용, 필수 여부만 표시
  $('gpsReq').textContent = a.require_gps ? '(필수)' : '(선택)';
  // QR
  $('qrWrap').style.display = a.require_qr ? '' : 'none';

  // 체크리스트
  const cb = $('checklistBox'); cb.innerHTML = '';
  const items = Array.isArray(a.checklist) ? a.checklist : [];
  if (items.length) {
    cb.appendChild(el('<label>체크리스트</label>'));
    items.forEach((it, i) => {
      const id = 'chk_' + i;
      cb.appendChild(el(`<div class="checkrow"><input type="checkbox" id="${id}" data-label="${esc(it.label || it)}"><label for="${id}">${esc(it.label || it)}</label></div>`));
    });
  }

  $('modalBg').classList.add('open');
}

function closeModal() {
  stopScanner();
  $('modalBg').classList.remove('open');
  current = null;
}

async function toggleScanner() {
  if (qrScanner) return stopScanner();
  if (!window.Html5Qrcode) { $('qrInfo').textContent = 'QR 스캐너를 불러오지 못했습니다.'; return; }
  qrScanner = new Html5Qrcode('qrReader');
  $('qrBtn').textContent = '⏹ 스캔 중지';
  try {
    await qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 220 },
      (text) => {
        qrPayload = text;
        const ok = text.startsWith(`CAMSP:${current.task_id}:`);
        $('qrInfo').innerHTML = ok
          ? '✅ 현장 QR 인증됨'
          : '⚠️ 다른 위치의 QR입니다. 해당 구역 QR을 스캔하세요.';
        if (ok) stopScanner();
      },
      () => {}
    );
  } catch (err) {
    $('qrInfo').textContent = '카메라를 열 수 없습니다: ' + err;
    qrScanner = null; $('qrBtn').textContent = '📷 QR 스캔 시작';
  }
}

async function stopScanner() {
  if (qrScanner) {
    try { await qrScanner.stop(); qrScanner.clear(); } catch {}
    qrScanner = null;
  }
  $('qrBtn').textContent = '📷 QR 스캔 시작';
}

async function submitRecord() {
  const a = current;
  const err = $('mErr'); err.textContent = '';
  if (a.require_photo && !photoData) { err.textContent = '사진을 첨부하세요.'; return; }
  if (a.require_gps && !gps) { err.textContent = '현재 위치를 가져오세요.'; return; }
  if (a.require_qr && !qrPayload) { err.textContent = '현장 QR을 스캔하세요.'; return; }

  const checklist_results = [...document.querySelectorAll('#checklistBox input[type=checkbox]')]
    .map((c) => ({ label: c.dataset.label, checked: c.checked }));

  const btn = $('submitRecord');
  btn.disabled = true; btn.textContent = '제출 중...';
  try {
    await api('/api/me/records', {
      method: 'POST',
      body: {
        assignment_id: a.assignment_id,
        note: $('noteInput').value.trim(),
        issue: $('issueChk').checked,
        photo: photoData,
        gps_lat: gps?.lat, gps_lng: gps?.lng,
        qr_payload: qrPayload,
        checklist_results,
      },
    });
    toast('수행 기록이 제출되었습니다.');
    closeModal();
    await refresh();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false; btn.textContent = '제출하기';
  }
}
