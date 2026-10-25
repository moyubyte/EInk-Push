// 统一的错误 → HTTP 状态码映射：Web 服务层与应用层共用一份，避免各写一套。
import { ZectrixError } from './packet.js';

export const ERROR_STATUS = {
  Busy: 409,
  Disconnected: 503,
  NotConfigured: 409,
  InvalidOptions: 400,
  InvalidImage: 400,
  InvalidAudio: 400,
  AudioTooLong: 400,
  ResultUnknown: 504,
  DeviceFailure: 502,
};

/**
 * 应用层入参错误。
 * 应用（apps/*）抛出的校验类错误没有协议语义，但同样需要映射成 400，
 * 之前 parseDate 抛普通 Error 会一路走到 500，所以这里给一个带 status 的类型。
 */
export class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInput';
    this.status = 400;
  }
}

/** @param {unknown} err @returns {number} */
export function httpStatusOf(err) {
  if (err instanceof ZectrixError) return ERROR_STATUS[err.kind] ?? 500;
  if (err && typeof err === 'object' && 'status' in err && Number.isFinite(err.status)) return err.status;
  return 500;
}

/** 统一的 JSON 错误响应 */
export function sendError(res, err) {
  res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
}
