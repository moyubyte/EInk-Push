// 「今天吃什么」的候选菜与随机逻辑。
// 数据与随机抽选分开，方便单测；设备渲染与网页都只依赖这里的结构。

export const DISHES = [
  // 面食
  { name: '兰州牛肉面', category: '面食', note: '一清二白三红四绿，汤要喝到最后一口' },
  { name: '重庆小面', category: '面食', note: '麻辣鲜香，早起也值得' },
  { name: '武汉热干面', category: '面食', note: '芝麻酱拌开，才是武汉的早晨' },
  { name: '油泼面', category: '面食', note: '热油浇上去的那一声，最治愈' },
  { name: '番茄鸡蛋面', category: '面食', note: '冰箱里总有的安全感' },
  { name: '馄饨', category: '面食', note: '薄皮裹着汤，慢慢吃完' },

  // 米饭
  { name: '黄焖鸡米饭', category: '米饭', note: '酱汁拌饭，碳水加倍' },
  { name: '扬州炒饭', category: '米饭', note: '粒粒分明，配一碗紫菜汤' },
  { name: '煲仔饭', category: '米饭', note: '锅巴是灵魂，腊味是理由' },
  { name: '卤肉饭', category: '米饭', note: '一勺卤汁，安慰整个下午' },
  { name: '石锅拌饭', category: '米饭', note: '拌到锅底发出声响' },

  // 火锅
  { name: '麻辣火锅', category: '火锅', note: '鸭肠七上八下，毛肚十秒' },
  { name: '番茄锅', category: '火锅', note: '不辣星人的体面选择' },
  { name: '潮汕牛肉火锅', category: '火锅', note: '八秒吊龙，趁热吃' },
  { name: '椰子鸡', category: '火锅', note: '先喝汤，再涮肉' },

  // 烧烤
  { name: '羊肉串', category: '烧烤', note: '孜然一撒，夜晚才开始' },
  { name: '烤五花肉', category: '烧烤', note: '生菜一卷，烦恼减半' },
  { name: '烤茄子', category: '烧烤', note: '蒜蓉铺满，别客气' },
  { name: '烤鱼', category: '烧烤', note: '底下还藏着豆芽和藕片' },

  // 家常菜
  { name: '番茄炒蛋', category: '家常菜', note: '先炒蛋还是先炒番茄，都行' },
  { name: '麻婆豆腐', category: '家常菜', note: '麻辣烫嘴，米饭遭殃' },
  { name: '宫保鸡丁', category: '家常菜', note: '酸甜微辣，永不踩雷' },
  { name: '红烧肉', category: '家常菜', note: '小火收汁，等得越久越香' },
  { name: '酸辣土豆丝', category: '家常菜', note: '脆一点，再脆一点' },

  // 快餐
  { name: '汉堡薯条', category: '快餐', note: '快乐套餐，偶尔就好' },
  { name: '炸鸡', category: '快餐', note: '外皮酥脆，配冰可乐' },
  { name: '麻辣烫', category: '快餐', note: '自己选的菜，含泪也要吃完' },
  { name: '便利店关东煮', category: '快餐', note: '深夜的温柔，萝卜要多煮一会' },

  // 轻食
  { name: '鸡胸沙拉', category: '轻食', note: '吃完感觉自己很自律' },
  { name: '牛油果吐司', category: '轻食', note: '拍照五分钟，吃完两分钟' },
  { name: '荞麦冷面', category: '轻食', note: '酸酸甜甜，夏天续命' },

  // 汤粥
  { name: '皮蛋瘦肉粥', category: '汤粥', note: '胃不舒服时的首选' },
  { name: '胡辣汤', category: '汤粥', note: '一碗下肚，整个人都醒了' },
  { name: '牛肉汤', category: '汤粥', note: '配饼丝，汤要滚烫' },
  { name: '疙瘩汤', category: '汤粥', note: '小时候的味道，暖胃' },

  // 西餐
  { name: '番茄意面', category: '西餐', note: '红酱裹面，撒点芝士' },
  { name: '煎牛排', category: '西餐', note: '五分熟，配黑胡椒' },
  { name: '西班牙海鲜饭', category: '西餐', note: '锅底那层焦香别浪费' },

  // 日韩
  { name: '寿司', category: '日韩', note: '一口一个，慢慢来' },
  { name: '豚骨拉面', category: '日韩', note: '汤浓面硬，加个溏心蛋' },
  { name: '天妇罗', category: '日韩', note: '刚出锅的最好吃' },
  { name: '部队锅', category: '日韩', note: '泡面压轴，芝士收尾' },
];

/** 分类顺序按数据首次出现排列，方便页面展示 */
export const CATEGORIES = [...new Set(DISHES.map((dish) => dish.category))];

/**
 * 随机抽下一道菜：尽量不和当前这道重复。
 * @param {Array<{name: string}>} dishes 候选列表
 * @param {string|null} currentName 当前菜名，用于排除
 * @param {() => number} random 随机源，测试里可注入固定值
 */
export function pickNext(dishes, currentName = null, random = Math.random) {
  if (!Array.isArray(dishes) || dishes.length === 0) {
    throw new Error('候选菜单为空');
  }
  const pool = dishes.length > 1
    ? dishes.filter((dish) => dish.name !== currentName)
    : dishes;
  const list = pool.length ? pool : dishes;
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[index];
}

/** 每个分类有多少道，页面用来展示「共 44 道」 */
export function categoryStats(dishes = DISHES) {
  const counts = {};
  for (const dish of dishes) counts[dish.category] = (counts[dish.category] ?? 0) + 1;
  return CATEGORIES.filter((category) => counts[category]).map((category) => ({
    category,
    count: counts[category],
  }));
}
