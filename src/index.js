#!/usr/bin/env node
// 入口：启动 Web 推送服务。
//   node src/index.js                       # 设备地址在页面里配 http://<nas>:8080
//   node src/index.js --device 192.168.1.100:32342 [--web 8080]
// 环境变量（systemd / 群晖任务计划 / pm2 均适用）：
//   DEVICE_IP / DEVICE_PORT / WEB_PORT / CLIENT_NAME / RECORDINGS_DIR / RECORDINGS_KEEP / CONFIG_FILE
//
// 设备地址的来源优先级：页面保存的值（data/config.json）> 启动参数/环境变量。
// 也就是说 `--device` 只是“首次默认值”，页面改过之后以页面为准，重启不会被环境变量覆盖。
import path from 'node:path';
import { createServer } from './server.js';
import { DEFAULT_PORT } from './client.js';
import { loadSettings, normalizeDevice } from './settings.js';
import { DEFAULT_PASSWORD } from './auth.js';

function parseArgs(argv) {
  const args = {};
  const take = (i, name) => {
    const value = argv[i];
    if (value === undefined || value.startsWith('--')) {
      console.error(`参数 ${name} 缺少取值`);
      process.exit(1);
    }
    return value;
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device') args.device = take(++i, '--device');
    else if (arg === '--port') args.port = take(++i, '--port');
    else if (arg === '--web') args.web = take(++i, '--web');
    else if (arg === '--name') args.clientName = take(++i, '--name');
    else if (arg === '--recordings') args.recordingsDir = take(++i, '--recordings');
    else if (arg === '--config') args.configFile = take(++i, '--config');
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/** 空字符串按“未设置”处理，避免 RECORDINGS_KEEP= 这类空值触发校验失败 */
const envOr = (value, fallback) => (value === undefined || String(value).trim() === '' ? fallback : value);

/** 严格解析端口/数量类参数：非法值直接退出，避免 listen(NaN) 之类的隐式崩溃 */
function intArg(raw, name, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`参数 ${name} 必须是 ${min}～${max} 的整数，收到: ${raw}`);
    process.exit(1);
  }
  return n;
}

const args = parseArgs(process.argv);

// 命令行优先，其次环境变量
const deviceHost = args.device ?? envOr(process.env.DEVICE_IP, undefined) ?? envOr(process.env.DEVICE, undefined);
const devicePortRaw = args.port ?? envOr(process.env.DEVICE_PORT, undefined);
const devicePort = devicePortRaw === undefined ? undefined : intArg(devicePortRaw, 'port/DEVICE_PORT', 1, 65535);
const startupDeviceRaw =
  deviceHost && !deviceHost.includes(':') && devicePort ? `${deviceHost}:${devicePort}` : deviceHost;
let startupDevice = null;
if (startupDeviceRaw) {
  try {
    startupDevice = normalizeDevice(startupDeviceRaw);
  } catch (err) {
    console.error(`设备地址不合法: ${String(err.message || err)}`);
    process.exit(1);
  }
}
const web = intArg(
  args.web ?? envOr(process.env.WEB_PORT, envOr(process.env.PORT, 8080)),
  'web/WEB_PORT',
  1,
  65535,
);
const clientName = args.clientName ?? envOr(process.env.CLIENT_NAME, undefined);
const recordingsDir = args.recordingsDir ?? envOr(process.env.RECORDINGS_DIR, undefined);
const recordingsKeep = intArg(envOr(process.env.RECORDINGS_KEEP, 200), 'RECORDINGS_KEEP', 1, 100000);
const configFile = path.resolve(
  args.configFile ?? envOr(process.env.CONFIG_FILE, path.join(process.cwd(), 'data', 'config.json')),
);

if (args.help) {
  console.log(`用法: node src/index.js [--device <IPv4|主机名>[:端口]] [--web 8080] [--name "我的NAS"]
                        [--recordings ./data/recordings] [--config ./data/config.json]

不传 --device 也可以启动：打开 http://<本机IP>:8080 ，登录后在「设备」页填写设备地址并保存。
首次访问密码为 helloworld，登录后在「设备」页修改；密码不作为启动参数。

环境变量: DEVICE_IP/DEVICE, DEVICE_PORT, WEB_PORT, CLIENT_NAME, RECORDINGS_DIR,
          RECORDINGS_KEEP, CONFIG_FILE
优先级:   页面保存的地址 (${configFile}) 高于 启动参数/环境变量

示例:
  node src/index.js --web 8080
  node src/index.js --device 192.168.1.100 --web 8080
  DEVICE_IP=zectrix-note4.local WEB_PORT=8080 node src/index.js
`);
  process.exit(0);
}

// 页面保存过的地址优先；没有则退回启动参数/环境变量
const saved = await loadSettings(configFile);
const device = saved.device ?? startupDevice;
const deviceSource = saved.device ? 'file' : startupDevice ? 'startup' : 'none';

const app = createServer({
  device,
  deviceSource,
  font: saved.font,
  passwordHash: saved.passwordHash,
  settingsFile: configFile,
  clientName,
  recordingsDir: recordingsDir ? path.resolve(recordingsDir) : undefined,
  recordingsKeep,
});
const server = app.listen(web, '0.0.0.0', async () => {
  console.log(`EInkPush Web 推送服务已启动: http://0.0.0.0:${web}`);
  if (device) {
    const from = deviceSource === 'file' ? '页面配置' : '启动参数/环境变量';
    console.log(`目标设备: ${device}${device.includes(':') ? '' : ` (默认端口 ${DEFAULT_PORT})`}  [来源: ${from}]`);
    console.log('设备将在首个推送/播放请求时建立连接');
  } else {
    console.log('尚未配置设备地址');
    console.log(`请在浏览器打开 http://<本机IP>:${web} ，在「设备连接」里填写设备地址并保存`);
    console.log(`（也可用 --device 或 DEVICE_IP 指定，配置会存到 ${configFile}）`);
  }
  // 应用启动钩子（晨报定时任务、词库加载）；失败只记日志，不影响推送主链路
  try {
    await app.locals.startApps?.();
  } catch (err) {
    console.error('应用启动失败:', err.message || err);
  }
  console.log(`应用入口: http://<本机IP>:${web}/apps/`);
  console.log(saved.passwordHash
    ? '访问密码已启用（可在「设备」页修改）'
    : `访问密码：初始为 ${DEFAULT_PASSWORD}，请登录后在「设备」页修改`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`端口 ${web} 已被占用，请用 --web 指定其他端口`);
  else console.error('Web 服务启动失败:', err.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在断开设备并退出…`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  try {
    await app.locals.shutdown?.();
  } catch { /* 忽略关闭异常 */ }
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(force);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 常驻服务不能带着未知状态硬撑：记日志、尽量发 CLOSE，然后退出交给 systemd/pm2 重启
process.on('uncaughtException', (err) => {
  console.error('未捕获异常，准备退出:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('未处理的 Promise 拒绝，准备退出:', err);
  shutdown('unhandledRejection');
});
