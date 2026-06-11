import { api, getMe, logout, el, esc, toast, STATUS_LABEL, fmtDate,
  normalizeItemInputs } from '/js/common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let tasksCache = [];
let map = null, mapLayer = null;

/* ---------- 체크리스트 빌더 (항목별 증빙 조합) ---------- */
const INPUT_DEFS = [
  ['check', '✅ 체크'], ['text', '✏️ 텍스트'], ['photo', '📷 사진'], ['gps', '📍 위치'], ['qr', '🔳 QR'],
];
function createChecklistBuilder(containerId) {
  const box = $(containerId);
  let items = [];
  function render() {
    box.innerHTML = '';
    items.forEach((it, i) => {
      const row = el('<div class="cl-item"></div>');
      const head = el('<div class="cl-head"></div>');
      const inp = el('<input type="text" placeholder="항목명 (예: 압력게이지 점검)" />');
      inp.value = it.label;
      inp.oninput = (e) => { items[i].label = e.target.value; };
      const del = el('<button type="button" class="cl-del" title="항목 삭제">&times;</button>');
      del.onclick = () => { items.splice(i, 1); render(); };
      head.appendChild(inp); head.appendChild(del);
      row.appendChild(head);
      const evi = el('<div class="evi"></div>');
      INPUT_DEFS.forEach(([key, label]) => {
        const b = el(`<button type="button">${label}</button>`);
        if (it.inputs.includes(key)) b.classList.add('active');
        b.onclick = () => {
          const has = items[i].inputs.includes(key);
          if (has && items[i].inputs.length === 1) return; // 증빙은 최소 1개
          items[i].inputs = has ? items[i].inputs.filter((x) => x !== key) : [...items[i].inputs, key];
          render();
        };
        evi.appendChild(b);
      });
      row.appendChild(evi);
      box.appendChild(row);
    });
    const add = el('<button type="button" class="btn small secondary">+ 항목 추가</button>');
    add.onclick = () => {
      items.push({ label: '', inputs: ['check'] });
      render();
      const inputs = box.querySelectorAll('.cl-head input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
    box.appendChild(add);
  }
  render();
  return {
    set(list) { items = (Array.isArray(list) ? list : []).map(normalizeItemInputs); render(); },
    get() { return items.filter((it) => it.label.trim()).map((it) => ({ label: it.label.trim(), inputs: it.inputs })); },
  };
}
let taskCl = null, asgCl = null;

init();

async function init() {
  me = await getMe();
  if (!me) return (location.href = '/');
  if (me.role !== 'admin') return (location.href = '/app.html');
  $('whoami').textContent = `${me.name || me.employee_id} · 관리자`;
  $('logoutBtn').onclick = logout;
  setupTabs();
  bindTaskForm();
  bindMembers();
  bindAssign();
  bindAsgModal();
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
    if (tab === 'members') loadMembers();
    if (tab === 'assign') loadTaskSelectors().then(loadTargets).then(loadAssignments);
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
// 주기 프리셋 — 칩 한 번으로 (단위, 간격, 횟수)를 지정. '직접 설정'은 상세 패널을 연다.
const CYCLE_PRESETS = {
  daily:      { cycle_type: 'daily',     cycle_interval: 1, times_per_period: 1 },
  weekly:     { cycle_type: 'weekly',    cycle_interval: 1, times_per_period: 1 },
  weekly2x:   { cycle_type: 'weekly',    cycle_interval: 1, times_per_period: 2 },
  biweekly:   { cycle_type: 'weekly',    cycle_interval: 2, times_per_period: 1 },
  monthly:    { cycle_type: 'monthly',   cycle_interval: 1, times_per_period: 1 },
  quarterly:  { cycle_type: 'quarterly', cycle_interval: 1, times_per_period: 1 },
  semiannual: { cycle_type: 'monthly',   cycle_interval: 6, times_per_period: 1 },
  yearly:     { cycle_type: 'yearly',    cycle_interval: 1, times_per_period: 1 },
};
let editingStartDate = null; // 수정 중인 업무의 시작일 (미리보기 앵커용)

function readCycleForm() {
  return {
    cycle_type: $('f_cycle').value,
    cycle_days: parseInt($('f_cycle_days').value, 10) || 30,
    cycle_interval: parseInt($('f_cycle_interval').value, 10) || 1,
    times_per_period: parseInt($('f_times').value, 10) || 1,
  };
}

function chipForState(s) {
  for (const [key, p] of Object.entries(CYCLE_PRESETS)) {
    const interval = (s.cycle_type === 'weekly' || s.cycle_type === 'monthly') ? s.cycle_interval : 1;
    if (p.cycle_type === s.cycle_type && p.cycle_interval === interval && p.times_per_period === s.times_per_period) return key;
  }
  return 'advanced';
}

function setCyclePreset(key) {
  document.querySelectorAll('#cycleChips button').forEach((b) => b.classList.toggle('active', b.dataset.preset === key));
  $('cycleAdvanced').style.display = key === 'advanced' ? '' : 'none';
  const p = CYCLE_PRESETS[key];
  if (p) {
    $('f_cycle').value = p.cycle_type;
    $('f_cycle_interval').value = p.cycle_interval;
    $('f_times').value = p.times_per_period;
  }
  updateCycleUI();
  updateCyclePreview();
}

function updateCycleUI() {
  const t = $('f_cycle').value;
  $('cycleIntervalWrap').style.display = (t === 'weekly' || t === 'monthly') ? '' : 'none';
  $('cycleDaysWrap').style.display = t === 'custom' ? '' : 'none';
}

let previewTimer = null;
function updateCyclePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const s = readCycleForm();
    const params = new URLSearchParams({
      cycle_type: s.cycle_type, cycle_days: s.cycle_days,
      cycle_interval: s.cycle_interval, times_per_period: s.times_per_period,
    });
    if (editingStartDate) params.set('start_date', editingStartDate);
    try {
      const p = await api('/api/admin/cycle-preview?' + params.toString());
      $('cyclePreview').textContent = `📅 ${p.label} · 이번 주기 ${p.current.start} ~ ${p.current.end}` +
        (p.required > 1 ? ` (${p.required}회 수행)` : '') + ` · 다음 주기 ${p.next.start} ~`;
    } catch { $('cyclePreview').textContent = ''; }
  }, 250);
}

function bindTaskForm() {
  taskCl = createChecklistBuilder('f_checklistBuilder');
  document.querySelectorAll('#cycleChips button').forEach((b) => b.onclick = () => setCyclePreset(b.dataset.preset));
  ['f_cycle', 'f_cycle_interval', 'f_cycle_days', 'f_times'].forEach((id) => {
    $(id).onchange = () => { updateCycleUI(); updateCyclePreview(); };
  });
  $('taskResetBtn').onclick = resetTaskForm;
  $('taskForm').onsubmit = saveTask;
  updateCycleUI();
  updateCyclePreview();
}

function resetTaskForm() {
  $('taskId').value = '';
  $('taskForm').reset();
  $('f_photo').checked = true;
  editingStartDate = null;
  taskCl.set([]);
  setCyclePreset('monthly');
  $('taskFormTitle').textContent = '새 업무 등록';
  $('taskErr').textContent = '';
}

async function saveTask(e) {
  e.preventDefault();
  $('taskErr').textContent = '';
  const id = $('taskId').value;
  const s = readCycleForm();
  const body = {
    title: $('f_title').value.trim(),
    category: $('f_category').value.trim(),
    description: $('f_description').value.trim(),
    cycle_type: s.cycle_type,
    cycle_days: s.cycle_days,
    cycle_interval: s.cycle_interval,
    times_per_period: s.times_per_period,
    warn_before_days: parseInt($('f_warn').value, 10) || 3,
    require_photo: $('f_photo').checked,
    require_gps: $('f_gps').checked,
    require_qr: $('f_qr').checked,
    checklist: taskCl.get(),
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
    const copy = el('<button class="btn small secondary" style="margin-left:4px">복사</button>');
    copy.onclick = () => copyTaskToForm(t);
    actions.appendChild(copy);
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
  $('f_description').value = t.description || '';
  $('f_cycle').value = t.cycle_type;
  $('f_cycle_interval').value = t.cycle_interval || 1;
  $('f_cycle_days').value = t.cycle_days || 30;
  $('f_times').value = t.times_per_period || 1;
  editingStartDate = t.start_date ? String(t.start_date).slice(0, 10) : null;
  setCyclePreset(chipForState(readCycleForm()));
  $('f_warn').value = t.warn_before_days;
  $('f_photo').checked = t.require_photo;
  $('f_gps').checked = t.require_gps;
  $('f_qr').checked = t.require_qr;
  taskCl.set(t.checklist);
  $('taskFormTitle').textContent = '업무 수정 (#' + t.id + ')';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 기존 업무를 폼에 불러와 "새 업무"로 저장하게 한다 (주기·증빙·체크리스트 그대로 복사)
function copyTaskToForm(t) {
  fillTaskForm(t);
  $('taskId').value = '';
  $('f_title').value = (t.title || '') + ' (복사)';
  editingStartDate = null; // 복사본의 시작일은 저장 시점(오늘)
  updateCyclePreview();
  $('taskFormTitle').textContent = '새 업무 등록 (복사본)';
}

/* ---------- QR 모달 ---------- */
function bindQrModal() {
  $('qrModalClose').onclick = () => $('qrModalBg').classList.remove('open');
  $('qrModalBg').addEventListener('click', (e) => { if (e.target.id === 'qrModalBg') $('qrModalBg').classList.remove('open'); });
}
async function showAssignmentQr(assignmentId) {
  const data = await api('/api/admin/assignments/' + assignmentId + '/qr');
  $('qrModalBody').innerHTML = `
    <p class="muted small">${esc(data.title)} · ${esc(data.assignee)}${data.location ? ' · ' + esc(data.location) : ''}</p>
    <img src="${data.dataUrl}" style="width:240px;max-width:100%" />
    <p class="small muted">이 QR을 인쇄해 <b>${esc(data.location || '해당 구역')}</b>에 부착하세요. 담당자가 스캔하면 그 위치에서 수행했음이 증빙됩니다.</p>
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

/* ---------- 구성원 관리 ---------- */
let membersCache = [];
function bindMembers() {
  $('memberAddBtn').onclick = addMembers;
  $('syncBtn').onclick = syncEmployees;
  $('memberFilter').oninput = renderMembersFiltered;
  $('memberDeptFilter').onchange = renderMembersFiltered;
}
function renderMembersFiltered() { renderMembers($('memberFilter').value, $('memberDeptFilter').value); }
// membersCache 에서 부서 목록(정렬)
function departments() {
  return [...new Set(membersCache.map((u) => u.department).filter(Boolean))].sort();
}
// 부서 셀렉트 채우기. allLabel 지정 시 '전체' 옵션 포함.
function fillDeptSelect(id, allLabel) {
  const sel = $(id); if (!sel) return;
  const prev = sel.value;
  const opts = departments().map((d) => `<option value="${esc(d)}">${esc(d)}</option>`);
  sel.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : '') + opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
async function syncEmployees() {
  $('syncErr').textContent = ''; $('syncOk').textContent = '';
  const btn = $('syncBtn'); btn.disabled = true; btn.textContent = '가져오는 중...';
  try {
    const { synced } = await api('/api/admin/sync-employees', { method: 'POST' });
    $('syncOk').textContent = `CAMS 사원 ${synced}명을 동기화했습니다.`;
    toast(`${synced}명 동기화 완료`);
    await loadMembers();
  } catch (e) { $('syncErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = '↻ CAMS에서 사원 목록 가져오기'; }
}
async function addMembers() {
  $('memberErr').textContent = '';
  const users = $('memberInput').value.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [employee_id, name, department] = line.split(',').map((s) => s.trim());
    return { employee_id, name: name || null, department: department || null };
  }).filter((u) => u.employee_id);
  if (!users.length) { $('memberErr').textContent = '사번을 입력하세요.'; return; }
  try {
    await api('/api/admin/users', { method: 'POST', body: { users } });
    $('memberInput').value = '';
    toast(`${users.length}명 등록되었습니다.`);
    await loadMembers();
  } catch (e) { $('memberErr').textContent = e.message; }
}
async function loadMembers() {
  const { users } = await api('/api/admin/users');
  membersCache = users;
  $('memberCount').textContent = `(${users.length}명)`;
  fillDeptSelect('memberDeptFilter', '전체 부서');
  renderMembersFiltered();
}
function filterUsers(q, dept) {
  q = (q || '').trim().toLowerCase();
  let list = membersCache;
  if (dept) list = list.filter((u) => u.department === dept);
  if (q) list = list.filter((u) => [u.name, u.employee_id].some((v) => (v || '').toLowerCase().includes(q)));
  return list;
}
function renderMembers(q, dept) {
  const box = $('memberList');
  const list = filterUsers(q, dept);
  if (!list.length) { box.innerHTML = '<div class="empty">해당 조건의 구성원이 없습니다.</div>'; return; }
  box.innerHTML = '';
  list.forEach((u) => {
    box.appendChild(el(`<div class="list-item">
      <div><div class="title">${esc(u.name || u.employee_id)} ${u.role === 'admin' ? '<span class="chip">관리자</span>' : ''}</div>
        <div class="meta">${esc(u.employee_id)} · ${esc(u.department || '부서미정')}</div></div>
      <div class="small muted">${u.last_login ? '로그인함' : '미로그인'}</div></div>`));
  });
}

/* ---------- 배정 ---------- */
let assignTarget = 'all';
let assignMode = 'detail';
function bindAssign() {
  $('assignTaskSel').onchange = loadAssignments;
  $('assignAddBtn').onclick = doAssign;
  $('indivFilter').oninput = renderIndivFiltered;
  $('indivDeptFilter').onchange = renderIndivFiltered;
  $('matchSaveBtn').onclick = saveMatching;
  $('matchDeptFilter').onchange = renderMatchRows;
  document.querySelectorAll('#assignModeTabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('#assignModeTabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    assignMode = b.dataset.mode;
    $('assignDetail').hidden = assignMode !== 'detail';
    $('assignBulk').hidden = assignMode !== 'bulk';
  });
  document.querySelectorAll('#targetTabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('#targetTabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    assignTarget = b.dataset.target;
    $('targetAll').hidden = assignTarget !== 'all';
    $('targetTeam').hidden = assignTarget !== 'team';
    $('targetIndividual').hidden = assignTarget !== 'individual';
    updateIndivCount();
  });
}
async function loadTargets() {
  if (!membersCache.length) await loadMembers();
  $('allCount').textContent = membersCache.length;
  const { departments: deps } = await api('/api/admin/departments');
  $('teamSel').innerHTML = deps.length
    ? deps.map((d) => `<option value="${esc(d.department)}">${esc(d.department)} (${d.member_count}명)</option>`).join('')
    : '<option value="">등록된 부서 없음</option>';
  // 개인 선택은 부서로 먼저 거른다 — 기본값은 첫 부서(전체 명단을 한 번에 안 보여줌)
  fillDeptSelect('indivDeptFilter', '전체 부서');
  fillDeptSelect('matchDeptFilter', '전체 부서');
  const ds = departments();
  if (ds.length) $('indivDeptFilter').value = ds[0];
  renderIndivFiltered();
}
const selectedIndiv = new Set(); // 부서 필터를 바꿔도 유지되는 개인 선택
function renderIndivFiltered() { renderIndivList($('indivFilter').value, $('indivDeptFilter').value); }
function updateIndivCount() {
  $('assignAddBtn').textContent = assignTarget === 'individual' && selectedIndiv.size
    ? `선택한 ${selectedIndiv.size}명 배정` : '선택한 대상에 배정';
}
function renderIndivList(q, dept) {
  const box = $('indivList');
  const list = filterUsers(q, dept);
  if (!list.length) { box.innerHTML = '<div class="empty">해당 조건의 구성원이 없습니다. 먼저 구성원 탭에서 동기화/등록하세요.</div>'; updateIndivCount(); return; }
  box.innerHTML = '';
  list.forEach((u) => {
    const row = el(`<div class="checkrow"><input type="checkbox" id="iv_${esc(u.employee_id)}"><label for="iv_${esc(u.employee_id)}">${esc(u.name || u.employee_id)} <span class="muted small">· ${esc(u.employee_id)} · ${esc(u.department || '')}</span></label></div>`);
    const cb = row.querySelector('input');
    cb.checked = selectedIndiv.has(u.employee_id);
    cb.onchange = () => { cb.checked ? selectedIndiv.add(u.employee_id) : selectedIndiv.delete(u.employee_id); updateIndivCount(); };
    box.appendChild(row);
  });
  updateIndivCount();
}
async function doAssign() {
  $('assignErr').textContent = '';
  const taskId = $('assignTaskSel').value;
  if (!taskId) { $('assignErr').textContent = '업무를 선택하세요.'; return; }
  const body = { target: assignTarget };
  if (assignTarget === 'team') {
    body.department = $('teamSel').value;
    if (!body.department) { $('assignErr').textContent = '팀(부서)을 선택하세요.'; return; }
  } else if (assignTarget === 'individual') {
    body.employee_ids = [...selectedIndiv];
    if (!body.employee_ids.length) { $('assignErr').textContent = '개인을 한 명 이상 선택하세요.'; return; }
  }
  try {
    const r = await api('/api/admin/tasks/' + taskId + '/assignments', { method: 'POST', body });
    toast(`${r.count}명 배정되었습니다.`);
    selectedIndiv.clear();
    renderIndivFiltered();
    await loadAssignments();
    tasksCache = [];
  } catch (e) { $('assignErr').textContent = e.message; }
}
async function loadAssignments() {
  const box = $('assignList');
  const taskId = $('assignTaskSel').value;
  if (!taskId) {
    box.innerHTML = '<div class="empty">업무를 선택하세요.</div>';
    $('matchBoard').innerHTML = '<div class="empty">업무를 선택하세요.</div>';
    return;
  }
  const { assignments } = await api('/api/admin/tasks/' + taskId + '/assignments');
  buildMatchBoard(taskId, assignments);
  if (!assignments.length) { box.innerHTML = '<div class="empty">배정된 담당자가 없습니다.</div>'; return; }
  box.innerHTML = '';
  assignments.forEach((a) => {
    const cl = Array.isArray(a.checklist) ? a.checklist.length : 0;
    const meta = `${esc(a.employee_id)} · 구역: ${esc(a.location_name || '미지정')}` +
      (cl ? ` · 세부 ${cl}개` : '') + (a.has_qr ? ' · 🔳QR' : '');
    const item = el(`<div class="list-item">
      <div><div class="title">${esc(a.name || a.employee_id)}</div><div class="meta">${meta}</div></div>
      <div class="right-align" style="white-space:nowrap"></div></div>`);
    const actions = item.querySelector('.right-align');
    const edit = el('<button class="btn small secondary">구역·세부</button>');
    edit.onclick = () => openAsgModal(a);
    actions.appendChild(edit);
    if (a.has_qr) {
      const qr = el('<button class="btn small secondary" style="margin-left:4px">QR</button>');
      qr.onclick = () => showAssignmentQr(a.id);
      actions.appendChild(qr);
    }
    const del = el('<button class="btn small danger" style="margin-left:4px">해제</button>');
    del.onclick = async () => { if (confirm('배정을 해제할까요?')) { await api('/api/admin/assignments/' + a.id, { method: 'DELETE' }); toast('해제됨'); loadAssignments(); tasksCache = []; } };
    actions.appendChild(del);
    box.appendChild(item);
  });
}

/* ---------- 세부업무별 담당자 매칭 (업무 → 세부업무 → 담당자) ---------- */
let matchState = [];               // [{label, inputs, employee_id}]
let matchPrevOwners = new Set();   // 보드 로드 시점에 세부업무를 맡고 있던 사번 (해제 판단용)

function buildMatchBoard(taskId, assignments) {
  const task = tasksCache.find((t) => String(t.id) === String(taskId));
  const items = (task && Array.isArray(task.checklist) ? task.checklist : []).map(normalizeItemInputs);
  if (!items.length) {
    $('matchBoard').innerHTML = '<div class="empty">이 업무에 세부 테스크(체크리스트)가 없습니다.<br>업무관리에서 항목을 먼저 등록하세요.</div>';
    matchState = []; matchPrevOwners = new Set();
    return;
  }
  // 항목별 현재 담당자 prefill — 배정 체크리스트에 같은 라벨이 있으면 그 사람이 담당
  const active = assignments.filter((a) => a.active !== false);
  matchPrevOwners = new Set();
  matchState = items.map((it) => {
    const owner = active.find((a) =>
      (Array.isArray(a.checklist) ? a.checklist : []).some((c) => (c && c.label ? c.label : c) === it.label));
    if (owner) matchPrevOwners.add(owner.employee_id);
    return { label: it.label, inputs: it.inputs, employee_id: owner ? owner.employee_id : '' };
  });
  renderMatchRows();
}

function matchMemberOptions(selected) {
  const dept = $('matchDeptFilter').value;
  let list = dept ? membersCache.filter((u) => u.department === dept) : membersCache;
  // 부서 필터에 걸려도 이미 선택된 담당자는 항상 보이게
  if (selected && !list.some((u) => u.employee_id === selected)) {
    const sel = membersCache.find((u) => u.employee_id === selected);
    if (sel) list = [sel, ...list];
  }
  return ['<option value="">— 담당자 선택 —</option>']
    .concat(list.map((u) =>
      `<option value="${esc(u.employee_id)}"${u.employee_id === selected ? ' selected' : ''}>${esc(u.name || u.employee_id)} · ${esc(u.department || '')}</option>`))
    .join('');
}

function renderMatchRows() {
  const box = $('matchBoard');
  if (!matchState.length) return;
  box.innerHTML = '';
  const eviLabel = Object.fromEntries(INPUT_DEFS);
  matchState.forEach((r, i) => {
    const chips = r.inputs.map((t) => `<span class="chip">${eviLabel[t] || t}</span>`).join(' ');
    const row = el(`<div class="cl-item">
      <div style="font-weight:600">${esc(r.label)} <span class="small">${chips}</span></div>
      <select style="margin-top:8px"></select></div>`);
    const sel = row.querySelector('select');
    sel.innerHTML = matchMemberOptions(r.employee_id);
    sel.onchange = (e) => { matchState[i].employee_id = e.target.value; };
    box.appendChild(row);
  });
}

async function saveMatching() {
  $('matchErr').textContent = '';
  const taskId = $('assignTaskSel').value;
  if (!taskId || !matchState.length) { $('matchErr').textContent = '업무와 세부업무를 먼저 확인하세요.'; return; }
  const byEmp = new Map();
  matchState.forEach((r) => {
    if (!r.employee_id) return;
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push({ label: r.label, inputs: r.inputs });
  });
  if (!byEmp.size) { $('matchErr').textContent = '담당자를 한 명 이상 선택하세요.'; return; }

  const btn = $('matchSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    const { assignments } = await api('/api/admin/tasks/' + taskId + '/assignments');
    for (const [emp, items] of byEmp) {
      let asg = assignments.find((a) => a.employee_id === emp);
      if (!asg) {
        const r = await api('/api/admin/tasks/' + taskId + '/assignments',
          { method: 'POST', body: { target: 'individual', employee_ids: [emp] } });
        asg = r.assignments[0];
      }
      await api('/api/admin/assignments/' + asg.id, { method: 'PUT', body: { checklist: items } });
    }
    // 이전에 세부업무를 맡았다가 이번 매칭에서 모두 빠진 담당자 → 배정 해제 확인
    for (const emp of matchPrevOwners) {
      if (byEmp.has(emp)) continue;
      const asg = assignments.find((a) => a.employee_id === emp);
      if (!asg) continue;
      const u = membersCache.find((x) => x.employee_id === emp);
      if (confirm(`${(u && u.name) || emp} 님은 이번 매칭에서 맡은 세부업무가 없습니다. 이 업무 배정을 해제할까요?`)) {
        await api('/api/admin/assignments/' + asg.id, { method: 'DELETE' });
      }
    }
    toast('세부업무 매칭이 저장되었습니다.');
    tasksCache = [];
    await loadTaskSelectors();
    await loadAssignments();
  } catch (e) { $('matchErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = '매칭 저장'; }
}

/* ---------- 배정 편집 모달 ---------- */
function bindAsgModal() {
  asgCl = createChecklistBuilder('asg_checklistBuilder');
  $('asgModalClose').onclick = () => $('asgModalBg').classList.remove('open');
  $('asgModalBg').addEventListener('click', (e) => { if (e.target.id === 'asgModalBg') $('asgModalBg').classList.remove('open'); });
  $('asgSaveBtn').onclick = saveAsg;
}
function openAsgModal(a) {
  $('asg_id').value = a.id;
  $('asgModalTitle').textContent = `${a.name || a.employee_id} · 구역/체크리스트`;
  $('asg_location').value = a.location_name || '';
  asgCl.set(a.checklist);
  $('asg_lat').value = a.gps_lat ?? '';
  $('asg_lng').value = a.gps_lng ?? '';
  $('asgErr').textContent = '';
  $('asgModalBg').classList.add('open');
}
async function saveAsg() {
  const id = $('asg_id').value;
  const checklist = asgCl.get();
  const body = {
    location_name: $('asg_location').value.trim(),
    checklist,
    gps_lat: $('asg_lat').value !== '' ? Number($('asg_lat').value) : null,
    gps_lng: $('asg_lng').value !== '' ? Number($('asg_lng').value) : null,
  };
  try {
    await api('/api/admin/assignments/' + id, { method: 'PUT', body });
    toast('저장되었습니다.');
    $('asgModalBg').classList.remove('open');
    await loadAssignments();
  } catch (e) { $('asgErr').textContent = e.message; }
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
    const times = r.required > 1 ? `${r.done_count}/${r.required}회 · ` : '';
    const sub = times + (rec
      ? `${fmtDate(rec.performed_at)}${rec.qr_verified ? ' · 🔳QR' : ''}${rec.gps_lat ? ' · 📍GPS' : ''}${rec.note ? ' · ' + esc(rec.note) : ''}`
      : '미수행');
    const item = el(`<div class="list-item" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><div class="title">${esc(r.name || r.employee_id)} ${rec && rec.issue ? '<span class="badge issue">특이</span>' : ''}</div>
          <div class="meta">${esc(r.employee_id)}${r.location_name ? ' · ' + esc(r.location_name) : ''} · ${sub}</div></div>
        <div class="right-align"><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></div>
      </div></div>`);
    if (rec && Array.isArray(rec.checklist_results) && rec.checklist_results.length) {
      const det = el('<div style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px"></div>');
      rec.checklist_results.forEach((c) => det.appendChild(el(`<div class="small" style="margin:3px 0">${renderResult(c)}</div>`)));
      item.appendChild(det);
    }
    if (rec && rec.photo_url) {
      const p = el('<button class="btn small ghost" style="align-self:flex-start;margin-top:6px;padding-left:0">📷 대표 사진 보기</button>');
      p.onclick = () => window.open(rec.photo_url, '_blank');
      item.appendChild(p);
    }
    box.appendChild(item);
  });
}

// 체크리스트 항목 결과 한 줄 렌더 — 증빙 조합(inputs) 또는 구형(type) 결과 모두 처리
function renderResult(c) {
  const inputs = (Array.isArray(c.inputs) && c.inputs.length) ? c.inputs : [c.type || 'check'];
  const parts = inputs.map((t) => {
    switch (t) {
      case 'text': return esc(c.text || '-');
      case 'photo': return c.photo_url
        ? `<a href="${esc(c.photo_url)}" target="_blank">📷 사진</a>` : '사진 없음';
      case 'gps': return c.gps_lat != null
        ? `📍 ${Number(c.gps_lat).toFixed(5)}, ${Number(c.gps_lng).toFixed(5)}` : '위치 없음';
      case 'qr': return c.qr_verified ? '🔳 인증됨' : 'QR 미인증';
      default: return c.checked ? '✅ 완료' : '⬜ 미체크';
    }
  });
  return `<b>${esc(c.label || '')}</b>: ${parts.join(' · ')}`;
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
