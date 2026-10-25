// 今天的数据层：天气 / 空气质量 / 黄历 / 节假日 / 月历 / 历史上的今天，全部带降级。
//
// 数据来源：
//   天气        open-meteo（或和风天气）
//   空气质量    open-meteo air-quality
//   黄历        全民万年历（cheerio 解析）
//   节假日      timor.tech
//   穿搭        日柱纳音 → 五行生克 → 五色
//
// 实现说明：
//   1. 日柱与节气本地计算：用儒略日推算干支（已用 6 个日期与万年历逐日核对一致），
//      用太阳视黄经求解节气，不依赖网络。
//   2. 月历网格也由本地历法生成，不依赖任何接口。
//   3. 历史上的今天取自百度百科的按日静态 JSON，支持任意月日；失败时返回空数组由渲染层降级。
//   4. 网络失败一律给降级值并记录告警，不让一张图因为某个数据源挂掉而推不出去。

import * as cheerio from 'cheerio';
import { InvalidInput } from '../../src/errors.js';
import { fetchJson, fetchText, safeFetch } from '../shared/http.js';

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** WMO 天气代码 → 中文描述 */
export const WEATHER = {
  0: '晴', 1: '晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾',
  51: '小雨', 53: '小雨', 55: '中雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨',
  81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪', 95: '雷雨',
  96: '雷雨', 99: '雷雨',
};

export const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
export const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

/** 六十甲子纳音（每两个干支共用一个纳音，末字即五行） */
const NAYIN = [
  '海中金', '炉中火', '大林木', '路旁土', '剑锋金',
  '山头火', '涧下水', '城头土', '白蜡金', '杨柳木',
  '泉中水', '屋上土', '霹雳火', '松柏木', '长流水',
  '沙中金', '山下火', '平地木', '壁上土', '金箔金',
  '覆灯火', '天河水', '大驿土', '钗钏金', '桑柘木',
  '大溪水', '沙中土', '天上火', '石榴木', '大海水',
];

/** 五行 → 穿搭色 */
const ELEMENT_COLORS = {
  木: ['绿色', '青色'],
  火: ['红色', '粉色', '橙色', '紫色'],
  土: ['黄色', '咖啡色'],
  金: ['白色', '银色'],
  水: ['黑色', '浅蓝色', '深蓝色'],
};

/** 生我（印）/ 我生（食伤）/ 我克（财）/ 克我（官杀） */
const GENERATES = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const OVERCOMES = { 木: '土', 火: '金', 土: '水', 金: '木', 水: '火' };
const GENERATED_BY = { 火: '木', 土: '火', 金: '土', 水: '金', 木: '水' };
const OVERCOME_BY = { 土: '木', 金: '火', 水: '土', 木: '金', 火: '水' };

export function windLevel(kmh) {
  const thresholds = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
  const speed = Number(kmh) || 0;
  let level = 0;
  for (const threshold of thresholds) {
    if (speed >= threshold) level++;
    else break;
  }
  return level;
}

export function aqiLevel(aqi) {
  const value = Number(aqi) || 0;
  if (value <= 50) return '优';
  if (value <= 100) return '良';
  if (value <= 150) return '轻度';
  if (value <= 200) return '中度';
  if (value <= 300) return '重度';
  return '严重';
}

/** 用 Intl 取指定时区的「今天」，避免 NAS 的 TZ 与用户所在时区不一致 */
export function todayInZone(timeZone = 'Asia/Shanghai', now = new Date()) {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [year, month, day] = text.split('-').map(Number);
  return { year, month, day };
}

/**
 * 解析 YYYY-MM-DD。
 * 除格式外还要校验范围与真实存在（`2026-13-99`、`2026-02-30` 都必须拒掉），
 * 因为这是 Web 接口的入参，非法值一路传下去会在图里画出「13 月 99 日」这种内容。
 */
export function parseDate(text) {
  const match = String(text).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new InvalidInput(`日期格式应为 YYYY-MM-DD，收到 ${text}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999) throw new InvalidInput(`日期超出支持范围: ${text}`);
  if (month < 1 || month > 12) throw new InvalidInput(`月份不合法: ${text}`);
  if (day < 1 || day > 31) throw new InvalidInput(`日期不合法: ${text}`);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new InvalidInput(`日期不存在: ${text}`);
  }
  return { year, month, day };
}

export function addDays({ year, month, day }, delta) {
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function formatDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 星期几的中文（一…日） */
export function weekdayOf({ year, month, day }) {
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7];
}

function julianDay({ year, month, day }) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y
    + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

/**
 * 日柱干支。指数由儒略日推算：idx = (JDN + 49) % 60。
 * 该常数用 2023-12-31 / 2024-02-10 / 2025-05-05 / 2026-01-01 / 2026-03-08 / 2026-10-22
 * 六个日期与全民万年历逐日核对，全部一致。
 */
export function dayPillar({ year, month, day }) {
  const index = ((julianDay({ year, month, day }) + 49) % 60 + 60) % 60;
  return STEMS[index % 10] + BRANCHES[index % 12];
}

/** 日柱 → 纳音（如 己巳 → 大林木） */
export function nayinOf(pillar) {
  const stem = STEMS.indexOf(pillar[0]);
  const branch = BRANCHES.indexOf(pillar[1]);
  if (stem < 0 || branch < 0) return null;
  for (let index = 0; index < 60; index++) {
    if (index % 10 === stem && index % 12 === branch) return NAYIN[Math.floor(index / 2)];
  }
  return null;
}

const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
];

const RAD = Math.PI / 180;

/** 太阳视黄经（Meeus 低精度公式，误差 < 0.01°） */
function sunLongitude(julian) {
  const t = (julian - 2451545) / 36525;
  const meanLongitude = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const meanAnomaly = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * RAD;
  const center = (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(meanAnomaly)
    + (0.019993 - 0.000101 * t) * Math.sin(2 * meanAnomaly)
    + 0.000289 * Math.sin(3 * meanAnomaly);
  const omega = (125.04 - 1934.136 * t) * RAD;
  const lambda = meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega);
  return ((lambda % 360) + 360) % 360;
}

function jdFromUtcMs(ms) {
  return ms / 86400000 + 2440587.5;
}

function utcMsFromJd(jd) {
  return (jd - 2440587.5) * 86400000;
}

/** 求今年第 n 个节气（n=0 小寒 … 23 冬至）的北京时间 */
function solveTerm(year, n) {
  const target = (285 + 15 * n) % 360;
  // 起点：用 n 的大致日期，保证牛顿迭代收敛到今年的那一次穿越
  let jd = jdFromUtcMs(Date.UTC(year, 0, 1) + n * 15.2 * 86400000);
  for (let i = 0; i < 8; i++) {
    const diff = ((target - sunLongitude(jd) + 540) % 360) - 180;
    jd += (diff * 365.2422) / 360;
  }
  return utcMsFromJd(jd) + 8 * 3600 * 1000; // 转成北京时间
}

/** 一年的 24 个节气（北京时间日期，按时间升序） */
export function solarTerms(year) {
  const terms = TERM_NAMES.map((name, n) => {
    const ms = solveTerm(year, n);
    const date = new Date(ms);
    return {
      name,
      date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
      ms,
    };
  });
  return terms.sort((a, b) => a.ms - b.ms);
}

/** 某日所属的「上节气 / 下节气」（跨年时自动取相邻年份的表） */
export function termPair(dateLike) {
  const text = typeof dateLike === 'string' ? dateLike : formatDate(dateLike);
  const { year } = parseDate(text);
  const all = [...solarTerms(year - 1), ...solarTerms(year), ...solarTerms(year + 1)];
  let prev = null;
  let next = null;
  for (const term of all) {
    if (term.date <= text) prev = term;
    else {
      next = term;
      break;
    }
  }
  return { prev: prev?.name ?? null, next: next?.name ?? null };
}

/**
 * 五行穿衣：由日柱纳音取五行，再按生克推五色。
 * 贵 = 生我（印）、合 = 同我（比）、财 = 我克（财）、耗 = 我生（食伤）、忌 = 克我（官杀）。
 */
export function computeClothing(pillar) {
  const nayin = nayinOf(pillar);
  if (!nayin) return { nayin: null, element: null, colors: {} };
  const element = nayin.slice(-1);
  const colors = {
    贵: ELEMENT_COLORS[GENERATED_BY[element]] || [],
    合: ELEMENT_COLORS[element] || [],
    财: ELEMENT_COLORS[OVERCOMES[element]] || [],
    耗: ELEMENT_COLORS[GENERATES[element]] || [],
    忌: ELEMENT_COLORS[OVERCOME_BY[element]] || [],
  };
  return { nayin, element, colors };
}

/** 天气：有和风 Key 走和风天气，否则用 open-meteo */
export async function fetchWeather(location, options = {}) {
  const {
    tomorrow = false,
    log = console.warn,
    qweatherKey = '',
    qweatherHost = '',
  } = options;

  const fallback = () => ({
    date: null, forecast: tomorrow, code: 0, condition: '数据暂不可用', current: 0, feels: 0,
    humidity: 0, high: 0, low: 0, rainProbability: 0, windSpeed: 0, windDirection: 0,
    isDay: true, sunrise: '--:--', sunset: '--:--', hourlyTemperatures: [],
  });

  const key = qweatherKey;
  if (key) {
    try {
      return await fetchQWeather(location, {
        tomorrow,
        key,
        host: qweatherHost || 'devapi.qweather.com',
        log,
      });
    } catch (err) {
      // 和风挂了（Key 无效 / 额度用尽 / 网络不通）就退回免费的 Open-Meteo，别把整张图拖空
      log(`和风天气不可用，改用 Open-Meteo: ${String(err?.message || err)}`);
    }
  }

  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    timezone: location.timezone || 'Asia/Shanghai',
    forecast_days: tomorrow ? '2' : '1',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset',
    hourly: 'temperature_2m',
  });
  if (!tomorrow) {
    params.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day');
  }

  return safeFetch(async () => {
    const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
    const index = tomorrow ? 1 : 0;
    const daily = data.daily ?? {};
    const current = data.current ?? {};
    const high = Math.round(daily.temperature_2m_max?.[index] ?? 0);
    const low = Math.round(daily.temperature_2m_min?.[index] ?? 0);
    const code = Number(tomorrow ? daily.weather_code?.[index] : (current.weather_code ?? daily.weather_code?.[0])) || 0;
    const hours = (data.hourly?.temperature_2m ?? [])
      .slice(index * 24, index * 24 + 24)
      .map((value) => Math.round(value));

    return {
      date: daily.time?.[index] ?? null,
      forecast: tomorrow,
      code,
      condition: WEATHER[code] ?? '未知',
      current: tomorrow ? high : Math.round(current.temperature_2m ?? high),
      feels: tomorrow ? high : Math.round(current.apparent_temperature ?? high),
      humidity: Math.round(tomorrow ? 0 : (current.relative_humidity_2m ?? 0)),
      high,
      low,
      rainProbability: Math.round(daily.precipitation_probability_max?.[index] ?? 0),
      windSpeed: Math.round(tomorrow ? 0 : (current.wind_speed_10m ?? 0)),
      windDirection: Math.round(tomorrow ? 0 : (current.wind_direction_10m ?? 0)),
      isDay: tomorrow ? true : current.is_day !== 0,
      sunrise: (daily.sunrise?.[index] ?? '').slice(11, 16) || '--:--',
      sunset: (daily.sunset?.[index] ?? '').slice(11, 16) || '--:--',
      hourlyTemperatures: hours,
      source: 'open-meteo',
    };
  }, fallback, { label: '天气', log });
}

export async function fetchAirQuality(location, options = {}) {
  const { log = console.warn } = options;
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: 'us_aqi,pm2_5,pm10',
  });
  return safeFetch(async () => {
    const data = await fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`);
    const current = data.current ?? {};
    const aqi = Math.round(current.us_aqi ?? 0);
    return {
      aqi,
      level: aqiLevel(aqi),
      pm25: Math.round((current.pm2_5 ?? 0) * 10) / 10,
      pm10: Math.round((current.pm10 ?? 0) * 10) / 10,
    };
  }, { aqi: 0, level: '数据暂不可用', pm25: 0, pm10: 0 }, { label: '空气质量', log });
}

const pickText = ($, selector) => {
  const node = $(selector).first();
  return node.length ? node.text().replace(/\s+/g, ' ').trim() : '';
};

const listItems = ($, selector) =>
  $(`${selector} li`).map((_, node) => $(node).text().trim()).get().filter(Boolean);

/**
 * 黄历：全民万年历页面。
 * 页面是 Next.js 渲染的，类名带哈希（如 lunar_good__p_6H5），
 * 所以统一用 [class*=lunar_good] 这类前缀选择器，避免哈希变化就整块失效。
 */
export async function fetchAlmanac(dateLike, options = {}) {
  const { log = console.warn } = options;
  const date = typeof dateLike === 'string' ? parseDate(dateLike) : dateLike;
  const url = `https://www.qmrl888.com/${date.year}-${date.month}-${date.day}.html`;
  const pillar = dayPillar(date);
  const fallback = () => ({
    lunar: null,
    pillar,
    valueGod: null,
    nayin: nayinOf(pillar),
    buildDay: null,
    yi: [],
    ji: [],
    source: 'local',
  });

  return safeFetch(async () => {
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const body = $('body').text().replace(/\s+/g, ' ');

    // 农历：优先 lunar_lunardate（"农历 二〇二六年 马年 九月十三"），退化为正则
    let lunar = null;
    const lunarText = pickText($, '[class*="lunar_lunardate"]');
    const lunarMatch = lunarText.match(/([正冬腊]月[初十廿][一二三四五六七八九十]?|\S+月[初十廿][一二三四五六七八九十]?)\s*$/);
    if (lunarMatch) lunar = lunarMatch[1];
    else {
      const alt = body.match(/农历\s*\S+\s*\S+月[\u4e00-\u9fa5]+/);
      if (alt) lunar = alt[0].replace(/^农历\s*/, '').split(' ').pop();
    }

    const extra = pickText($, '[class*="lunar_extra"]');
    const godMatch = extra.match(/值神是\s*([\u4e00-\u9fa5]{2})/);
    // lunar_title 有两个（胎神、五行/建除），取带「五行」的那个
    const titleText = $('[class*="lunar_title"]')
      .map((_, node) => $(node).text().replace(/\s+/g, ' ').trim())
      .get()
      .find((text) => text.includes('五行')) ?? '';
    const titleMatch = titleText.match(/五行[:：]\s*(\S+)\s*(\S)执位/);
    const yi = listItems($, '[class*="lunar_good"]').slice(0, 8);
    const ji = listItems($, '[class*="lunar_bad"]').slice(0, 8);
    if (!lunar && !yi.length && !ji.length) throw new Error('黄历页面结构不认识');

    return {
      lunar,
      pillar,
      valueGod: godMatch ? godMatch[1] : null,
      nayin: titleMatch ? titleMatch[1] : nayinOf(pillar),
      buildDay: titleMatch ? titleMatch[2] : null,
      yi,
      ji,
      source: 'qmrl888',
    };
  }, fallback, { label: '黄历', log, retries: 1 });
}

export async function fetchHoliday(dateLike, options = {}) {
  const { log = console.warn } = options;
  const text = typeof dateLike === 'string' ? dateLike : formatDate(dateLike);
  return safeFetch(async () => {
    const data = await fetchJson(`https://timor.tech/api/holiday/info/${text}`);
    const holiday = data.holiday;
    return {
      label: holiday?.name ? `${holiday.name}` : (data.type?.name ?? '工作日'),
      off: Boolean(holiday?.holiday),
      name: holiday?.name ?? null,
    };
  }, { label: '日期信息未知', off: false, name: null }, { label: '节假日', log, retries: 1 });
}

/** 时区字符串是否可用（Intl 抛错即非法） */
function isTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('sv-SE', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** 把定位结果规整成配置里的 location；坐标不合法时返回 null */
function normalizeLocation({ label, lat, lon, timezone }) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  const name = String(label ?? '').trim();
  return {
    label: (name || '当前位置').slice(0, 20),
    lat: Math.round(latitude * 100) / 100,
    lon: Math.round(longitude * 100) / 100,
    timezone: isTimeZone(timezone) ? timezone.trim() : 'Asia/Shanghai',
  };
}

/**
 * 按「Web 服务所在的网络」自动定位一次。
 *
 * 用的是 NAS/服务进程的出站公网 IP：浏览器访问时是本机内网地址（192.168.x.x），
 * 拿它查不到任何有意义的地点。多个免费数据源顺序尝试，全部失败返回 null 由调用方兜底。
 */
export async function detectLocation(options = {}) {
  const { log = console.warn } = options;
  const parsers = [
    async () => {
      const data = await fetchJson(
        'http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,lat,lon,timezone',
        { timeout: 5000 },
      );
      if (data.status !== 'success') throw new Error(data.message || `status=${data.status}`);
      return { label: data.city || data.regionName || data.country, lat: data.lat, lon: data.lon, timezone: data.timezone };
    },
    async () => {
      const data = await fetchJson('https://api.ip.sb/geoip', { timeout: 5000 });
      return { label: data.city || data.region || data.country, lat: data.latitude, lon: data.longitude, timezone: data.timezone };
    },
    async () => {
      const data = await fetchJson('https://ipapi.co/json/', { timeout: 5000 });
      if (data.error) throw new Error(data.reason || 'ipapi.co 返回错误');
      return { label: data.city || data.region || data.country_name, lat: data.latitude, lon: data.longitude, timezone: data.timezone };
    },
  ];

  for (const parse of parsers) {
    try {
      const location = normalizeLocation(await parse());
      if (location) {
        log(`已按服务所在网络定位：${location.label}（${location.lat}, ${location.lon}）`);
        return location;
      }
    } catch (err) {
      log(`定位数据源不可用: ${String(err?.message || err)}`);
    }
  }
  log('自动定位失败，继续使用默认地点');
  return null;
}

/** 和风天气图标 → WMO 天气代码（渲染层自绘图标按 WMO 代码分类） */
function qweatherCode(icon) {
  const n = Number(icon) || 0;
  if (n >= 100 && n < 200) {
    if (n === 104) return 3; // 阴
    if (n === 101 || n === 151) return 2; // 多云
    return 1; // 晴 / 少云 / 晴间多云
  }
  if (n >= 300 && n < 400) return n === 302 || n === 303 ? 95 : 61; // 雷阵雨 / 雨
  if (n >= 400 && n < 500) return 71; // 雪
  if (n >= 500 && n < 600) return 45; // 雾霾沙尘
  return 3;
}

const isNightIcon = (icon) => Number(icon) >= 150 && Number(icon) <= 153;

/** QWeather 时间形如 "06:31"，也可能是 ISO 串，统一取 HH:mm */
function clockText(value) {
  const match = String(value ?? '').match(/(\d{1,2}:\d{2})/);
  if (!match) return '--:--';
  const [hour, minute] = match[1].split(':');
  return `${hour.padStart(2, '0')}:${minute}`;
}

/**
 * 和风天气：3d 预报 + now 实况 + 24h 逐时，字段对齐 open-meteo 版本，
 * 渲染层不需要区分数据源。文档 https://dev.qweather.com/docs/api/weather/
 */
async function fetchQWeather(location, options = {}) {
  const { tomorrow = false, key, host = 'devapi.qweather.com', log = console.warn } = options;
  const base = `https://${String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const place = `${Number(location.lon).toFixed(2)},${Number(location.lat).toFixed(2)}`;
  const get = async (path, required = true) => {
    try {
      const data = await fetchJson(
        `${base}${path}?location=${encodeURIComponent(place)}&key=${encodeURIComponent(key)}`,
        { timeout: 8000 },
      );
      if (data.code !== '200') throw new Error(`code=${data.code}${data.code === '401' ? '（Key 无效）' : ''}`);
      return data;
    } catch (err) {
      if (required) throw err;
      log(`和风天气 ${path} 不可用: ${String(err?.message || err)}`);
      return null;
    }
  };

  const forecast = await get('/v7/weather/3d');
  const now = tomorrow ? null : await get('/v7/weather/now', false);
  const hourly = await get('/v7/weather/24h', false);

  const index = tomorrow ? 1 : 0;
  const day = forecast.daily?.[index] ?? forecast.daily?.[0] ?? {};
  const current = now ?? {};
  const hours = hourly?.hourly ?? [];
  const icon = Number(current.icon ?? day.iconDay);
  const high = Math.round(Number(day.tempMax ?? 0));
  const low = Math.round(Number(day.tempMin ?? 0));

  return {
    date: day.fxDate ?? null,
    forecast: tomorrow,
    code: qweatherCode(icon),
    condition: String(current.text ?? day.textDay ?? '未知'),
    current: tomorrow ? high : Math.round(Number(current.temp ?? high)),
    feels: tomorrow ? high : Math.round(Number(current.feelsLike ?? high)),
    humidity: tomorrow ? 0 : Math.round(Number(current.humidity ?? 0)),
    high,
    low,
    rainProbability: tomorrow
      ? 0
      : hours.reduce((max, item) => Math.max(max, Number(item.pop) || 0), 0),
    windSpeed: tomorrow ? 0 : Math.round(Number(current.windSpeed ?? 0)),
    windDirection: tomorrow ? 0 : Math.round(Number(current.wind360 ?? 0)),
    isDay: tomorrow ? true : !isNightIcon(icon),
    sunrise: clockText(day.sunrise),
    sunset: clockText(day.sunset),
    hourlyTemperatures: tomorrow
      ? []
      : hours.map((item) => Math.round(Number(item.temp))).filter(Number.isFinite),
    source: 'qweather',
  };
}

/**
 * 城市名 → 经纬度/时区。
 * 配了和风 Key 就走 GeoAPI（中文城市名最准），否则用 Open-Meteo 免费地理编码。
 */
export async function resolveLocation(name, options = {}) {
  const { key = '', log = console.warn } = options;
  const query = String(name ?? '').trim();
  if (!query) throw new Error('地点名称不能为空');

  if (key) {
    try {
      const data = await fetchJson(
        `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(query)}&number=1&lang=zh&key=${encodeURIComponent(key)}`,
        { timeout: 8000 },
      );
      if (data.code !== '200' || !data.location?.length) {
        throw new Error(data.code === '404' ? '没有匹配的城市' : `code=${data.code}`);
      }
      const city = data.location[0];
      const location = normalizeLocation({ label: city.name, lat: city.lat, lon: city.lon, timezone: city.tz });
      if (location) return location;
    } catch (err) {
      log(`和风天气城市查询失败: ${String(err?.message || err)}`);
    }
  }

  try {
    const data = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`,
      { timeout: 8000 },
    );
    const city = data.results?.[0];
    if (!city) return null;
    return normalizeLocation({
      label: city.name || query,
      lat: city.latitude,
      lon: city.longitude,
      timezone: city.timezone,
    });
  } catch (err) {
    log(`城市查询失败: ${String(err?.message || err)}`);
    return null;
  }
}

function clothingText(weather) {
  if (RAIN_CODES.has(weather.code)) return '有降水可能，建议带伞并穿防水鞋';
  if (weather.low <= 8) return '气温偏低，建议保暖外套，早晚注意防风';
  if (weather.high >= 28) return '天气偏暖，建议轻薄衣物，外出注意防晒';
  return '早晚温差较大，建议长袖/薄卫衣搭配薄外套';
}

/** 某个月的日历网格：周一开头，前后补空格，cells 长度一定是 7 的倍数 */
export function monthGrid(dateLike) {
  const date = typeof dateLike === 'string' ? parseDate(dateLike) : dateLike;
  const offset = WEEKDAYS.indexOf(weekdayOf({ year: date.year, month: date.month, day: 1 }));
  const days = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate();
  const cells = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= days; day++) cells.push(day);
  while (cells.length % 7) cells.push(null);
  return { year: date.year, month: date.month, days, offset, cells };
}

const stripTags = (value) => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/** 百度百科条目 → 渲染层用的精简结构 */
export function parseHistoryEntry(raw = {}) {
  const year = String(raw.year ?? '').trim();
  const digits = year.replace(/[^\d]/g, '');
  return {
    year,
    yearValue: digits ? Number(digits) : 0,
    type: raw.type ?? 'event',
    title: stripTags(raw.title),
    desc: stripTags(raw.desc),
    festival: raw.festival ? stripTags(raw.festival) : null,
  };
}

/**
 * 从一天的全部条目里挑出适合卡片展示的几条：
 * 优先「事件」，不够再用出生/逝世补；只取最靠近现代的两条，避免卡片被古代人物占满。
 */
export function selectHistory(entries, limit = 2) {
  const list = (entries ?? [])
    .filter((item) => item && item.title)
    .map((item, index) => ({ ...item, _order: index }));
  const events = list.filter((item) => item.type === 'event');
  const others = list.filter((item) => item.type !== 'event');
  const picked = events.slice(-limit);
  let cursor = others.length - 1;
  while (picked.length < limit && cursor >= 0) picked.push(others[cursor--]);
  return picked
    .sort((a, b) => (a.yearValue - b.yearValue) || (a._order - b._order))
    .map(({ _order, ...item }) => item);
}

export const HISTORY_SOURCE = '百度百科';

/** 历史上的今天：百度百科按月的静态 JSON，支持任意月日；取不到就返回空数组 */
export async function fetchHistory(dateLike, options = {}) {
  const { log = console.warn, limit = 2 } = options;
  const date = typeof dateLike === 'string' ? parseDate(dateLike) : dateLike;
  const month = String(date.month).padStart(2, '0');
  const key = `${month}${String(date.day).padStart(2, '0')}`;
  return safeFetch(async () => {
    const data = await fetchJson(
      `https://baike.baidu.com/cms/home/eventsOnHistory/${month}.json`,
      { timeout: 12000 },
    );
    const list = data?.[month]?.[key];
    if (!Array.isArray(list) || !list.length) throw new Error(`没有 ${key} 的条目`);
    return selectHistory(list.map(parseHistoryEntry), limit);
  }, [], { label: '历史上的今天', log, retries: 1, delay: 800 });
}

/** 汇总成渲染需要的完整数据结构 */
export async function buildBrief({
  location, date, tomorrow = false, log = console.warn, qweatherKey = '', qweatherHost = '',
}) {
  const target = typeof date === 'string' ? parseDate(date) : date;
  const [weather, air, almanac, holiday, history] = await Promise.all([
    fetchWeather(location, { tomorrow, log, qweatherKey, qweatherHost }),
    fetchAirQuality(location, { log }),
    fetchAlmanac(target, { log }),
    fetchHoliday(target, { log }),
    fetchHistory(target, { log }),
  ]);
  return {
    date: target,
    tomorrow,
    location,
    weather: { ...weather, aqi: air.aqi, aqiLevel: air.level, pm25: air.pm25, pm10: air.pm10 },
    air,
    almanac,
    holiday,
    history,
    clothing: createClothing(almanac, weather),
  };
}

/** 穿搭：五行色 + 文字建议 */
export function createClothing(almanac, weather) {
  const five = computeClothing(almanac.pillar);
  return { ...five, advice: clothingText(weather) };
}

/** 解析后的日期串（YYYY-MM-DD），供渲染标题用 */
export function dateText(date, tomorrow) {
  return `${date.year}年${date.month}月${date.day}日 星期${weekdayOf(date)}${tomorrow ? ' 明日' : ''}`;
}
