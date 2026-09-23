/**
 * فحص ربط WhatsApp Cloud API.
 *
 *   npm run wa:check
 *
 * يسأل Meta نفسها عن كل قيمة بدل أن نخمّن: هل التوكن صالح؟ هل معرّف الرقم
 * يخصّك؟ ما حالة الرقم وتقييم جودته؟ هل الـwebhook مشترك؟
 *
 * سبب وجوده: رسالة الخطأ من Meta عند الفشل غامضة غالباً («Unsupported
 * request»)، فيضيع الوقت في تخمين أي قيمة هي الخاطئة.
 */

import { loadConfig } from './config.ts';
import { openDb, listTenants } from './db/index.ts';

const config = loadConfig();
const graph = `https://graph.facebook.com/${config.cloud.graphVersion}`;

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

const ok = (s: string): string => green(`  ✓ ${s}`);
const bad = (s: string): string => red(`  ✗ ${s}`);

async function graphGet(path: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${graph}/${path}`, {
    headers: { authorization: `Bearer ${config.cloud.accessToken}` },
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

function metaError(data: Record<string, unknown>): string {
  const error = data.error as { message?: string; code?: number; error_subcode?: number } | undefined;
  if (!error) return 'بلا تفاصيل';
  return `${error.message ?? ''}${error.code ? ` (code ${error.code})` : ''}`;
}

async function main(): Promise<void> {
  console.log(bold('\n▸ فحص ربط WhatsApp Cloud API\n'));

  /* --- ١. المتغيرات --- */
  console.log(bold('١. المتغيرات في .env'));
  const missing: string[] = [];
  for (const [key, value, label] of [
    ['WA_ACCESS_TOKEN', config.cloud.accessToken, 'توكن الوصول'],
    ['WA_APP_SECRET', config.cloud.appSecret, 'سرّ التطبيق'],
    ['WA_VERIFY_TOKEN', config.cloud.verifyToken, 'رمز تحقق webhook'],
  ] as const) {
    if (value) console.log(ok(`${label} (${key}) مضبوط`));
    else {
      console.log(bad(`${label} (${key}) ناقص`));
      missing.push(key);
    }
  }
  if (config.provider !== 'cloud') {
    console.log(dim(`  ملاحظة: WA_PROVIDER = ${config.provider}. للإنتاج اجعليه cloud.`));
  }
  if (missing.length) {
    console.log(red('\n  أكملي الناقص أولاً:  npm run setup\n'));
    process.exit(1);
  }

  /* --- ٢. صلاحية التوكن --- */
  console.log(bold('\n٢. التوكن'));
  const me = await graphGet('me');
  if (!me.ok) {
    console.log(bad(`التوكن مرفوض (${me.status}): ${metaError(me.data)}`));
    console.log(dim('     التوكن المؤقت من صفحة API Setup ينتهي خلال ٢٤ ساعة.'));
    console.log(dim('     ولّدي توكناً دائماً من Business Settings ← System Users.'));
    process.exit(1);
  }
  console.log(ok(`التوكن صالح — ${String(me.data.name ?? me.data.id ?? '')}`));

  /* --- ٣. أرقام المنشآت --- */
  console.log(bold('\n٣. الأرقام المسجّلة في النظام'));
  const db = openDb(config.dbPath);
  const tenants = listTenants(db).filter((t) => t.wa_phone_number_id);

  if (tenants.length === 0) {
    console.log(bad('لا توجد منشأة لها Phone number ID.'));
    console.log(dim('     ضعيه من اللوحة: كل المنشآت ← إدارة ← «معرّف الرقم في Cloud API».'));
    db.close();
    process.exit(1);
  }

  let allGood = true;
  for (const tenant of tenants) {
    console.log(`\n  ${bold(tenant.name)}  ${dim(`(${tenant.wa_number})`)}`);

    const number = await graphGet(
      `${tenant.wa_phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput`,
    );

    if (!number.ok) {
      console.log(bad(`معرّف الرقم مرفوض (${number.status}): ${metaError(number.data)}`));
      console.log(dim('       تأكدي أن Phone number ID صحيح، وأن التوكن يملك صلاحية على هذا الرقم.'));
      allGood = false;
      continue;
    }

    const d = number.data as Record<string, string>;
    console.log(ok(`الرقم لدى Meta: ${d.display_phone_number ?? '؟'}`));
    console.log(`     الاسم الظاهر: ${d.verified_name ?? '؟'}`);
    console.log(`     حالة التحقق: ${d.code_verification_status ?? '؟'}`);

    const quality = d.quality_rating ?? 'UNKNOWN';
    const qualityAr: Record<string, string> = { GREEN: 'جيد', YELLOW: 'متوسط', RED: 'منخفض', UNKNOWN: 'غير متاح بعد' };
    console.log(`     تقييم الجودة: ${quality === 'RED' ? red(qualityAr[quality]!) : qualityAr[quality] ?? quality}`);

    // تطابق الرقم بين Meta وقاعدتنا — عدمه يعني توجيهاً خاطئاً للرسائل
    const metaDigits = (d.display_phone_number ?? '').replace(/\D/g, '');
    if (metaDigits && metaDigits !== tenant.wa_number) {
      console.log(bad(`الرقم في النظام (${tenant.wa_number}) يخالف ما لدى Meta (${metaDigits})`));
      console.log(dim('       صحّحيه من اللوحة وإلا وصلت رسائل العملاء للمنشأة الخطأ.'));
      allGood = false;
    } else if (metaDigits) {
      console.log(ok('الرقم مطابق لما في النظام'));
    }
  }
  db.close();

  /* --- ٤. الـwebhook --- */
  console.log(bold('\n٤. الـwebhook'));
  if (config.publicUrl) {
    console.log(ok(`العنوان العام: ${config.publicUrl}/webhook/whatsapp`));
    console.log(dim('     ضعيه في Meta ← WhatsApp ← Configuration ← Webhook، ومعه رمز التحقق.'));
  } else {
    console.log(bad('PUBLIC_URL غير مضبوط — لا يوجد عنوان تصل عليه Meta.'));
    console.log(dim('     Cloud API يحتاج عنوان HTTPS عاماً (خادم أو نفق).'));
    console.log(dim('     بلا هذا يُرسل النظام ولا يستقبل.'));
    allGood = false;
  }

  console.log(
    allGood
      ? green('\n✓ الربط سليم من جهة Meta. يبقى أن تربطي الـwebhook وتشغّلي: npm start\n')
      : red('\n✗ راجعي النقاط أعلاه.\n'),
  );
}

main().catch((error) => {
  console.error(red(`\nفشل الفحص: ${(error as Error).message}\n`));
  process.exit(1);
});
