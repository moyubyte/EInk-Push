// 宠物的「成长引擎」：纯函数，不碰文件与网络，方便测试。
//
// 核心约定：宠物状态不靠页面在线推进。每一次读取都用「上次结算时刻 → 现在」补算，
// 所以 NAS 上的进程重启、浏览器关掉、好几天没人访问，宠物依然按真实时间成长
// （饥饿、心情、精力衰减；经验随时间累积；阶段按出生天数解锁）。
// 离线超过上限后只补算上限内的部分，避免久别归来时数值被一次扣光。

export const DEFAULT_NAME = '小爪';
export const STATE_VERSION = 1;

// 阶段按出生天数解锁；level 是经验等级，和阶段互不冲突
export const STAGES = [
  { key: 'baby', name: '幼崽', days: 0 },
  { key: 'teen', name: '少年', days: 3 },
  { key: 'adult', name: '成年', days: 7 },
  { key: 'elder', name: '长老', days: 30 },
];

export const ACTIONS = {
  feed: { label: '喂食', cooldownMs: 10 * 60 * 1000 },
  pet: { label: '摸摸', cooldownMs: 60 * 1000 },
  play: { label: '玩耍', cooldownMs: 15 * 60 * 1000 },
};

/**
 * 确认键的 6 种抚摸动作，按 petCount 依次循环。
 * {name} 会被宠物名字替换；效果相同（心情+8 经验+5），只有台词不同。
 */
export const PET_VARIANTS = [
  { label: '摸摸头', message: '你摸了摸{name}的头，它把脑袋往你手心里拱，尾巴摇个不停。' },
  { label: '挠下巴', message: '你挠了挠{name}的下巴，它舒服地眯起眼睛，喉咙里咕噜咕噜响。' },
  { label: '顺顺毛', message: '你顺着{name}的背毛从头摸到尾，它把身子拉得长长的，好不享受。' },
  { label: '揉肚皮', message: '你轻轻揉了揉{name}的肚皮，它四脚朝天翻过来，尾巴甩成一朵花。' },
  { label: '击个掌', message: '你握了握{name}抬起的小爪子，它轻轻回握，眼睛亮晶晶。' },
  { label: '挠耳后', message: '你在{name}耳后轻轻挠了挠，它后腿一蹬，差点原地蹦起来。' },
];

/** 喂食的 6 种花样，art 对应 render.js 里 drawActionArt 的图案 key */
export const FEED_VARIANTS = [
  { label: '吃肉干', art: 'jerky', message: '{name} 两口吞掉了肉干，还意犹未尽地舔了舔碗边。' },
  { label: '添狗粮', art: 'bowl', message: '你给{name}添了满满一碗狗粮，它埋头吃得咔哧作响。' },
  { label: '小鱼干', art: 'fish', message: '{name} 叼起小鱼干先跑了一圈，才舍得慢慢享用。' },
  { label: '吃苹果', art: 'apple', message: '你把苹果切成小块，{name}挑挑拣拣还是吃光了每一块。' },
  { label: '啃骨头', art: 'bone', message: '{name} 抱着磨牙骨啃了半天，尾巴一直翘得老高。' },
  { label: '小饼干', art: 'cookie', message: '你递过一块饼干，{name}用鼻子顶了顶你的手才接过去。' },
];

/** 玩耍的 6 种花样，art 同上 */
export const PLAY_VARIANTS = [
  { label: '追毛线', art: 'yarn', message: '{name} 追着毛线球跑了三圈，尾巴翘得很高。' },
  { label: '接飞盘', art: 'frisbee', message: '你掷出飞盘，{name}一个箭步跃起稳稳接住。' },
  { label: '扑蝴蝶', art: 'butterfly', message: '{name} 追着一只蝴蝶蹦蹦跳跳，差点撞进花丛里。' },
  { label: '捡网球', art: 'tennis', message: '你把网球滚出去，{name}飞奔叼回来放在你脚边。' },
  { label: '拔河绳', art: 'rope', message: '{name} 咬着绳结另一头和你拔河，哼哧哼哧互不相让。' },
  { label: '顶泡泡', art: 'bubble', message: '你吹出一串泡泡，{name}跳起来一个一个顶破。' },
];

/** 互动后卡片上显示动作台词与图案的时长 */
export const REACTION_MS = 2 * 60 * 1000;

/** 取最近一次互动（2 分钟内），卡片据此显示动作图案与台词 */
export function recentAction(state, now = Date.now()) {
  const at = state.lastAction?.at ? new Date(state.lastAction.at).getTime() : 0;
  const since = now - at;
  if (!at || since < 0 || since >= REACTION_MS) return null;
  return state.lastAction;
}

const HOUR = 3600 * 1000;
const MAX_OFFLINE_HOURS = 24 * 14; // 最多补算两周
const LOG_LIMIT = 40;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round1 = (value) => Math.round(value * 10) / 10;

function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayStart(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function createState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    name: DEFAULT_NAME,
    bornAt: new Date(now).toISOString(),
    lastTick: now,
    exp: 0,
    hunger: 80,
    mood: 80,
    energy: 80,
    streak: 0,
    lastCareDay: null,
    cooldowns: {},
    log: [{ at: new Date(now).toISOString(), text: '来到了这块屏幕。' }],
  };
}

/** 经验等级：前期升得快，后期变慢；上限 99 级 */
export function levelOf(exp) {
  const value = Math.max(0, Number(exp) || 0);
  return Math.min(99, 1 + Math.floor(Math.sqrt(value / 6)));
}

/** 当前等级内的进度与升级所需经验 */
export function levelProgress(exp) {
  const level = levelOf(exp);
  if (level >= 99) return { level, percent: 100, current: 0, need: 0 };
  const start = 6 * (level - 1) ** 2;
  const next = 6 * level ** 2;
  const current = Math.max(0, exp - start);
  const need = Math.max(1, next - start);
  return { level, percent: Math.round((current / need) * 100), current: Math.round(current), need: Math.round(need) };
}

export function stageOf(bornAt, now = Date.now()) {
  const days = Math.max(0, (now - new Date(bornAt).getTime()) / (24 * HOUR));
  let stage = STAGES[0];
  for (const item of STAGES) if (days >= item.days) stage = item;
  return { ...stage, ageDays: Math.floor(days) };
}

/** 阶段内部的下一个阶段，用于页面展示「还有几天长大」 */
export function nextStageOf(bornAt, now = Date.now()) {
  const days = Math.max(0, (now - new Date(bornAt).getTime()) / (24 * HOUR));
  return STAGES.find((item) => item.days > days) ?? null;
}

/**
 * 把状态结算到 now：衰减、被动经验、升级日志。
 * 返回新对象，不修改入参（测试与并发读都更安全）。
 */
export function applyTick(state, now = Date.now()) {
  const last = Number(state.lastTick) || now;
  const hours = clamp((now - last) / HOUR, 0, MAX_OFFLINE_HOURS);
  if (hours <= 0) return state;

  const previousLevel = levelOf(state.exp);
  const starving = state.hunger < 20;
  const tired = state.energy < 20;

  let hunger = clamp(state.hunger - 3 * hours, 0, 100);
  let energy = clamp(state.energy - 1.6 * hours, 0, 100);
  // 饿了会额外消耗心情；困了也会
  let mood = clamp(state.mood - hours * (1.2 + (starving ? 0.8 : 0) + (tired ? 0.5 : 0)), 0, 100);
  // 自主成长：吃得饱时长得多，饿肚子时也会长，只是慢一半
  const exp = (Number(state.exp) || 0) + (starving ? 1 : 2) * hours;

  const log = [...state.log];
  const level = levelOf(exp);
  if (level > previousLevel) {
    log.push({ at: new Date(now).toISOString(), text: `升到了 Lv.${level}。` });
  }

  return {
    ...state,
    hunger: round1(hunger),
    mood: round1(mood),
    energy: round1(energy),
    exp: round1(exp),
    lastTick: now,
    log: log.slice(-LOG_LIMIT),
  };
}

/**
 * 执行互动。冷却与体力不足都返回 { ok:false, error }，不改状态。
 * @returns {{ok:boolean, error?:string, state:object, message?:string}}
 */
export function performAction(state, action, now = Date.now()) {
  const config = ACTIONS[action];
  if (!config) return { ok: false, error: '未知的互动', state };

  const readyAt = Number(state.cooldowns?.[action]) || 0;
  if (readyAt > now) {
    const seconds = Math.ceil((readyAt - now) / 1000);
    const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
    return { ok: false, error: `刚${config.label}过，${wait}后再来哦`, state };
  }
  if (action === 'play' && state.energy < 10) {
    return { ok: false, error: '它太累了，先让它歇一会儿', state };
  }

  let next = { ...state };
  let message = '';
  if (action === 'feed') {
    const variant = FEED_VARIANTS[(Number(state.feedCount) || 0) % FEED_VARIANTS.length];
    next.feedCount = (Number(state.feedCount) || 0) + 1;
    next.hunger = clamp(next.hunger + 20, 0, 100);
    next.mood = clamp(next.mood + 4, 0, 100);
    next.exp = (Number(next.exp) || 0) + 12;
    message = variant.message.replace('{name}', next.name);
    next.lastArt = variant.art;
    next.lastLabel = variant.label;
  } else if (action === 'pet') {
    // 6 种抚摸动作依次循环：第 1 次摸头、第 2 次挠下巴……第 7 次又回到摸头
    const variant = PET_VARIANTS[(Number(state.petCount) || 0) % PET_VARIANTS.length];
    next.petCount = (Number(state.petCount) || 0) + 1;
    next.mood = clamp(next.mood + 8, 0, 100);
    next.exp = (Number(next.exp) || 0) + 5;
    message = variant.message.replace('{name}', next.name);
    next.lastArt = null;
    next.lastLabel = variant.label;
  } else {
    const variant = PLAY_VARIANTS[(Number(state.playCount) || 0) % PLAY_VARIANTS.length];
    next.playCount = (Number(state.playCount) || 0) + 1;
    next.mood = clamp(next.mood + 14, 0, 100);
    next.hunger = clamp(next.hunger - 4, 0, 100);
    next.energy = clamp(next.energy - 8, 0, 100);
    next.exp = (Number(next.exp) || 0) + 15;
    message = variant.message.replace('{name}', next.name);
    next.lastArt = variant.art;
    next.lastLabel = variant.label;
  }

  // 连续照顾天数：断一天就重新计数
  const today = dayKey(now);
  if (state.lastCareDay !== today) {
    const gapDays = state.lastCareDay
      ? Math.round((dayStart(now) - dayStart(new Date(state.lastCareDay).getTime())) / (24 * HOUR))
      : null;
    next.streak = gapDays === 1 ? (state.streak || 0) + 1 : 1;
    next.lastCareDay = today;
  }

  const previousLevel = levelOf(state.exp);
  if (levelOf(next.exp) > previousLevel) {
    next.log = [...next.log, { at: new Date(now).toISOString(), text: `升到了 Lv.${levelOf(next.exp)}。` }];
  }
  next.log = [...next.log, { at: new Date(now).toISOString(), text: message }].slice(-LOG_LIMIT);
  next.cooldowns = { ...next.cooldowns, [action]: now + config.cooldownMs };
  // 记下最近一次互动，出图时据此临时换成「说话/超开心」的表情
  next.lastAction = { at: new Date(now).toISOString(), action };
  next.lastTick = now;
  return { ok: true, state: next, message };
}

/** 根据当前状态生成一句「它正在做什么」，随昼夜与数值变化 */
export function moodLine(state, now = Date.now()) {
  const hour = new Date(now).getHours();
  if (state.energy < 20) return '困得睁不开眼，趴在屏幕角落打盹。';
  if (state.hunger < 20) return '肚子咕咕叫，正在翻零食袋。';
  if (state.mood < 25) return '有点低落，把尾巴收了起来。';
  if (hour < 8) return '刚醒，在窗边伸了个懒腰。';
  if (hour >= 23) return '蜷成一团，睡得正沉。';
  const lines = [
    '在屏幕边上看云，尾巴一晃一晃。',
    '守着你推过来的每一张卡片。',
    '把今天的阳光晒进了毛发里。',
    '安静地趴着，偶尔抬头看看你。',
    '刚巡视完自己的小领地，很满意。',
  ];
  const index = Math.floor((now - new Date(state.bornAt).getTime()) / (24 * HOUR)) % lines.length;
  return lines[Math.max(0, index)];
}

/** 把磁盘上的旧状态补齐成当前版本；坏数据退回新建 */
export function normalizeState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return createState(now);
  const base = createState(now);
  const state = {
    ...base,
    ...raw,
    cooldowns: { ...(raw.cooldowns ?? {}) },
    log: Array.isArray(raw.log) ? raw.log.filter((item) => item && item.text).slice(-LOG_LIMIT) : base.log,
  };
  state.version = STATE_VERSION;
  if (!state.bornAt || Number.isNaN(new Date(state.bornAt).getTime())) state.bornAt = base.bornAt;
  if (!state.name) state.name = DEFAULT_NAME;
  for (const key of ['hunger', 'mood', 'energy']) {
    state[key] = clamp(Number(state[key]) || 0, 0, 100);
  }
  state.exp = Math.max(0, Number(state.exp) || 0);
  state.streak = Math.max(0, Number(state.streak) || 0);
  state.petCount = Math.max(0, Math.floor(Number(state.petCount) || 0));
  state.feedCount = Math.max(0, Math.floor(Number(state.feedCount) || 0));
  state.playCount = Math.max(0, Math.floor(Number(state.playCount) || 0));
  state.lastTick = Number(state.lastTick) || now;
  return state;
}

/** 页面与徽章共用的一组派生信息 */
export function describeState(state, now = Date.now()) {
  const stage = stageOf(state.bornAt, now);
  const next = nextStageOf(state.bornAt, now);
  const progress = levelProgress(state.exp);
  return {
    stage: stage.name,
    stageKey: stage.key,
    ageDays: stage.ageDays,
    nextStage: next ? { name: next.name, days: next.days } : null,
    level: progress.level,
    levelPercent: progress.percent,
    levelCurrent: progress.current,
    levelNeed: progress.need,
    moodLine: moodLine(state, now),
    cooldowns: Object.fromEntries(
      Object.entries(ACTIONS).map(([key, item]) => {
        const readyAt = Number(state.cooldowns?.[key]) || 0;
        return [key, Math.max(0, readyAt - now)];
      }),
    ),
  };
}

export { dayKey };
