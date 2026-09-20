/**
 * محاكي المحادثة من الطرفية.
 *
 * يشغّل **نفس** محرّك البوت على قاعدة بيانات المشروع، عبر مزوّد المحاكي.
 * يستعمل Claude الحقيقي إن وُجد المفتاح، فما تراه هنا هو ما سيراه العميل.
 *
 *   npm run sim -- --tenant 1 "وش أسعاركم؟"
 *   npm run sim -- --tenant 1            # وضع تفاعلي
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { listTenants, getTenant } from './db/index.ts';
import { SimulatorProvider } from './whatsapp/simulator.ts';
import { createClaudeClient } from './bot/claude.ts';
import { createEngine } from './bot/engine.ts';
import { createTranscriber } from './stt/index.ts';
import { errorMessage, setLogLevel } from './logger.ts';

const argv = process.argv.slice(2);

function flag(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

const tenantId = Number(flag('tenant', '1'));
const customer = flag('from', '966555555555')!;
const oneShot = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();

const config = loadConfig();
setLogLevel(flag('verbose') !== undefined ? 'debug' : 'warn');

const provider = new SimulatorProvider();
const app = await buildApp({ config, provider });

const tenant = getTenant(app.db, tenantId);
if (!tenant) {
  console.error(`لا توجد منشأة بالرقم ${tenantId}. المنشآت المتاحة:`);
  for (const t of listTenants(app.db)) console.error(`  ${t.id} — ${t.name} (${t.wa_number})`);
  process.exit(1);
}

if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY غير معرّف — ضعيه في .env لتجربة ردود حقيقية.');
  process.exit(1);
}

const engine = createEngine({
  app,
  claude: createClaudeClient(config.anthropicApiKey, config.anthropicModel, app.logger),
  transcriber: createTranscriber(config, app.logger),
});
provider.onMessage(engine);

console.log(`\n▸ محاكاة محادثة مع «${tenant.name}» (${tenant.tone === 'formal' ? 'نبرة رسمية' : 'نبرة ودّية'})`);
console.log(`  العميل: ${customer}   |   اكتبي /خروج للإنهاء\n`);

async function say(text: string): Promise<void> {
  console.log(`\x1b[36mالعميل:\x1b[0m ${text}`);
  await provider.receive({ toNumber: tenant!.wa_number, from: customer, text });
  for (const sent of provider.drain()) {
    console.log(`\x1b[32mالبوت:\x1b[0m  ${sent.text.replace(/\n/g, '\n        ')}`);
  }
  console.log();
}

try {
  if (oneShot) {
    await say(oneShot);
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    for (;;) {
      const line = (await rl.question('\x1b[36m> \x1b[0m')).trim();
      if (!line || line === '/خروج' || line === '/exit') break;
      await say(line);
    }
    rl.close();
  }
} catch (error) {
  console.error(`فشل: ${errorMessage(error)}`);
} finally {
  await app.close();
}
