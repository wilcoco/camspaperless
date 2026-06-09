import { api, getMe, logout, el, esc, toast, STATUS_LABEL, compressImage, getPosition, fmtDate,
  ITEM_TYPE_LABEL, normalizeItemType } from '/js/common.js';

let me = null;
let current = null;        // 현재 모달의 assignment
let photoData = null;      // 압축된 dataURL (전체 증빙 사진)
let gps = null;            // {lat,lng} (전체 증빙 위치)
let qrPayload = null;      // 스캔된 QR (전체 증빙)
let itemState = [];        // 체크리스트 항목별 입력 상태
let activeScanner = null;  // html5-qrcode 인스턴스
let activeScannerTarget = null; // 'top' | 항목 index

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

  // 체크리스트 (항목별 입력 타입)
  renderChecklist(a);

  $('modalBg').classList.add('open');
}

// 항목 타입별 입력 UI 렌더
function renderChecklist(a) {
  const cb = $('checklistBox'); cb.innerHTML = '';
  const items = (Array.isArray(a.checklist) ? a.checklist : []).map((it) => ({
    label: it.label || it, type: normalizeItemType(it.type),
  }));
  itemState = items.map((it) => ({ ...it }));
  if (!items.length) return;

  cb.appendChild(el('<label>체크리스트</label>'));
  items.forEach((it, i) => {
    const row = el('<div class="card" style="padding:12px;margin-bottom:8px;box-shadow:none"></div>');
    row.appendChild(el(`<div style="font-weight:600;margin-bottom:6px">${esc(it.label)} <span class="chip">${ITEM_TYPE_LABEL[it.type]}</span></div>`));

    if (it.type === 'check') {
      const c = el(`<div class="checkrow"><input type="checkbox" id="ci_${i}"><label for="ci_${i}">완료</label></div>`);
      c.querySelector('input').onchange = (e) => { itemState[i].checked = e.target.checked; };
      row.appendChild(c);
    } else if (it.type === 'text') {
      const inp = el('<input type="text" placeholder="입력하세요" />');
      inp.oninput = (e) => { itemState[i].text = e.target.value; };
      row.appendChild(inp);
    } else if (it.type === 'photo') {
      const inp = el('<input type="file" accept="image/*" capture="environment" />');
      const prev = el('<img class="photo-preview" />');
      inp.onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        itemState[i].photo = await compressImage(f);
        prev.src = itemState[i].photo; prev.style.display = 'block';
      };
      row.appendChild(inp); row.appendChild(prev);
    } else if (it.type === 'gps') {
      const btn = el('<button class="btn secondary" type="button">📍 위치 가져오기</button>');
      const info = el('<div class="small muted" style="margin-top:6px"></div>');
      btn.onclick = async () => {
        info.textContent = '위치 확인 중...';
        try { const p = await getPosition(); itemState[i].gps_lat = p.lat; itemState[i].gps_lng = p.lng; info.innerHTML = `✅ ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`; }
        catch (err) { info.textContent = err.message; }
      };
      row.appendChild(btn); row.appendChild(info);
    } else if (it.type === 'qr') {
      const btn = el('<button class="btn secondary" type="button">📷 QR 스캔</button>');
      const reader = el(`<div id="ireader_${i}" class="scanner-box"></div>`);
      const info = el('<div class="small" style="margin-top:6px"></div>');
      btn.onclick = () => scanInto(i, `ireader_${i}`, btn, info);
      row.appendChild(btn); row.appendChild(reader); row.appendChild(info);
    }
    cb.appendChild(row);
  });
}

function closeModal() {
  stopScan();
  $('modalBg').classList.remove('open');
  current = null;
}

// 최상위(전체 증빙) QR 스캔
function toggleScanner() {
  scanInto('top', 'qrReader', $('qrBtn'), $('qrInfo'));
}

// 공용 스캐너: target='top' 이면 전체 QR, 숫자면 체크리스트 항목 index.
async function scanInto(target, containerId, btn, info) {
  // 이미 같은 대상 스캔 중이면 중지
  if (activeScanner && activeScannerTarget === target) { return stopScan(btn); }
  await stopScan(); // 다른 스캐너 정리
  if (!window.Html5Qrcode) { info.textContent = 'QR 스캐너를 불러오지 못했습니다.'; return; }
  activeScanner = new Html5Qrcode(containerId);
  activeScannerTarget = target;
  if (btn) btn.textContent = '⏹ 스캔 중지';
  const expectedPrefix = `CAMSP:A${current.assignment_id}:`;
  try {
    await activeScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 220 },
      (text) => {
        const ok = text.startsWith(expectedPrefix);
        if (target === 'top') {
          qrPayload = text;
        } else {
          itemState[target].qr_payload = text;
        }
        info.innerHTML = ok ? '✅ 현장 QR 인증됨' : '⚠️ 다른 위치의 QR입니다. 해당 구역 QR을 스캔하세요.';
        if (ok) stopScan(btn);
      },
      () => {}
    );
  } catch (err) {
    info.textContent = '카메라를 열 수 없습니다: ' + err;
    activeScanner = null; activeScannerTarget = null;
    if (btn) btn.textContent = '📷 QR 스캔';
  }
}

async function stopScan(btn) {
  if (activeScanner) {
    try { await activeScanner.stop(); activeScanner.clear(); } catch {}
    activeScanner = null; activeScannerTarget = null;
  }
  if (btn) btn.textContent = '📷 QR 스캔';
  $('qrBtn').textContent = '📷 QR 스캔 시작';
}

async function submitRecord() {
  const a = current;
  const err = $('mErr'); err.textContent = '';
  if (a.require_photo && !photoData) { err.textContent = '사진을 첨부하세요.'; return; }
  if (a.require_gps && !gps) { err.textContent = '현재 위치를 가져오세요.'; return; }
  if (a.require_qr && !qrPayload) { err.textContent = '현장 QR을 스캔하세요.'; return; }

  // 체크리스트 항목별 입력 수집 + 필수 검증
  const checklist_results = itemState.map((it) => {
    const r = { label: it.label, type: it.type };
    if (it.type === 'check') r.checked = !!it.checked;
    else if (it.type === 'text') r.text = it.text || '';
    else if (it.type === 'photo') r.photo = it.photo || null;
    else if (it.type === 'gps') { r.gps_lat = it.gps_lat; r.gps_lng = it.gps_lng; }
    else if (it.type === 'qr') r.qr_payload = it.qr_payload || '';
    return r;
  });
  for (const it of itemState) {
    if (it.type === 'photo' && !it.photo) { err.textContent = `'${it.label}' 항목 사진을 첨부하세요.`; return; }
    if (it.type === 'gps' && it.gps_lat == null) { err.textContent = `'${it.label}' 항목 위치를 가져오세요.`; return; }
    if (it.type === 'qr' && !(it.qr_payload && it.qr_payload.startsWith(`CAMSP:A${a.assignment_id}:`))) {
      err.textContent = `'${it.label}' 항목 QR을 스캔하세요.`; return;
    }
  }

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
