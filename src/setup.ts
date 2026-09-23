/**
 * معالج الإعداد التفاعلي.
 *
 *   npm run setup           إعداد أو تعديل المفاتيح
 *   npm run setup -- --check   فحص الحالة بلا تعديل
 *
 * سبب وجوده: تحرير .env يدوياً مصدر أخطاء صامتة — مسافة زائدة، أو علامة
 * اقتباس، أو مفتاح منسوخ ناقصاً. هنا يُسأل عن كل قيمة، ويُختبر المفتاح
 * بنداء حقيقي، ولا يُكتب الملف إلا بعد التحقق.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT } from './config.ts';

const ENV_PATH = join(ROOT, '.env');
const checkOnly = process.argv.includes('--check');

/* ---------------------------------------------------------------
   قراءة وكتابة .env مع حفظ التعليقات والترتيب
--------------------------------------------------------------- */

function readEnv(): Map<string, string> {
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

/** يحدّث القيم في مكانها ويُضيف الناقص في النهاية — فلا تضيع التعليقات. */
function writeEnv(updates: Map<string, string>): void {
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
    result.push('', '# أُضيفت بواسطة معالج الإعداد');
    for (const [key, value] of missing) result.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, result.join('\n'), { mode: 0o600 });
}

/* ---------------------------------------------------------------
   العرض
--------------------------------------------------------------- */

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

/** يُظهر أول وآخر أربعة أحرف فقط — يكفي للتعرّف ولا يكشف السرّ. */
function mask(value: string): string {
  if (!value) return red('غير مضبوط');
  if (value.length <= 12) return green('مضبوط');
  return green(`${value.slice(0, 6)}…${value.slice(-4)}`);
}

/* ---------------------------------------------------------------
   التحقق الفعلي من المفاتيح
--------------------------------------------------------------- */

async function testAnthropicKey(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4,
        messages: [{ role: 'user', content: 'قل: تم' }],
      }),
    });

    if (response.ok) return { ok: true, message: 'المفتاح يعمل ✓' };

    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    if (response.status === 401) return { ok: false, message: 'المفتاح مرفوض — تأكدي من نسخه كاملاً.' };
    if (response.status === 429) return { ok: false, message: 'تجاوزتِ حد الاستعمال أو الرصيد منتهٍ.' };
    return { ok: false, message: `رفضت Anthropic (${response.status}): ${body.error?.message ?? ''}` };
  } catch (error) {
    return { ok: false, message: `تعذّر الاتصال: ${(error as Error).message}` };
  }
}

async function testOpenAiKey(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${key}` },
    });
    return response.ok
      ? { ok: true, message: 'المفتاح يعمل ✓' }
      : { ok: false, message: `مرفوض (${response.status}).` };
  } catch (error) {
    return { ok: false, message: `تعذّر الاتصال: ${(error as Error).message}` };
  }
}

/* ---------------------------------------------------------------
   الأسئلة
--------------------------------------------------------------- */

interface Field {
  key: string;
  label: string;
  hint: string;
  secret?: boolean;
  optional?: boolean;
  test?: (value: string) => Promise<{ ok: boolean; message: string }>;
  validate?: (value: string) => string | null;
}

const FIELDS: Field[] = [
  {
    key: 'WA_PROVIDER',
    label: 'طريقة الربط بواتساب',
    hint: 'baileys = مسح QR برقم ثانوي · cloud = الرسمي (يحتاج خادماً) · simulator = بلا اتصال',
    validate: (v) =>
      ['baileys', 'cloud', 'simulator'].includes(v) ? null : 'اكتبي: baileys أو cloud أو simulator.',
  },
  {
    key: 'READ_ONLY',
    label: 'وضع عرض فقط (0 أو 1)',
    hint: '1 = يستقبل الرسائل ويعرضها ولا يُرسل شيئاً إطلاقاً.',
    optional: true,
    validate: (v) => (v === '0' || v === '1' ? null : 'اكتبي 0 أو 1.'),
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'مفتاح Claude',
    hint: 'من console.anthropic.com ← API Keys. بدونه لن يرد البوت.',
    secret: true,
    test: testAnthropicKey,
    validate: (v) => (v.startsWith('sk-ant-') ? null : 'المفتاح يبدأ عادةً بـsk-ant-. تأكدي من نسخه كاملاً.'),
  },
  {
    key: 'SUPPORT_WHATSAPP',
    label: 'رقم الدعم (رقمك أنتِ)',
    hint: 'يظهر لعملائك عند الوحدات المعطّلة، بصيغة 9665xxxxxxxx.',
    validate: (v) => (/^\d{10,15}$/.test(v.replace(/\D/g, '')) ? null : 'رقم غير صالح.'),
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'مفتاح OpenAI (اختياري)',
    hint: 'لتحويل الرسائل الصوتية لنص. اتركيه فارغاً لتعطيل الميزة.',
    secret: true,
    optional: true,
    test: testOpenAiKey,
  },
];

/**
 * قارئ أسطر يعمل في الحالتين.
 *
 * readline مع أنبوب (لا طرفية) يبتلع الأسطر بين الأسئلة فتضيع الإجابات،
 * لذا نقرأ المدخلات كاملة مقدّماً حين لا تكون طرفية. هذا يجعل المعالج
 * قابلاً للأتمتة أيضاً: يمكن تمرير الإجابات من ملف أو سكربت.
 */
type Asker = ((prompt: string) => Promise<string>) & { close(): void };

async function createAsker(): Promise<Asker> {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ask = (async (prompt: string) => {
      try {
        return (await rl.question(prompt)).trim();
      } catch {
        throw Object.assign(new Error('انتهت المدخلات'), { aborted: true });
      }
    }) as Asker;
    ask.close = () => rl.close();
    return ask;
  }

  let buffer = '';
  for await (const chunk of stdin) buffer += chunk;
  const lines = buffer.split('\n');
  let index = 0;

  const ask = (async (prompt: string) => {
    stdout.write(prompt);
    if (index >= lines.length) throw Object.assign(new Error('انتهت المدخلات'), { aborted: true });
    const line = (lines[index++] ?? '').trim();
    stdout.write(`${line}\n`);
    return line;
  }) as Asker;
  ask.close = () => {};
  return ask;
}

async function main(): Promise<void> {
  const env = readEnv();

  console.log(bold('\n▸ حالة الإعدادات\n'));
  for (const field of FIELDS) {
    console.log(`  ${field.label.padEnd(26)} ${mask(env.get(field.key) ?? '')}`);
  }
  const provider = env.get('WA_PROVIDER') ?? 'simulator';
  const providerAr = { baileys: 'Baileys (مسح QR)', cloud: 'Cloud API (رسمي)', simulator: 'محاكي' }[provider] ?? provider;
  console.log(`  ${'مزوّد واتساب'.padEnd(26)} ${green(providerAr)}`);
  console.log(`  ${'وضع عرض فقط'.padEnd(26)} ${env.get('READ_ONLY') === '1' ? green('مُفعَّل') : dim('معطَّل')}`);

  const secret = env.get('SESSION_SECRET') ?? '';
  const weak = !secret || secret.includes('change-me') || secret.length < 32;
  console.log(`  ${'سرّ الجلسة'.padEnd(26)} ${weak ? red('ضعيف — سيُولَّد جديد') : green('قوي ✓')}`);

  if (checkOnly) {
    console.log(dim('\n  (فحص فقط — لم يُعدَّل شيء)\n'));
    return;
  }

  console.log(dim('\n  اتركي الحقل فارغاً واضغطي Enter للإبقاء على القيمة الحالية.\n'));

  const ask = await createAsker();
  const updates = new Map<string, string>();

  try {
    for (const field of FIELDS) {
      const current = env.get(field.key) ?? '';
      console.log(bold(`\n${field.label}`));
      console.log(dim(`  ${field.hint}`));
      if (current) console.log(dim(`  الحالي: ${mask(current)}`));

      const answer = await ask('  › ');
      if (!answer) continue;

      const value = answer === '-' ? '' : answer;

      if (value && field.validate) {
        const problem = field.validate(value);
        if (problem) {
          console.log(red(`  ✗ ${problem}`));
          const retry = await ask('  اكتبيها مرة أخرى (أو Enter للتخطي): ');
          if (!retry) continue;
          updates.set(field.key, retry);
          continue;
        }
      }

      if (value && field.test) {
        process.stdout.write(dim('  جارٍ التحقق… '));
        const result = await field.test(value);
        console.log(result.ok ? green(result.message) : red(`✗ ${result.message}`));
        if (!result.ok) {
          const keep = (await ask('  أحفظها رغم ذلك؟ (n/نعم): ')).toLowerCase();
          if (keep !== 'نعم' && keep !== 'y') continue;
        }
      }

      updates.set(field.key, value);
    }

    if (weak) updates.set('SESSION_SECRET', randomBytes(32).toString('hex'));

    if (updates.size === 0) {
      console.log(dim('\n  لم يتغير شيء.\n'));
      return;
    }

    writeEnv(updates);
    console.log(green(`\n✓ حُفظت ${updates.size} قيمة في .env`));
    console.log(dim(`  (نسخة احتياطية في .env.backup)`));
    console.log(bold('\nالخطوة التالية:\n'));
    console.log('  npm start');
    console.log(dim('  ثم افتحي http://localhost:4000\n'));
  } finally {
    ask.close();
  }
}

main().catch((error) => {
  if ((error as { aborted?: boolean }).aborted) {
    console.log(dim('\n  أُلغي الإعداد — لم يُحفظ شيء.\n'));
    process.exit(0);
  }
  console.error(red(`\nفشل: ${(error as Error).message}\n`));
  process.exit(1);
});
