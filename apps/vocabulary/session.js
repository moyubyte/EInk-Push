// 学习会话状态机：与设备交互无关的纯逻辑，方便单测。
//
// 阶段流转（先看中文 → 报字母 → 整词朗读 → 看答案）：
//   prompt   显示中文提示，等用户长按语音键（拼写模式）或按确认键（翻卡模式）
//   spelling 已收到一次语音，显示判定结果；差一个字母允许重读一次
//   word     提示整词朗读（长按只念单词）
//   answer   显示单词 / 音标 / 释义 / 下次复习
//   done     本轮结束，给出正确/错误/跳过统计
//
// 拼写模式需要 ASR；没有 ASR 时上层会用 flashcard 模式，只做「看中文 → 翻答案」。

export const PHASE = {
  PROMPT: 'prompt',
  SPELLING: 'spelling',
  WORD: 'word',
  ANSWER: 'answer',
  DONE: 'done',
};

export const MODE = {
  FLASHCARD: 'flashcard',
  SPELLING: 'spelling',
};

export class StudySession {
  /**
   * @param {{words: Array<{word:string,meaning:string,phonetic?:string}>, mode?: string,
   *          textbookName?: string, unitName?: string, limit?: number}} options
   */
  constructor(options = {}) {
    const words = Array.isArray(options.words) ? options.words.filter((item) => item && item.word) : [];
    const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : words.length;
    this.words = words.slice(0, limit);
    this.mode = options.mode === MODE.SPELLING ? MODE.SPELLING : MODE.FLASHCARD;
    this.textbookName = options.textbookName ?? '';
    this.unitName = options.unitName ?? '';
    this.phase = this.words.length ? PHASE.PROMPT : PHASE.DONE;
    this.index = 0;
    this.records = [];
    this.result = null; // 当前词的拼写判定
    this.pendingGrade = null;
    this.retried = false;
    this.replays = 0;
    this.startedAt = Date.now();
    this.finishedAt = null;
  }

  get total() {
    return this.words.length;
  }

  get current() {
    return this.words[this.index] ?? null;
  }

  get done() {
    return this.phase === PHASE.DONE;
  }

  get counts() {
    // 跳过（grade=null）既不是对也不是错：`null < 2` 在 JS 里为 true，
    // 不先过滤掉会把跳过的词算进「错误」，汇总页与写回的数据都会失真。
    const graded = this.records.filter((record) => !record.skipped && record.grade !== null);
    const correct = graded.filter((record) => record.grade >= 2).length;
    const wrong = graded.filter((record) => record.grade < 2).length;
    const skipped = this.records.filter((record) => record.skipped).length;
    return { correct, wrong, skipped, answered: this.records.length };
  }

  /** 供渲染层使用的快照 */
  view() {
    return {
      phase: this.phase,
      mode: this.mode,
      item: this.current,
      index: Math.min(this.index + 1, this.total),
      total: this.total,
      textbookName: this.textbookName,
      unitName: this.unitName,
      result: this.result,
      retried: this.retried,
      counts: this.counts,
      elapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      hint: this.hint(),
    };
  }

  hint() {
    switch (this.phase) {
      case PHASE.PROMPT:
        return this.mode === MODE.SPELLING
          ? '长按语音键读字母，松开结束'
          : '按确认键看答案 · 单击上键听发音';
      case PHASE.SPELLING:
        return this.result?.near ? '差一个字母，再读一次' : '按确认键继续';
      case PHASE.WORD:
        return '单击上键听整词 · 按确认看答案';
      case PHASE.ANSWER:
        return '确认=记得 · 下滑=忘了 · 上键重听';
      default:
        return '本轮结束，回到网页可开始新一轮';
    }
  }

  startSpelling() {
    if (this.phase !== PHASE.PROMPT || this.mode !== MODE.SPELLING) return this.view();
    this.phase = PHASE.SPELLING;
    this.result = null;
    this.retried = false;
    return this.view();
  }

  /**
   * 提交一次识别结果。
   * @param {{correct:boolean, near:boolean, got:string, expected:string, empty:boolean}} result
   */
  submitSpelling(result) {
    if (this.phase !== PHASE.SPELLING) return { view: this.view(), retry: false };
    this.result = result;
    // 没听清：留在拼写阶段让用户再读一次，不判错也不计分
    if (result.empty) return { view: this.view(), retry: true, empty: true };
    if (result.near && !this.retried) {
      this.retried = true;
      return { view: this.view(), retry: true };
    }
    this.pendingGrade = result.correct ? 2 : 0;
    this.phase = PHASE.WORD;
    return { view: this.view(), retry: false };
  }

  /** 跳过当前词（不计入正确/错误，但会在记录里留痕） */
  skip() {
    if (this.done) return this.view();
    this.records.push({ word: this.current?.word ?? '', grade: null, skipped: true });
    return this.advance();
  }

  /**
   * 进入答案页。
   * @param {number|null} defaultGrade 翻卡模式下默认记为「记得」；拼写模式传 null 保留判定
   */
  reveal(defaultGrade = null) {
    if (this.done) return this.view();
    if (this.phase === PHASE.ANSWER) return this.view();
    this.phase = PHASE.ANSWER;
    if (this.pendingGrade === null && defaultGrade !== null) this.pendingGrade = defaultGrade;
    return this.view();
  }

  /** 记录自评（答案页）：0 忘了 / 1 勉强 / 2 记得 / 3 很熟 */
  markGrade(grade) {
    if (this.done) return this.view();
    this.pendingGrade = Math.max(0, Math.min(3, Number(grade) || 0));
    return this.view();
  }

  replay() {
    this.replays += 1;
    return this.view();
  }

  /** 收下当前词的成绩并前进到下一词 */
  commit() {
    if (this.done) return this.view();
    const grade = this.pendingGrade;
    const record = grade === null
      ? { word: this.current?.word ?? '', grade: null, skipped: true, spelling: this.result ? { ...this.result } : null, retried: this.retried }
      : {
        word: this.current?.word ?? '',
        grade,
        skipped: false,
        spelling: this.result ? { ...this.result } : null,
        retried: this.retried,
      };
    this.records.push(record);
    return this.advance();
  }

  advance() {
    this.index += 1;
    this.result = null;
    this.pendingGrade = null;
    this.retried = false;
    this.replays = 0;
    if (this.index >= this.total) {
      this.phase = PHASE.DONE;
      this.finishedAt = Date.now();
    } else {
      this.phase = PHASE.PROMPT;
    }
    return this.view();
  }

  /** 本轮汇总（写回 SRS 用） */
  summary() {
    return {
      total: this.total,
      ...this.counts,
      elapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      records: this.records.slice(),
    };
  }
}
