// 应用共享的网络工具：超时、有限重试、失败降级。
// 晨报的数据源全是公开 HTTP 接口，任何一个挂掉都不该让整张图推送失败，
// 所以统一走 safeFetch —— 取不到就给默认值并记一条告警。

const UA = 'zectrix-node-apps/1.0';

async function request(url, { timeout = 20000, headers = {} } = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response;
}

export async function fetchJson(url, options = {}) {
  const response = await request(url, options);
  return response.json();
}

export async function fetchText(url, options = {}) {
  const response = await request(url, options);
  return response.text();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 失败重试后降级：把异常吞掉、返回 fallback，同时打一条告警。
 * @param {() => Promise<any>} fn
 * @param {any} fallback
 * @param {{retries?: number, delay?: number, label?: string, log?: Function}} [options]
 */
export async function safeFetch(fn, fallback, options = {}) {
  const { retries = 2, delay = 1500, label = '数据源', log = console.warn } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(delay);
    }
  }
  log(`${label}获取失败，已降级: ${String(lastError?.message || lastError)}`);
  return typeof fallback === 'function' ? fallback(lastError) : fallback;
}
