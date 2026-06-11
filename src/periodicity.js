// 점검 주기(periodicity) 계산 유틸.
// 서버 시간대(TZ, 기본 Asia/Seoul) 기준으로 날짜 컴포넌트를 사용한다.
//
// 주기 옵션은 task 형태의 객체로 받는다:
//   { cycle_type, cycle_days, cycle_interval, start_date }
// - cycle_type: daily | weekly | monthly | quarterly | yearly | custom
// - cycle_interval: weekly/monthly 에서 "매 N주/N월" (기본 1, 격주=2, 반기=monthly 6)
// - cycle_days: custom 에서 N일 주기
// interval=1 이면 기존 주기 키 형식(2026-W23, 2026-06 등)을 그대로 사용해
// 이미 저장된 records 와 호환된다. interval>1 은 start_date 를 앵커로 한
// 별도 형식(W2N15, M6N3)을 쓴다.

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

function normOpts(opts) {
  const cycleType = opts.cycle_type || 'monthly';
  return {
    cycleType,
    cycleDays: Math.max(1, parseInt(opts.cycle_days, 10) || 1),
    interval: Math.max(1, parseInt(opts.cycle_interval, 10) || 1),
    startDate: opts.start_date ? new Date(opts.start_date) : null,
  };
}

// interval>1 주기의 앵커: start_date(없으면 해당 연도 1/1)
function anchorOf(d, startDate) {
  return startOfDay(startDate || new Date(d.getFullYear(), 0, 1));
}

/** 주어진 날짜가 속한 주기의 키를 반환. */
export function periodKey(date, opts) {
  const d = date instanceof Date ? date : new Date(date);
  const { cycleType, cycleDays, interval, startDate } = normOpts(opts);
  switch (cycleType) {
    case 'daily':
      return ymd(d);
    case 'weekly': {
      if (interval > 1) {
        const anchor = mondayOf(anchorOf(d, startDate));
        const weeks = Math.round((mondayOf(d) - anchor) / DAY_MS / 7);
        return `W${interval}N${Math.floor(weeks / interval)}`;
      }
      const { year, week } = isoWeek(d);
      return `${year}-W${pad(week)}`;
    }
    case 'monthly': {
      if (interval > 1) {
        const anchor = anchorOf(d, startDate);
        const months = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth());
        return `M${interval}N${Math.floor(months / interval)}`;
      }
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }
    case 'quarterly':
      return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'yearly':
      return `${d.getFullYear()}`;
    case 'custom': {
      const start = anchorOf(d, startDate);
      const diff = Math.floor((startOfDay(d) - start) / DAY_MS);
      return `C${Math.floor(diff / cycleDays)}`;
    }
    default:
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
}

/** 주어진 날짜가 속한 주기의 [start, end] (end는 주기 마지막 날 00:00) */
export function periodRange(date, opts) {
  const d = date instanceof Date ? date : new Date(date);
  const { cycleType, cycleDays, interval, startDate } = normOpts(opts);
  let start, end;
  switch (cycleType) {
    case 'daily':
      start = startOfDay(d);
      end = startOfDay(d);
      break;
    case 'weekly': {
      if (interval > 1) {
        const anchor = mondayOf(anchorOf(d, startDate));
        const weeks = Math.round((mondayOf(d) - anchor) / DAY_MS / 7);
        const n = Math.floor(weeks / interval);
        start = new Date(anchor); start.setDate(start.getDate() + n * interval * 7);
        end = new Date(start); end.setDate(end.getDate() + interval * 7 - 1);
      } else {
        start = mondayOf(d);
        end = new Date(start); end.setDate(end.getDate() + 6);
      }
      break;
    }
    case 'monthly': {
      if (interval > 1) {
        const anchor = anchorOf(d, startDate);
        const months = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth());
        const n = Math.floor(months / interval);
        start = new Date(anchor.getFullYear(), anchor.getMonth() + n * interval, 1);
        end = new Date(anchor.getFullYear(), anchor.getMonth() + (n + 1) * interval, 0);
      } else {
        start = new Date(d.getFullYear(), d.getMonth(), 1);
        end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      }
      break;
    }
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
      const anchor = anchorOf(d, startDate);
      const diff = Math.floor((startOfDay(d) - anchor) / DAY_MS);
      const n = Math.floor(diff / cycleDays);
      start = new Date(anchor); start.setDate(start.getDate() + n * cycleDays);
      end = new Date(start); end.setDate(end.getDate() + cycleDays - 1);
      break;
    }
    default:
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }
  return { start, end };
}

/** 이전 주기의 대표 날짜 */
function prevPeriodDate(date, opts) {
  const { start } = periodRange(date, opts);
  return new Date(start.getTime() - DAY_MS); // 직전 주기에 속하는 하루 전
}

export function prevPeriodKey(date, opts) {
  return periodKey(prevPeriodDate(date, opts), opts);
}

// 이전 주기의 시작일(Date)
export function prevPeriodStart(date, opts) {
  return periodRange(prevPeriodDate(date, opts), opts).start;
}

/**
 * 현재 상태 계산. 주기당 요구 횟수(times_per_period)를 채워야 완료.
 * @param curCount 현재 주기 수행 횟수 (boolean도 허용)
 * @param prevCount 이전 주기 수행 횟수 (boolean도 허용)
 * @returns {status, daysLeft, periodEnd, doneCount, required}
 *   status: done | due_soon | pending | overdue
 */
export function computeStatus(today, task, curCount, prevCount, obligatedSince) {
  const { warn_before_days, times_per_period, start_date } = task;
  const required = Math.max(1, parseInt(times_per_period, 10) || 1);
  const cur = typeof curCount === 'number' ? curCount : (curCount ? required : 0);
  const prev = typeof prevCount === 'number' ? prevCount : (prevCount ? required : 0);

  const { end } = periodRange(today, task);
  const daysLeft = Math.round((startOfDay(end) - startOfDay(today)) / DAY_MS);
  const base = { daysLeft, periodEnd: ymd(end), doneCount: cur, required };

  if (cur >= required) {
    return { status: 'done', ...base };
  }
  // 이전 주기가 의무 기간이었는데(담당 시작 이후) 못 채웠으면 누락(overdue).
  // obligatedSince(담당/업무 시작일) 이전의 주기는 의무가 아니므로 누락으로 보지 않는다.
  const prevStart = prevPeriodStart(today, task);
  const since = obligatedSince ? startOfDay(new Date(obligatedSince)) : startOfDay(new Date(start_date));
  const prevObligated = startOfDay(prevStart) >= since;
  if (prevObligated && prev < required) {
    return { status: 'overdue', ...base };
  }
  if (daysLeft <= (warn_before_days ?? 3)) {
    return { status: 'due_soon', ...base };
  }
  return { status: 'pending', ...base };
}

export const CYCLE_LABELS = {
  daily: '매일',
  weekly: '매주',
  monthly: '매월',
  quarterly: '분기',
  yearly: '매년',
  custom: '사용자정의',
};

/** 간격·횟수를 반영한 주기 라벨. 예: 매주, 격주, 반기, 매주 2회, 10일마다 */
export function cycleLabel(task) {
  const { cycleType, cycleDays, interval } = normOpts(task);
  let base;
  if (cycleType === 'weekly') {
    base = interval === 1 ? '매주' : interval === 2 ? '격주' : `${interval}주마다`;
  } else if (cycleType === 'monthly') {
    base = interval === 1 ? '매월' : interval === 6 ? '반기' : `${interval}개월마다`;
  } else if (cycleType === 'custom') {
    base = `${cycleDays}일마다`;
  } else {
    base = CYCLE_LABELS[cycleType] || cycleType;
  }
  const times = Math.max(1, parseInt(task.times_per_period, 10) || 1);
  return times > 1 ? `${base} ${times}회` : base;
}
