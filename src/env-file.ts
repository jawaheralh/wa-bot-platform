/**
 * قراءة وكتابة .env من داخل التطبيق.
 *
 * يُستعمل من شاشة الإعدادات في اللوحة، حتى لا يُجبَر المالك على الطرفية
 * لمجرد لصق مفتاح. يحفظ التعليقات والترتيب، ويأخذ نسخة احتياطية.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';

const ENV_PATH = join(ROOT, '.env');

export function readEnvFile(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return values;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return values;
}

export function writeEnvFile(updates: Map<string, string>): void {
  if (existsSync(ENV_PATH)) copyFileSync(ENV_PATH, `${ENV_PATH}.backup`);

  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const written = new Set<string>();

  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!updates.has(key)) return line;
    written.add(key);
    return `${key}=${updates.get(key)}`;
  });

  const missing = [...updates.entries()].filter(([key]) => !written.has(key));
  if (missing.length) {
    result.push('', '# أُضيفت من شاشة الإعدادات');
    for (const [key, value] of missing) result.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, result.join('\n'), { mode: 0o600 });
}

/** أول ستة أحرف وآخر أربعة — يكفي للتعرّف ولا يكشف السرّ. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 12) return '••••••••';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
