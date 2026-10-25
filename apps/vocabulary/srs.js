// 复习调度：SM-2 的精简版。
//
// 算法采用公开的 SM-2：
//   grade 0 = 错了、1 = 勉强、2 = 记得、3 = 很熟
//   grade < 2 → 重新开始（间隔 1 天，lapses+1，ease-0.2）
//   否则 reps+1，间隔按 1 → 6 → round(上次×ease) 递增，ease 依评分微调
// 只做「天」粒度，与墨水屏每天看一次的使用节奏匹配。

export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;

const DAY_MS = 86400000;

export function todayIso(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/**
 * 计算下一次复习。
 * @param {{reps?:number,lapses?:number,ease?:number,interval?:number}} prev
 * @param {0|1|2|3} grade
 * @param {string} today YYYY-MM-DD
 */
export function review(prev, grade, today = todayIso()) {
  const state = {
    reps: Number(prev?.reps) || 0,
    lapses: Number(prev?.lapses) || 0,
    ease: Number(prev?.ease) || DEFAULT_EASE,
    interval: Number(prev?.interval) || 0,
    seen: Number(prev?.seen) || 0,
  };
  const value = Math.max(0, Math.min(3, Number(grade) || 0));

  let interval;
  let ease = state.ease;
  if (value < 2) {
    state.reps = 0;
    state.lapses += 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
    interval = 1;
  } else {
    state.reps += 1;
    if (state.reps === 1) interval = 1;
    else if (state.reps === 2) interval = 6;
    else interval = Math.max(1, Math.round((state.interval || 6) * ease));
    ease = Math.max(MIN_EASE, ease + (value === 3 ? 0.1 : -0.05));
  }

  return {
    reps: state.reps,
    lapses: state.lapses,
    ease: Math.round(ease * 100) / 100,
    interval,
    seen: state.seen + 1,
    lastGrade: value,
    due: addDays(today, interval),
    lastSeen: today,
  };
}

/** 是否到期（没有进度记录的视为新词，立刻可学） */
export function isDue(entry, today = todayIso()) {
  if (!entry || !entry.due) return true;
  return entry.due <= today;
}

/** 到期词数量 */
export function dueCount(progressMap, today = todayIso()) {
  return Object.values(progressMap ?? {}).filter((entry) => isDue(entry, today)).length;
}

/** 给渲染用的口语化说明 */
export function describeInterval(entry) {
  if (!entry?.due) return '首次学习';
  const days = daysBetween(todayIso(), entry.due);
  if (days <= 0) return '今天再看';
  if (days === 1) return '明天复习';
  if (days < 30) return `${days} 天后复习`;
  return `${Math.round(days / 30)} 个月后复习`;
}
