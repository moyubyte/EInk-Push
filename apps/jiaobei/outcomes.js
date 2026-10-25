// 掷杯筊的两块杯筊各掷一次，按「哪一面朝上」的组合定结果。
//
// 每块落地的两面天生各占一半，所以传统概率是：
//   圣筊（一平一凸）1/2、笑筊（双平面朝上）1/4、阴筊（双凸面朝上）1/4。
// 概率不额外加权，随机源可注入，测试里用固定序列就能稳定复现三种结果。

export const FACES = {
  FLAT: 'flat', // 平面朝上
  CONVEX: 'convex', // 凸面朝上
};

export const OUTCOMES = {
  sheng: {
    key: 'sheng',
    name: '圣筊',
    faces: [FACES.CONVEX, FACES.FLAT],
    faceNote: '一平一凸',
    verdict: '神明应允，放手去做。',
  },
  xiao: {
    key: 'xiao',
    name: '笑筊',
    faces: [FACES.FLAT, FACES.FLAT],
    faceNote: '双平面朝上',
    verdict: '笑而不答，把话说清再问一次。',
  },
  yin: {
    key: 'yin',
    name: '阴筊',
    faces: [FACES.CONVEX, FACES.CONVEX],
    faceNote: '双凸面朝上',
    verdict: '暂未应允，缓一缓再问。',
  },
};

/** 由两块杯筊的朝向反推结果；两块顺序即画面左右 */
export function outcomeFor(faces) {
  const flats = faces.filter((face) => face === FACES.FLAT).length;
  if (flats === 2) return OUTCOMES.xiao;
  if (flats === 1) return OUTCOMES.sheng;
  return OUTCOMES.yin;
}

/**
 * 掷一次：每块 50/50，得到圣筊 / 笑筊 / 阴筊。
 * @param {() => number} [random] 随机源（返回 [0,1)）
 */
export function throwJiaobei(random = Math.random) {
  const faces = [0, 1].map(() => (random() < 0.5 ? FACES.FLAT : FACES.CONVEX));
  return outcomeFor(faces);
}
