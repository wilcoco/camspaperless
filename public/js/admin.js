import { api, getMe, logout, el, esc, toast, STATUS_LABEL, fmtDate } from '/js/common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let tasksCache = [];
let map = null, mapLayer = null;

init();

async function init() {
  me = await getMe();
  if (!me) return (location.href = '/');
  if (me.role !== 'admin') return (location.href = '/app.html');
  $('whoami').textContent = `${me.name || me.employee_id} · 관리자`;
  $('logoutBtn').onclick = logout;
  setupTabs();
  bindTaskForm();
  bindAssign();
  bindReport();
  bindMap();
  bindQrModal();
  await loadOverview();
}

function setupTabs() {
  const btns = document.querySelectorAll('.tabs button');
  btns.forEach((b) => b.onclick = () => {
    btns.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('[data-panel]').forEach((p) => p.hidden = p.dataset.panel !== b.dataset.tab);
    const tab = b.dataset.tab;
    if (tab === 'overview') loadOverview();
    if (tab === 'tasks') loadTasks();
    if (tab === 'assign') loadTaskSelectors();
    if (tab === 'report') loadTaskSelectors();
    if (tab === 'map') { loadTaskSelectors(); setTimeout(() => map && map.invalidateSize(), 100); }
  });
}

/* ---------- 현황 ---------- */
async function loadOverview() {
  const box = $('overviewBox');
  const { tasks, today } = await api('/api/admin/reports/overview');
  if (!tasks.length) { box.innerHTML = '<div class="empty">활성 업무가 없습니다. 업무관리에서 등록하세요.</div>'; return; }
  box.innerHTML = `<div class="small muted" style="margin-bottom:10px">기준일 ${today}</div>`;
  tasks.forEach((t) => {
    const warn = t.days_left <= 0 ? '<span class="badge overdue">마감초과</span>'
      : t.days_left <= 3 ? `<span class="badge due_soon">D-${t.days_left}</span>` : '';
    const item = el(`<div class="list-item" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><div class="title">${esc(t.title)} ${warn}</div>
          <div class="meta">${esc(t.cycle_label)} · ${esc(t.location_name || '')} · 주기 ${esc(t.period_key)} · 마감 ${t.period_end}</div></div>
        <div class="right-align"><b>${t.done}/${t.total}</b><div class="small muted">${t.rate}%</div></div>
      </div>
      <div class="progress" style="margin-top:8px"><i style="width:${t.rate}%;background:${t.rate >= 100 ? 'var(--ok)' : t.days_left <= 3 ? 'var(--warn)' : 'var(--primary)'}"></i></div>
    </div>`);
    item.style.cursor = 'pointer';
    item.onclick = () => { document.querySelector('[data-tab=report]').click(); $('reportTaskSel').value = t.id; loadReport(); };
    box.appendChild(item);
  });
}

/* ---------- 업무관리 ---------- */
function bindTaskForm() {
  $('f_cycle').onchange = (e) => { $('cycleDaysWrap').style.display = e.target.value === 'custom' ? '' : 'none'; };
  $('taskResetBtn').onclick = resetTaskForm;
  $('taskForm').onsubmit = saveTask;
}

function resetTaskForm() {
  $('taskId').value = '';
  $('taskForm').reset();
  $('f_photo').checked = true;
  $('cycleDaysWrap').style.display = 'none';
  $('taskFormTitle').textContent = '새 업무 등록';
  $('taskErr').textContent = '';
}

async function saveTask(e) {
  e.preventDefault();
  $('taskErr').textContent = '';
  const id = $('taskId').value;
  const checklist = $('f_checklist').value.split('\n').map((s) => s.trim()).filter(Boolean).map((label) => ({ label }));
  const body = {
    title: $('f_title').value.trim(),
    category: $('f_category').value.trim(),
    location_name: $('f_location').value.trim(),
    description: $('f_description').value.trim(),
    cycle_type: $('f_cycle').value,
    cycle_days: parseInt($('f_cycle_days').value, 10) || 30,
    warn_before_days: parseInt($('f_warn').value, 10) || 3,
    require_photo: $('f_photo').checked,
    require_gps: $('f_gps').checked,
    require_qr: $('f_qr').checked,
    checklist,
  };
  try {
    if (id) await api('/api/admin/tasks/' + id, { method: 'PUT', body });
    else await api('/api/admin/tasks', { method: 'POST', body });
    toast('저장되었습니다.');
    resetTaskForm();
    await loadTasks();
  } catch (e2) { $('taskErr').textContent = e2.message; }
}

async function loadTasks() {
  const box = $('taskMgmtList');
  const { tasks } = await api('/api/admin/tasks');
  tasksCache = tasks;
  if (!tasks.length) { box.innerHTML = '<div class="empty">등록된 업무가 없습니다.</div>'; return; }
  box.innerHTML = '';
  tasks.forEach((t) => {
    const flags = [t.require_photo && '📷', t.require_gps && '📍', t.require_qr && '🔳'].filter(Boolean).join(' ');
    const item = el(`<div class="list-item">
      <div><div class="title">${esc(t.title)} ${t.active ? '' : '<span class="badge pending">비활성</span>'}</div>
        <div class="meta">${esc(t.cycle_label)} · ${esc(t.location_name || '')} · 담당 ${t.assignee_count}명 ${flags}</div></div>
      <div class="right-align" style="white-space:nowrap"></div></div>`);
    const actions = item.querySelector('.right-align');
    const edit = el('<button class="btn small secondary">수정</button>');
    edit.onclick = () => fillTaskForm(t);
    actions.appendChild(edit);
    if (t.require_qr) {
      const qr = el('<button class="btn small secondary" style="margin-left:4px">QR</button>');
      qr.onclick = () => showQr(t.id);
      actions.appendChild(qr);
    }
    const del = el('<button class="btn small danger" style="margin-left:4px">삭제</button>');
    del.onclick = async () => { if (confirm(`"${t.title}" 업무를 삭제할까요? 관련 기록도 삭제됩니다.`)) { await api('/api/admin/tasks/' + t.id, { method: 'DELETE' }); toast('삭제됨'); loadTasks(); } };
    actions.appendChild(del);
    box.appendChild(item);
  });
}

function fillTaskForm(t) {
  $('taskId').value = t.id;
  $('f_title').value = t.title || '';
  $('f_category').value = t.category || '';
  $('f_location').value = t.location_name || '';
  $('f_description').value = t.description || '';
  $('f_cycle').value = t.cycle_type;
  $('cycleDaysWrap').style.display = t.cycle_type === 'custom' ? '' : 'none';
  $('f_cycle_days').value = t.cycle_days || 30;
  $('f_warn').value = t.warn_before_days;
  $('f_photo').checked = t.require_photo;
  $('f_gps').checked = t.require_gps;
  $('f_qr').checked = t.require_qr;
  $('f_checklist').value = (Array.isArray(t.checklist) ? t.checklist : []).map((c) => c.label || c).join('\n');
  $('taskFormTitle').textContent = '업무 수정 (#' + t.id + ')';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- QR 모달 ---------- */
function bindQrModal() {
  $('qrModalClose').onclick = () => $('qrModalBg').classList.remove('open');
  $('qrModalBg').addEventListener('click', (e) => { if (e.target.id === 'qrModalBg') $('qrModalBg').classList.remove('open'); });
}
async function showQr(taskId) {
  const data = await api('/api/admin/tasks/' + taskId + '/qr');
  $('qrModalBody').innerHTML = `
    <p class="muted small">${esc(data.title)}${data.location ? ' · ' + esc(data.location) : ''}</p>
    <img src="${data.dataUrl}" style="width:240px;max-width:100%" />
    <p class="small muted">이 QR을 인쇄해 현장에 부착하세요. 담당자가 스캔하면 해당 위치 수행이 증빙됩니다.</p>
    <button class="btn secondary" onclick="window.print()">인쇄</button>`;
  $('qrModalBg').classList.add('open');
}

/* ---------- 셀렉터 공통 ---------- */
async function loadTaskSelectors() {
  if (!tasksCache.length) { const { tasks } = await api('/api/admin/tasks'); tasksCache = tasks; }
  const opts = tasksCache.map((t) => `<option value="${t.id}">${esc(t.title)}${t.active ? '' : ' (비활성)'}</option>`).join('');
  ['assignTaskSel', 'reportTaskSel', 'mapTaskSel'].forEach((id) => {
    const sel = $(id); if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = opts || '<option value="">업무 없음</option>';
    if (prev) sel.value = prev;
  });
}

/* ---------- 배정 ---------- */
function bindAssign() {
  $('assignTaskSel').onchange = loadAssignments;
  $('assignAddBtn').onclick = addAssignments;
}
async function addAssignments() {
  $('assignErr').textContent = '';
  const taskId = $('assignTaskSel').value;
  if (!taskId) { $('assignErr').textContent = '업무를 선택하세요.'; return; }
  const employees = $('assignInput').value.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [employee_id, name] = line.split(',').map((s) => s.trim());
    return { employee_id, name: name || null };
  });
  if (!employees.length) { $('assignErr').textContent = '사번을 입력하세요.'; return; }
  try {
    await api('/api/admin/tasks/' + taskId + '/assignments', { method: 'POST', body: { employees } });
    $('assignInput').value = '';
    toast('배정되었습니다.');
    await loadAssignments();
    tasksCache = []; // 담당자 수 갱신
  } catch (e) { $('assignErr').textContent = e.message; }
}
async function loadAssignments() {
  const box = $('assignList');
  const taskId = $('assignTaskSel').value;
  if (!taskId) { box.innerHTML = '<div class="empty">업무를 선택하세요.</div>'; return; }
  const { assignments } = await api('/api/admin/tasks/' + taskId + '/assignments');
  if (!assignments.length) { box.innerHTML = '<div class="empty">배정된 담당자가 없습니다.</div>'; return; }
  box.innerHTML = '';
  assignments.forEach((a) => {
    const item = el(`<div class="list-item">
      <div><div class="title">${esc(a.name || a.employee_id)}</div><div class="meta">${esc(a.employee_id)} · ${esc(a.department || '')}</div></div>
      <div></div></div>`);
    const del = el('<button class="btn small danger">해제</button>');
    del.onclick = async () => { await api('/api/admin/assignments/' + a.id, { method: 'DELETE' }); toast('해제됨'); loadAssignments(); tasksCache = []; };
    item.lastElementChild.appendChild(del);
    box.appendChild(item);
  });
}

/* ---------- 리포트 ---------- */
function bindReport() { $('reportTaskSel').onchange = loadReport; }
async function loadReport() {
  const box = $('reportBox');
  const taskId = $('reportTaskSel').value;
  if (!taskId) { box.innerHTML = '<div class="empty">업무를 선택하세요.</div>'; return; }
  const { task, period_key, rows } = await api('/api/admin/reports/task/' + taskId);
  const done = rows.filter((r) => r.done).length;
  const issues = rows.filter((r) => r.record && r.record.issue).length;
  box.innerHTML = `
    <div class="grid-stats" style="margin-bottom:14px">
      <div class="stat"><b>${rows.length}</b><span>담당자</span></div>
      <div class="stat"><b style="color:var(--ok)">${done}</b><span>완료</span></div>
      <div class="stat"><b style="color:var(--danger)">${rows.length - done}</b><span>미수행</span></div>
      <div class="stat"><b style="color:var(--warn)">${issues}</b><span>특이사항</span></div>
    </div>
    <div class="small muted" style="margin-bottom:8px">${esc(task.cycle_label)} · 주기 ${esc(period_key)}</div>`;
  rows.forEach((r) => {
    const rec = r.record;
    const sub = rec
      ? `${fmtDate(rec.performed_at)}${rec.qr_verified ? ' · 🔳QR' : ''}${rec.gps_lat ? ' · 📍GPS' : ''}${rec.note ? ' · ' + esc(rec.note) : ''}`
      : '미수행';
    const item = el(`<div class="list-item">
      <div><div class="title">${esc(r.name || r.employee_id)} ${rec && rec.issue ? '<span class="badge issue">특이</span>' : ''}</div>
        <div class="meta">${esc(r.employee_id)} · ${sub}</div></div>
      <div class="right-align"><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></div></div>`);
    if (rec && rec.photo_url) {
      item.style.cursor = 'pointer';
      item.onclick = () => window.open(rec.photo_url, '_blank');
    }
    box.appendChild(item);
  });
}

/* ---------- 지도 ---------- */
function bindMap() { $('mapTaskSel').onchange = loadMap; }
async function loadMap() {
  const taskId = $('mapTaskSel').value;
  if (!taskId) return;
  if (!map) {
    map = L.map('map').setView([37.5665, 126.978], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  const { task, points, period_key } = await api('/api/admin/reports/map?taskId=' + taskId);
  $('mapInfo').textContent = `주기 ${period_key} · 위치 기록 ${points.length}건`;
  const latlngs = [];
  if (task.gps_lat != null && task.gps_lng != null) {
    L.circleMarker([task.gps_lat, task.gps_lng], { radius: 9, color: '#dc2626', fillOpacity: .3 })
      .bindPopup(`기준 위치: ${esc(task.location_name || task.title)}`).addTo(mapLayer);
    latlngs.push([task.gps_lat, task.gps_lng]);
  }
  points.forEach((p) => {
    const m = L.marker([p.gps_lat, p.gps_lng]).addTo(mapLayer);
    m.bindPopup(`<b>${esc(p.name || p.employee_id)}</b><br>${fmtDate(p.performed_at)}${p.qr_verified ? '<br>🔳 QR 인증' : ''}` +
      (p.photo_url ? `<br><img src="${p.photo_url}" style="width:140px;margin-top:4px;border-radius:6px">` : ''));
    latlngs.push([p.gps_lat, p.gps_lng]);
  });
  if (latlngs.length) map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 17 });
  setTimeout(() => map.invalidateSize(), 50);
}
