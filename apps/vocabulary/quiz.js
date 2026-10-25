// 拼写判定：语音识别回来后，把「一段话」规整成字母序列再比较。
//
// 识别结果常见形态：
//   "apple" / "A P P L E" / "a-p-p-l-e" / "apple." / "apple 苹果"（模型串了中文）
// 统一小写、只保留字母后比较；再用编辑距离区分「差一个字母」与「完全不对」，
// 差一个字母给一次重读机会，而不是直接判错。

export function normalizeSpelling(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** 编辑距离（插入/删除/替换各算 1） */
export function levenshtein(a, b) {
  const left = [...String(a)];
  const right = [...String(b)];
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[right.length];
}

/**
 * 判定一次拼写。
 * @param {string} input 识别文本
 * @param {string} expected 正确拼写
 * @returns {{correct:boolean, near:boolean, empty:boolean, distance:number, got:string, expected:string}}
 */
export function gradeSpelling(input, expected) {
  const target = normalizeSpelling(expected);
  const got = normalizeSpelling(input);
  if (!got) {
    return { correct: false, near: false, empty: true, distance: target.length, got, expected: target };
  }
  const distance = levenshtein(got, target);
  return {
    correct: distance === 0,
    // 差一个字母算「接近」：提示重读，不直接判错
    near: distance > 0 && distance <= 1 && got[0] === target[0],
    empty: false,
    distance,
    got,
    expected: target,
  };
}

/**
 * 逐字母对位显示：正确的字母保留，错的用 × 标记，缺的用 · 占位。
 * 例：expected=apple got=aple → ["a","p","l","e","·"] 用 marks 表示。
 */
export function diffLetters(expected, got) {
  const target = normalizeSpelling(expected);
  const input = normalizeSpelling(got);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < target.length || j < input.length) {
    if (target[i] === input[j]) {
      out.push({ char: target[i], ok: true });
      i++;
      j++;
    } else if (j < input.length && !target.includes(input[j], i)) {
      out.push({ char: input[j], ok: false, extra: true });
      j++;
    } else {
      out.push({ char: target[i] ?? '', ok: false, extra: false });
      i++;
    }
  }
  return out;
}

/** 拼写评分 → SRS 档位（0 错 / 2 对） */
export function gradeFromSpelling(result) {
  return result.correct ? 2 : 0;
}
