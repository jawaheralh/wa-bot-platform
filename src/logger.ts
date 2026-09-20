/**
 * السجل.
 *
 * كل سطر يحمل المنشأة والمحادثة، لأن أصعب ما في نظام متعدد المنشآت هو معرفة
 * «أي عميل من أي منشأة» عند قراءة سجل فيه عشر منشآت تعمل معاً.
 */

import { now } from './time.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LABEL: Record<LogLevel, string> = {
  debug: 'تتبّع',
  info: 'معلومة',
  warn: 'تحذير',
  error: 'خطأ',
};

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export interface LogContext {
  tenant?: string | number;
  conversation?: string | number;
  module?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, extra?: LogContext): void;
  info(message: string, extra?: LogContext): void;
  warn(message: string, extra?: LogContext): void;
  error(message: string, error?: unknown, extra?: LogContext): void;
  child(context: LogContext): Logger;
}

function render(context: LogContext): string {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === '') continue;
    bits.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  return bits.length ? ` [${bits.join(' ')}]` : '';
}

/** يستخرج رسالة مفهومة من أي شيء يُرمى، لأن catch يستقبل unknown. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function emit(level: LogLevel, base: LogContext, message: string, extra?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const context = { ...base, ...extra };
  const line = `${now()} ${LABEL[level].padEnd(6)} ${message}${render(context)}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function createLogger(base: LogContext = {}): Logger {
  return {
    debug: (m, e) => emit('debug', base, m, e),
    info: (m, e) => emit('info', base, m, e),
    warn: (m, e) => emit('warn', base, m, e),
    error: (m, err, e) => emit('error', base, m, { ...e, سبب: err === undefined ? undefined : errorMessage(err) }),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger();
