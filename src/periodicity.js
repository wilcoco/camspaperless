// 점검 주기(periodicity) 계산 유틸.
// 서버 시간대(TZ, 기본 Asia/Seoul) 기준으로 날짜 컴포넌트를 사용한다.

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) { return String(n).padStart(2, '0'); }

// 'YYYY-MM-DD' (로컬/서버 TZ)
export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ISO 8601 주차 (월요일 시작)
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // 해당 주 목요일
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return { year: d.getUTCFullYear(), week };
}

// 주의 월요일
function mondayOf(date) {
  const d = startOfDay(date);
  const dayNum = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNum);
  return d;
}

/**
 * 주어진 날짜가 속한 주기의 키를 반환.
 * cycleType: daily | weekly | monthly | quarterly | yearly | custom
 */
export function periodKey(date, cycleType, cycleDays, startDate) {
  const d = date instanceof Date ? date : new Date(date);
  switch (cycleType) {
    case 'daily':
      return ymd(d);
    case 'weekly': {
      const { year, week } = isoWeek(d);
      return `${year}-W${pad(week)}`;
    }
    case 'monthly':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    case 'quarterly':
      return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'yearly':
      return `${d.getFullYear()}`;
    case 'custom': {
      const days = Math.max(1, cycleDays || 1);
      const start = startOfDay(startDate ? new Date(startDate) : new Date(d.getFullYear(), 0, 1));
      const diff = Math.floor((startOfDay(d) - start) / DAY_MS);
      const n = Math.floor(diff / days);
      return `C${n}`;
    }
    default:
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
}

/** 주어진 날짜가 속한 주기의 [start, end] (end는 주기 마지막 날 00:00) */
export function periodRange(date, cycleType, cycleDays, startDate) {
  const d = date instanceof Date ? date : new Date(date);
  let start, end;
  switch (cycleType) {
    case 'daily':
      start = startOfDay(d);
      end = startOfDay(d);
      break;
    case 'weekly':
      start = mondayOf(d);
      end = new Date(start); end.setDate(end.getDate() + 6);
      break;
    case 'monthly':
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      break;
    case 'quarterly': {
      const q = Math.floor(d.getMonth() / 3);
      start = new Date(d.getFullYear(), q * 3, 1);
      end = new Date(d.getFullYear(), q * 3 + 3, 0);
      break;
    }
    case 'yearly':
      start = new Date(d.getFullYear(), 0, 1);
      end = new Date(d.getFullYear(), 11, 31);
      break;
    case 'custom': {
      const days = Math.max(1, cycleDays || 1);
      const anchor = startOfDay(startDate ? new Date(startDate) : new Date(d.getFullYear(), 0, 1));
      const diff = Math.floor((startOfDay(d) - anchor) / DAY_MS);
      const n = Math.floor(diff / days);
      start = new Date(anchor); start.setDate(start.getDate() + n * days);
      end = new Date(start); end.setDate(end.getDate() + days - 1);
      break;
    }
    default:
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }
  return { start, end };
}

/** 이전 주기의 대표 날짜 */
function prevPeriodDate(date, cycleType, cycleDays, startDate) {
  const { start } = periodRange(date, cycleType, cycleDays, startDate);
  return new Date(start.getTime() - DAY_MS); // 직전 주기에 속하는 하루 전
}

export function prevPeriodKey(date, cycleType, cycleDays, startDate) {
  const d = prevPeriodDate(date, cycleType, cycleDays, startDate);
  return periodKey(d, cycleType, cycleDays, startDate);
}

// 이전 주기의 시작일(Date)
export function prevPeriodStart(date, cycleType, cycleDays, startDate) {
  const d = prevPeriodDate(date, cycleType, cycleDays, startDate);
  return periodRange(d, cycleType, cycleDays, startDate).start;
}

/**
 * 현재 상태 계산.
 * @param doneCurrent 현재 주기 수행 여부
 * @param donePrev 이전 주기 수행 여부
 * @returns {status, daysLeft, periodEnd}
 *   status: done | due_soon | pending | overdue
 */
export function computeStatus(today, task, doneCurrent, donePrev, obligatedSince) {
  const { cycle_type, cycle_days, start_date, warn_before_days } = task;
  const { end } = periodRange(today, cycle_type, cycle_days, start_date);
  const daysLeft = Math.round((startOfDay(end) - startOfDay(today)) / DAY_MS);

  if (doneCurrent) {
    return { status: 'done', daysLeft, periodEnd: ymd(end) };
  }
  // 이전 주기가 의무 기간이었는데(담당 시작 이후) 놓쳤으면 누락(overdue).
  // obligatedSince(담당/업무 시작일) 이전의 주기는 의무가 아니므로 누락으로 보지 않는다.
  const prevStart = prevPeriodStart(today, cycle_type, cycle_days, start_date);
  const since = obligatedSince ? startOfDay(new Date(obligatedSince)) : startOfDay(new Date(start_date));
  const prevObligated = startOfDay(prevStart) >= since;
  if (prevObligated && donePrev === false) {
    return { status: 'overdue', daysLeft, periodEnd: ymd(end) };
  }
  if (daysLeft <= (warn_before_days ?? 3)) {
    return { status: 'due_soon', daysLeft, periodEnd: ymd(end) };
  }
  return { status: 'pending', daysLeft, periodEnd: ymd(end) };
}

export const CYCLE_LABELS = {
  daily: '매일',
  weekly: '매주',
  monthly: '매월',
  quarterly: '분기',
  yearly: '매년',
  custom: '사용자정의',
};
