// 运行时设置的持久化：设备地址、推图字体与访问密码哈希。
// 设备地址既可以在 Web 页面里改，也可以由启动参数/环境变量给出；
// 优先顺序是「页面保存的值」>「启动参数/环境变量」，前者落盘后重启仍然生效。
//
// 之所以让页面配置优先：NAS 上常驻的服务通常由 systemd/pm2 拉起，改一次环境变量就得
// 编辑服务单元再重启；而设备换了 IP（DHCP 重新分配）是家常便饭，浏览器里点一下就该生效。

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PORT } from './client.js';
import { PASSWORD_HASH_RE } from './auth.js';

/** 写盘用临时文件 + rename，避免断电/并发时留下半截 JSON */
const TMP_SUFFIX = '.tmp';

/**
 * 校验并规整设备地址。
 * 接受 `192.168.1.100`、`192.168.1.100:32342`、`zectrix-note4.local:32342`；
 * 顺手剥掉用户从浏览器地址栏复制来的协议头、路径与结尾斜杠。
 * @param {unknown} input
 * @returns {string} 规整后的 `host` 或 `host:port`
 */
export function normalizeDevice(input) {
  if (typeof input !== 'string') throw new SettingsError('设备地址应为字符串');
  let text = input.trim();
  if (!text) throw new SettingsError('设备地址不能为空');
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // 去掉 http:// 之类
  text = text.replace(/[/?#].*$/, ''); // 去掉路径与查询串
  if (!text) throw new SettingsError('设备地址不能为空');

  if (text.startsWith('[')) throw new SettingsError('暂不支持 IPv6 字面量，请填写 IPv4 或主机名');
  const parts = text.split(':');
  if (parts.length > 2) throw new SettingsError('设备地址格式应为 IP 或 主机名[:端口]');
  const [host, rawPort] = parts;

  if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host) || host.length > 253) {
    throw new SettingsError('设备地址中的主机名/IP 不合法');
  }

  if (rawPort === undefined || rawPort === '') return host; // 交给客户端用默认端口
  if (!/^\d{1,5}$/.test(rawPort)) throw new SettingsError('端口应为 1～65535 的整数');
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new SettingsError('端口应为 1～65535 的整数');
  return `${host}:${port}`;
}

/** 带默认端口的展示形式，供页面/日志使用 */
export function deviceWithPort(device) {
  if (!device) return null;
  return device.includes(':') ? device : `${device}:${DEFAULT_PORT}`;
}

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
    this.kind = 'InvalidOptions';
  }
}

/** 读取设置；文件不存在或内容损坏都当作“未设置”，不阻塞启动 */
export async function loadSettings(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { device: null, font: null, passwordHash: null };
  }
  try {
    const data = JSON.parse(raw);
    let device = null;
    if (typeof data?.device === 'string' && data.device.trim()) {
      try {
        device = normalizeDevice(data.device);
      } catch {
        device = null; // 地址坏了不影响密码等其他设置
      }
    }
    const font = typeof data?.font === 'string' && data.font.trim() ? data.font.trim() : null;
    const passwordHash = typeof data?.passwordHash === 'string' && PASSWORD_HASH_RE.test(data.passwordHash)
      ? data.passwordHash
      : null;
    return { device, font, passwordHash };
  } catch {
    return { device: null, font: null, passwordHash: null }; // 文件坏了就当没配，页面保存一次即可修复
  }
}

/** 原子写入设置文件 */
export async function saveSettings(file, settings) {
  const payload = {
    device: settings.device ?? null,
    font: settings.font ?? null,
    passwordHash: settings.passwordHash ?? null,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + TMP_SUFFIX;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return payload;
}
