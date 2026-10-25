# 应用（apps/）

这个目录放**跑在同一个 Web 服务里的应用**：每个应用自己管数据、自己渲染 400×300 图、自己决定什么时候推给设备。
服务层（`src/`）只提供协议、连接、录音、事件与页面托管，不掺业务逻辑。

当前有六个：

| 目录 | 应用 | 入口页面 | 说明 |
| --- | --- | --- | --- |
| `today/` | 今天 | `/apps/today/` | 天气 / 空气质量 / 月历 / 历史上的今天 / 五行穿搭，定时或手动推送 |
| `vocabulary/` | 背单词 | `/apps/vocabulary/` | 词库管理 + 拼写/翻卡练习 + SM-2 复习计划，按键与录音直接驱动 |
| `food/` | 今天吃什么 | `/apps/what-to-eat/` | 网页或设备确认键随机换一道菜，并推到墨水屏 |
| `life-guide/` | 人生指南 | `/apps/life-guide/` | 767 条循证生活建议，一条一张卡片，确认键翻下一条 |
| `pet/` | 宠物 | `/apps/pet/` | 按真实时间成长的柯基，可单独推卡，也会叠加到其他应用的图片角落 |
| `jiaobei/` | 掷杯筊 | `/apps/jiaobei/` | 圣筊 / 笑筊 / 阴筊三种结果，确认键掷一杯并推到墨水屏 |

应用总览页：`http://<NAS-IP>:8080/apps`；应用列表接口：`GET /api/apps`。

参考实现：**今天**参考 [happynailinzz/zectrix-morning-brief](https://github.com/happynailinzz/zectrix-morning-brief/blob/3b3ddab6fa48eed580dc99b196b826329475ca50/scripts/morning_brief.py) 的 `morning_brief.py`；**背单词**参考 [itopinion/zectrix-vocabulary](https://github.com/itopinion/zectrix-vocabulary)。

所有页面与接口都在全站密码保护下：页面登录（初始密码 `helloworld`）后由会话 Cookie 维持，接口可额外用 `?token=<密码哈希>` 鉴权。

## 目录约定

```
apps/
  shared/
    canvas.js        400×300 画布、字体解析、文本折行/度量、二值化导出 PNG
    http.js          fetchJson / fetchText / safeFetch（带重试与降级的取数）
  today/
    index.js         应用定义：默认配置、校验、缓存、定时任务、路由
    sources.js       数据层（天气/黄历/月历/历史上的今天，可单测，不依赖 canvas）
    render.js        版式（纯函数：数据 → PNG Buffer）
    page.html        配置与预览页面
  vocabulary/
    index.js         应用定义：会话编排、按键/录音处理、路由
    library.js       词库（教材 → 单元 → 单词）与进度持久化，默认加载内置雅思词书
    data/ielts-6000.json  雅思 6000 词（30 个 List × 200 词，含音标与释义，随仓库提交）
    srs.js           SM-2 复习调度
    quiz.js         拼写判定（编辑距离、差一字母、逐字母对位）
    session.js       学习会话状态机（纯逻辑，无 I/O）
    render.js        版式
    page.html        词库管理与预览页面
  food/
    index.js         应用定义：候选池、随机换菜、按键租约、路由
    dishes.js        42 道菜候选池
    render.js        版式
    page.html        预览与换菜页面
  pet/
    index.js         应用定义：成长状态、互动、按键、叠加、路由
    growth.js        成长阶段、状态机与互动动作
    sprites.js       柯基素材映射（不同状态用不同图片）
    image/           柯基状态素材
    render.js        版式
    overlay.js       叠加到其他应用卡片的空白处
    page.html        互动与预览页面
  jiaobei/
    index.js         应用定义：掷杯状态、按键租约、路由
    outcomes.js      圣筊 / 笑筊 / 阴筊三象概率
    render.js        SVG 杯筊绘制
    page.html        预览与掷杯页面
  life-guide/
    index.js         应用定义：翻条状态、按键租约、路由
    entries.js       内容查询与筛选（数据由脚本生成）
    data/entries.json  767 条建议（2.4 MB，随仓库提交，CC BY 4.0）
    render.js        版式（章节 / 标题 / 说人话 / 成本标签 / 署名）
    page.html        预览与筛选页面
```

语音（TTS/ASR）不在 `apps/` 里：它是服务层的全局能力，实现在 `src/speech.js`，配置存 `data/speech.json`，应用通过 `ctx.speech` 调用。

**内置词书**：`apps/vocabulary/data/ielts-6000.json`（雅思 6000 词，30 个 List × 200 词，340 KB，随仓库提交）由 `scripts/build-ielts-wordbook.mjs` 生成：

- 主源是 [ECDICT](https://github.com/skywind3000/ECDICT) 的 `tag=ielts` 词条，补充源是 [qwerty-learner](https://github.com/Kaiyiwing/qwerty-learner) 的雅思核心词表（去重后 5 千出头的雅思标注词）；
- 不足 6000 的部分用 `tag=toefl` 的共考词按词频补足 → 所以词书里雅思标注词在前，共考补充词分布在高频区内；
- 释义压成一行、最多三个义项、按屏幕宽度（34 个字符宽 ≈ 17 个汉字）截断；音标统一成 IPA（ECDICT 里混了西里尔字母 `ә` 和 ASCII 撇号当重音符）；
- `library.js` 首次启动时把它展开成 textbooks/units 写进 `data/vocabulary/library.json`，之后以那份为准（可以自由增删）。

要换词量、换数据源或换切分粒度，重跑脚本即可（需要先把 ~65 MB 的 `ecdict.csv` 放到 `.cache/`）：

```bash
node scripts/fetch-ecdict.mjs && npm run build:wordbook   # 先下词典（分块校验），再生成词书
node scripts/build-ielts-wordbook.mjs --limit 3000 --size 100 --base-rank 500
```

**原则**：把「纯逻辑」和「I/O / 渲染」分开。`sources.js`、`srs.js`、`quiz.js`、`session.js` 都不碰 canvas 与网络之外的东西，因此可以像普通函数一样单测（见 `test/apps-morning.test.js`、`test/apps-vocab.test.js`）。

**人生指南内容**：`apps/life-guide/data/entries.json`（767 条、34 章）由 `scripts/build-life-guide.mjs` 从 [HowToLiveBetter](https://github.com/eternity4719/HowToLiveBetter) 的 `book/*.md` 抽取，原文与派生数据均为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。卡片和页面都保留来源署名。要更新内容，先取得该仓库的 `book/` 目录再重跑：

```bash
node scripts/build-life-guide.mjs <HowToLiveBetter>/book
```

## 应用契约

在 `apps/<id>/index.js` 默认导出：

```js
export default {
  id: 'my-app',                    // 唯一 id，同时是路由前缀 /apps/<id>/
  name: '我的应用',                 // 页面显示名
  description: '一句话说明',         // 应用列表里的说明
  create(ctx) {                    // 启动时调用一次（同步）
    // ...
    return {
      router,                      // 必填：express.Router，挂在 /apps/<id> 下
      async start() {},            // 可选：注册定时任务、加载数据（listen 之后调用）
      stop() {},                   // 可选：停掉定时任务、解绑事件（进程退出/测试收尾时调用）
      status() { return {}; },     // 可选：`GET /api/apps` 里会带上它
      pushCurrent(),               // 可选：推送当前卡片（设备上/下键切换应用时调用）
      blocksAppSwitch() { return false; }, // 可选：返回 true 时不让上/下键切换（如背单词作答中）
    };
  },
};
```

设备停在远程模式界面时，上/下键按注册表顺序循环切换应用，并推送对应应用的当前卡片。

然后在 `src/apps.js` 的 `APP_DEFINITIONS` 里登记，并按需要在 `public/apps.html` 之外补入口链接（列表页是自动生成的，不用改）。

### ctx 提供什么

| 字段 | 说明 |
| --- | --- |
| `dataDir` | 应用数据根目录，**请自己拼 `path.join(ctx.dataDir, '<id>')`**，别写进别人的目录 |
| `fontsDir` | 用户字体目录（放 `.ttf` 即可覆盖系统字体），交给 `ensureFont({ fontsDir })` |
| `getClient()` | 按需连接设备，返回已完成握手（INFO → CONNECT → PALETTE）的 `ZectrixClient`；未配置地址会抛 `NotConfigured`（页面提示用户去填） |
| `speech` | 全局语音服务：`synthesize(text)` → 16kHz PCM、`recognize(pcm)` → 文本、`asrReady` / `ttsReady` / `voice` / `config`；配置由首页「语音服务」统一维护 |
| `on(name, handler)` | 订阅设备事件，返回解绑函数。`name` 传 `'event'` 表示全部，也可传 `'key'` / `'recordingFinished'` 只收某一类 |
| `log(message)` | 写一行日志（服务层会加前缀） |
| `briefBuilder` | 仅测试注入：替换今天应用的数据源 |

**事件只有一个来源**：`consumeEvents()` 从 `client.nextEvent()` 读事件，写历史、广播 SSE，再 `bus.emit(event)` 给应用。
应用**不要**再去 `client.on('key')`——那样同一件事会被处理两次（历史里出现重复条目、按键被当成两次）。这是踩过的坑。

事件形状：

```js
{ type: 'key', key: 'up'|'down'|'confirm', action: 'short'|'long' }
{ type: 'recordingStarted', id }
{ type: 'recordingFinished', id, audio: Int16Array, reason, lostFrames }
{ type: 'connected', ... } / { type: 'disconnected' }
```

### 推一帧到设备

```js
import { FORMAT } from '../../src/image.js';
const client = await ctx.getClient();
await client.show(pngBuffer, FORMAT.MONO); // 返回 = 设备已确认物理显示完成
```

`show()` 内部会串行化、分片、按位图补传、等 RESULT 或回查 STATE。
**应用自己也要串行化**：设备只有一块屏，按键很快，多个 `show()` 交错会让用户看到半新半旧的画面。
两个应用的做法都是把「处理一件事 → 推送」串成一条 promise 链（见 `vocabulary/index.js` 的 `run()`）。

### 错误响应

用 `src/errors.js`：

```js
import { sendError, httpStatusOf, InvalidInput } from '../../src/errors.js';
```

- 参数校验失败 → 抛 `InvalidInput`（或直接 `res.status(400)`），**不要**抛普通 `Error`，那会变成 500
- 业务错误要带状态码时，跟 `httpStatusOf(err)` 走：`Busy` 409、`Disconnected` 503、`DeviceFailure` 502、`ResultUnknown` 504
- 所有错误响应统一 `{"ok":false,"error":"..."}`，不要吐 HTML 错误页

## 新增一个应用

1. `apps/my-app/index.js`：按上面的契约导出 `{ id, name, description, create }`
2. 纯逻辑与渲染拆到单独文件，让它们能在测试里直接调用
3. `src/apps.js` 里加入 `APP_DEFINITIONS`
4. 写 `test/apps-my.test.js`：纯逻辑单测 + 一条 `createServer({ apps: true, ...注入 })` 的端到端用例（MockDevice + `briefBuilder`/`createSpeech` 注入口，保证不联网）
5. `npm test` 全绿即可，页面入口会自动出现在 `/apps`
