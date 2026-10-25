// 应用注册表：把 apps/ 下的独立应用挂到同一个 Web 服务上。
//
// 约定：每个应用默认导出一个对象 { id, name, description, create(ctx) }，
// create 返回 { router, start?, stop?, status?, pushCurrent?, blocksAppSwitch?, onScreenTaken? }。
// 设备停在远程模式界面时，上/下键按 APP_DEFINITIONS 顺序切换应用，
// 调用目标应用的 pushCurrent 推送当前卡片；blocksAppSwitch 返回 true 时跳过切换。
// 任何应用向设备推图时，其他应用的 onScreenTaken(appId) 会被调用：
// 有会话状态的应用（如背单词）收到后应自行收尾，避免设备按键把旧卡片再推上去。
// ctx 提供：
//   dataDir   应用数据根目录（实际用 dataDir/<appId>）
//   fontsDir  用户字体目录（放 .ttf 即可覆盖系统字体）
//   getClient 按需连接设备，返回已握手完成的 ZectrixClient
//   speech    全局语音服务（TTS/ASR），多个应用共用同一份配置
//   on        订阅设备事件（key / recordingFinished / disconnected …），返回解绑函数
//   log       写日志
//
// 事件只有一条来源：server 的 consumeEvents。它把事件同时喂给历史/SSE 和这里的总线，
// 应用不许自己去挂 client.on(...)，否则同一事件会被处理两次（这个坑之前踩过）。

import today from '../apps/today/index.js';
import vocabulary from '../apps/vocabulary/index.js';
import food from '../apps/food/index.js';
import lifeGuide from '../apps/life-guide/index.js';
import pet from '../apps/pet/index.js';
import jiaobei from '../apps/jiaobei/index.js';

export const APP_DEFINITIONS = [today, vocabulary, food, lifeGuide, pet, jiaobei];

/** 极简事件总线：任何订阅者抛错都只影响自己，不影响设备事件消费主循环 */
export function createBus(log = console.error) {
  const listeners = new Set();
  return {
    /**
     * @param {string} name 事件名（'event' 表示全部设备事件，或具体 type 如 'key'、'recordingFinished'）
     * @param {(event: object) => any} handler
     */
    on(name, handler) {
      const entry = { name: name || 'event', handler };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    emit(event) {
      for (const entry of [...listeners]) {
        if (entry.name !== 'event' && entry.name !== event?.type) continue;
        try {
          const result = entry.handler(event);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => log(`应用事件处理失败: ${String(err?.message || err)}`));
          }
        } catch (err) {
          log(`应用事件处理失败: ${String(err?.message || err)}`);
        }
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

export function createApps(ctx) {
  const instances = [];

  /**
   * 屏幕占用通知：任何一个应用向设备推图，就告诉其他应用。
   * 有会话状态的应用（如背单词）收到后自行收尾，避免设备确认键
   * 把旧应用的卡片再推上去，画面在两个应用之间来回跳。
   */
  function notifyScreenTaken(appId) {
    for (const entry of instances) {
      if (entry.id === appId) continue;
      try {
        entry.instance.onScreenTaken?.(appId);
      } catch (err) {
        ctx.log(`应用 ${entry.id} 响应屏幕占用通知失败: ${String(err?.message || err)}`);
      }
    }
  }

  /**
   * 给应用拿到的 client 打上来源标记：它一调 show/showRaw，
   * 其他应用立刻知道屏幕易主。所有推送路径（网页下发、设备按键、
   * 定时任务）都走 ctx.getClient().show()，在这里拦最全。
   */
  function tagClient(client, appId) {
    return new Proxy(client, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === 'show' || prop === 'showRaw') {
          return async (...args) => {
            notifyScreenTaken(appId);
            return value(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const baseGetClient = ctx.getClient;
  for (const definition of APP_DEFINITIONS) {
    try {
      const appCtx = {
        ...ctx,
        getClient: async () => tagClient(await baseGetClient(), definition.id),
      };
      const instance = definition.create(appCtx);
      instances.push({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        instance,
      });
    } catch (err) {
      ctx.log(`应用 ${definition.id} 初始化失败: ${String(err?.message || err)}`);
    }
  }

  /**
   * 设备停在远程模式界面时，上/下键按注册表顺序循环切换应用，
   * 切换后推送该应用当前的卡片。正在使用上/下键的应用（如背单词作答）
   * 通过 blocksAppSwitch() 阻止切换。
   */
  let cursor = -1;
  let switching = Promise.resolve();
  const offSwitchKeys = ctx.on('event', (event) => {
    if (event?.type !== 'key' || event.action !== 'short') return;
    if (event.key !== 'up' && event.key !== 'down') return;
    if (instances.some((entry) => entry.instance.blocksAppSwitch?.())) return;
    switching = switching
      .then(() => switchApp(event.key))
      .catch((err) => ctx.log(`应用切换失败：${String(err?.message || err)}`));
  });

  async function switchApp(key) {
    if (!instances.length) return;
    const step = key === 'up' ? 1 : -1;
    cursor = cursor < 0
      ? (step > 0 ? 0 : instances.length - 1)
      : (cursor + step + instances.length) % instances.length;
    const entry = instances[cursor];
    const push = entry.instance.pushCurrent;
    if (typeof push !== 'function') {
      ctx.log(`应用 ${entry.id} 没有实现 pushCurrent，无法切换到设备`);
      return;
    }
    ctx.log(`切换到应用：${entry.name}`);
    await push.call(entry.instance, { force: true });
  }

  return {
    list: instances,
    get(id) {
      return instances.find((entry) => entry.id === id)?.instance ?? null;
    },
    /** 供应用外的推图路径（如首页 /api/show）也触发同一份屏幕占用通知 */
    notifyScreenTaken,
    /** 启动钩子（注册定时任务、加载词库等） */
    async start() {
      for (const entry of instances) {
        try {
          await entry.instance.start?.();
        } catch (err) {
          ctx.log(`应用 ${entry.id} 启动失败: ${String(err?.message || err)}`);
        }
      }
    },
    async stop() {
      offSwitchKeys();
      for (const entry of instances) {
        try {
          await entry.instance.stop?.();
        } catch { /* 停止失败不影响退出 */ }
      }
    },
    summary() {
      return instances.map((entry) => {
        let status = null;
        try {
          status = entry.instance.status?.() ?? null;
        } catch { /* 状态获取失败不算致命 */ }
        return {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          url: `/apps/${entry.id}/`,
          status,
        };
      });
    },
  };
}
