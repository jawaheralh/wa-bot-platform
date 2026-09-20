# منصة بوت واتساب — نظام وحدات متعدد المنشآت

بوت واتساب ذكي يخدم عدة منشآت (عيادات، مطاعم، صالونات، متاجر) في تشغيل واحد.
كل منشأة لها رقمها ونبرتها وقاعدة معرفتها، والوظائف مقسّمة إلى **وحدات** تُفعَّل
لكل منشأة على حدة من صفحة الأدمن.

الفكرة التجارية: تبدأ المنشأة باشتراك «استفسارات + شكاوى»، وتُفعَّل لها الحجوزات
لاحقاً بضغطة زر — بلا تعديل كود ولا إعادة نشر ولا مساس بالمنشآت الأخرى.

---

## التشغيل

```bash
npm install
cp .env.example .env          # ثم املئي SESSION_SECRET و ANTHROPIC_API_KEY
npm run seed                  # منشأتان تجريبيتان + أدمن النظام
npm start
```

لوحة التحكم على **<http://127.0.0.1:4000>**

حسابات البذرة:

| الحساب | المستخدم | كلمة المرور | يرى |
|---|---|---|---|
| أدمن النظام | `admin` | `admin12345` | كل المنشآت |
| أدمن عيادة النور | `noor` | `noor12345` | عيادة النور فقط |
| أدمن مطعم الركن | `rukn` | `rukn12345` | مطعم الركن فقط |

> غيّري كلمات المرور هذه قبل أي استخدام حقيقي.

أوامر أخرى:

```bash
npm test          # ١١٨ اختباراً
npm run build     # فحص الأنواع (tsc)
npm run dev       # إعادة تشغيل تلقائية عند التعديل
npm run sim -- "وش أسعاركم؟"          # محادثة تجريبية من الطرفية
npm run sim -- --tenant 2             # وضع تفاعلي مع منشأة أخرى
```

`npm run sim` يشغّل **نفس** محرّك البوت بالضبط عبر مزوّد المحاكي، ويحتاج
`ANTHROPIC_API_KEY` حقيقياً — فما تريه فيه هو ما سيراه العميل على واتساب.

---

## البنية

```
src/
  index.ts        نقطة الدخول: إعدادات ← قاعدة ← وحدات ← مزوّد ← مجدول ← خادم
  app.ts          تركيب التطبيق (تستعمله الاختبارات والمحاكي بلا فتح منفذ)
  config.ts       متغيرات التشغيل والأسرار فقط — لا إعدادات منشآت
  logger.ts       سجل عربي يحمل المنشأة والمحادثة في كل سطر
  time.ts         توقيت الرياض: SQL_NOW و SQL_TODAY وفهم «بكرة» و«الأحد الجاي»
  tenants.ts      إنشاء المنشآت والمستخدمين وتشفير كلمات المرور
  notify.ts       تنبيه الموظف: صف في alerts + رسالة واتساب
  scheduler.ts    نبضة كل دقيقة تنادي onTick لكل وحدة مفعّلة
  db/
    schema.ts     جداول النواة
    index.ts      فتح القاعدة، التوجيه، المحادثات، الرسائل، الأرقام المرجعية
  modules/
    types.ts      عقد BotModule — الحدّ بين المحرّك والوظائف
    registry.ts   ← الملف الوحيد الذي يُعدَّل لإضافة وحدة
    inquiries.ts  الاستفسارات (أساسية)
    complaints.ts الشكاوى (أساسية)
    handoff.ts    التحويل للموظف (أساسية)
    bookings.ts   الحجوزات (اختيارية، معطّلة افتراضياً)
  bot/
    engine.ts     الرسالة ← تجميع الأدوات والـprompt ← حلقة Claude ← الرد
    claude.ts     غلاف Anthropic SDK مع إعادة محاولة
    prompt.ts     الشخصية والقواعد العامة
    history.ts    آخر ٢٠ رسالة كسياق
  whatsapp/
    provider.ts   واجهة WhatsAppProvider + withRetry
    baileys.ts    تجربة عبر QR، جلسة لكل منشأة
    cloud-api.ts  إنتاج عبر Cloud API الرسمي + webhook موقّع
    simulator.ts  مزوّد وهمي يشغّل نفس المحرّك
  stt/index.ts    تحويل الصوت لنص (Whisper، اختياري)
  web/            Fastify + المصادقة + مسارات الأدمن
public/           صفحة الأدمن: HTML + JS عادي، RTL، بلا framework
tests/            ١١٨ اختباراً بـvitest
```

---

## ربط رقم عبر Baileys (للتجربة والعروض)

هذه أسرع طريقة لتجربة النظام برقم واتساب عادي. **غير رسمية** ولا تصلح للإنتاج —
واتساب قد يوقف الرقم.

1. في `.env`: `WA_PROVIDER=baileys`
2. `npm start` — يُطبع رمز QR في الطرفية لكل منشأة نشطة.
3. على الجوال: واتساب ← الإعدادات ← **الأجهزة المرتبطة** ← ربط جهاز ← امسحي الرمز.
4. عند نجاح الاتصال يُطبع: «اتصل رقم المنشأة … بواتساب».

الجلسة تُحفظ في `data/baileys/<رقم المنشأة>/` فلا تحتاجين المسح في كل تشغيل.
لحذف الربط وإعادة المسح: احذفي مجلد المنشأة وأعيدي التشغيل.

كل منشأة جلسة مستقلة تماماً: مسح QR لعيادة النور لا يمسّ مطعم الركن.

> الإصدار المثبَّت `@whiskeysockets/baileys@7.0.0-rc14` (لا يوجد 7.x مستقر بعد).
> إن واجهتِ عطلاً بعد تحديث واتساب، جرّبي `npm i @whiskeysockets/baileys@6.7.24`.

---

## ربط رقم 9200 عبر Cloud API (الإنتاج)

هذه الطريقة الرسمية. الرقم الموحّد 9200 رقم أرضي لا يستقبل رسائل SMS، لذلك
**التحقق يتم بالمكالمة الصوتية** — وهذه أهم نقطة في العملية كلها.

### ١. تجهيز الحساب في Meta

1. افتحي <https://business.facebook.com> وأنشئي حساب أعمال (Meta Business Account)
   باسم شركتك، ووثّقيه بالسجل التجاري.
2. من <https://developers.facebook.com/apps> أنشئي تطبيقاً من نوع **Business**.
3. أضيفي منتج **WhatsApp** للتطبيق.

### ٢. إضافة الرقم والتحقق بالمكالمة

1. في لوحة WhatsApp ← **API Setup** ← `Add phone number`.
2. أدخلي الرقم بصيغة دولية: `+966 9200xxxxx`.
3. في خطوة التحقق اختاري **Voice call** لا SMS.
4. Meta تتصل بالرقم وتنطق رمزاً من ستة أرقام **بالإنجليزية**. جهّزي شخصاً عند
   السنترال يرد ويكتب الرمز، أو حوّلي الرقم مؤقتاً لجوال يرد عليه.
   الرمز يُنطق مرة أو مرتين فقط — إن فاتك، اطلبي مكالمة جديدة.
5. بعد التحقق ينتقل الرقم لحالة `Connected`، وتظهر له قيمة **Phone number ID**.
6. سجّلي اسماً ظاهراً (Display name) — يحتاج مراجعة من Meta تستغرق يوماً أو يومين.

### ٣. الإعداد في المشروع

في `.env`:

```bash
WA_PROVIDER=cloud
WA_VERIFY_TOKEN=نص-تختارينه-أنتِ        # أي نص، يُستعمل مرة عند ربط الـwebhook
WA_APP_SECRET=...                       # App Settings ← Basic ← App Secret
WA_ACCESS_TOKEN=...                     # توكن دائم من System User (لا المؤقت)
WA_GRAPH_VERSION=v23.0
```

> التوكن المؤقت في صفحة API Setup ينتهي خلال ٢٤ ساعة. للإنتاج أنشئي
> **System User** من Business Settings، أعطيه صلاحية `whatsapp_business_messaging`،
> وولّدي منه توكناً دائماً.

ثم في صفحة الأدمن، حرّري المنشأة وضعي **معرّف الرقم في Cloud API**
(`Phone number ID`) — هو مفتاح توجيه الرسائل لهذه المنشأة.

### ٤. ربط الـwebhook

الخادم يحتاج عنوان HTTPS عاماً. محلياً استعملي نفقاً:

```bash
cloudflared tunnel --url http://localhost:4000
```

ثم في Meta: WhatsApp ← Configuration ← Webhook:

- **Callback URL**: `https://<عنوانك>/webhook/whatsapp`
- **Verify token**: نفس `WA_VERIFY_TOKEN`
- اضغطي `Verify and save` — يجب أن تظهر «نجح تحقق webhook من Meta» في سجلك.
- في `Webhook fields` فعّلي **messages**.

### ٥. التحقق من العمل

أرسلي رسالة من جوالك للرقم. في السجل يجب أن يظهر سطر «رسالة واردة»، وفي لوحة
التحكم تظهر المحادثة.

**ملاحظة أمنية:** كل حمولة تصل الـwebhook يُتحقق من توقيعها بـHMAC-SHA256 على
الجسم الخام. الحمولة بلا توقيع صحيح تُرفض بـ401 — وهذا ما يمنع أي أحد يعرف
عنوانك من حقن رسائل باسم عملائك.

---

## إضافة منشأة جديدة

من صفحة الأدمن (بحساب أدمن النظام) ← **كل المنشآت** ← نموذج «إضافة منشأة»:

| الحقل | الشرح |
|---|---|
| اسم المنشأة | يظهر للعميل في ردود البوت |
| رقم واتساب | مفتاح التوجيه. أي صيغة تُقبل (`+966…` أو `00966…`) وتُطبَّع تلقائياً |
| النبرة | رسمية (صيغة الجمع، بلا إيموجي) أو ودّية («هلا والله»، «أبشر») |
| رقم الموظف | تصله تنبيهات الشكاوى العاجلة والتحويلات |
| معرّف الرقم في Cloud API | مطلوب في الإنتاج فقط |
| مستخدم أدمن المنشأة | حساب يرى منشأته فقط |

عند الإنشاء تُفعَّل الوحدات الأساسية تلقائياً، وتُنشأ صفوف كل الوحدات في
`tenant_modules`. بعدها:

1. من **قاعدة المعرفة** أدخلي النص الحر والأسئلة الشائعة. *هذه أهم خطوة* —
   البوت لا يقول إلا ما هنا، وما ليس هنا يحوّله للموظف.
2. من **الوحدات** فعّلي ما اشترته المنشأة واضبطي إعداداته.
3. اربطي الرقم (QR أو Cloud API).

---

## كيف أكتب وحدة جديدة

الوعد المعماري: **ملف واحد + سطر واحد**. لا تعديل في محرّك البوت، ولا في
قاعدة البيانات، ولا في صفحة الأدمن.

### ١. اكتبي `src/modules/loyalty.ts`

```ts
import type { BotModule, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { readString } from './types.ts';
import { SQL_NOW } from '../time.ts';

export const loyaltyModule: BotModule = {
  name: 'loyalty',                    // لا يتغير بعد الإطلاق — مخزَّن في القاعدة
  titleAr: 'نقاط الولاء',
  descriptionAr: 'يتابع نقاط العملاء ويخبرهم برصيدهم ومتى يستحقون مكافأة.',
  core: false,                        // اختيارية ⇐ معطّلة افتراضياً

  // تُنفَّذ عند كل إقلاع، حتى لو كانت الوحدة معطّلة لكل المنشآت
  tables: [
    `CREATE TABLE IF NOT EXISTS loyalty_points (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      customer_wa TEXT    NOT NULL,
      points      INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      UNIQUE (tenant_id, customer_wa)
    )`,
  ],

  defaultConfig: () => ({ pointsPerVisit: 10, rewardAt: 100 }),

  validateConfig(input) {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      pointsPerVisit: Math.max(1, Number(raw.pointsPerVisit) || 10),
      rewardAt: Math.max(10, Number(raw.rewardAt) || 100),
    };
  },

  // يُضاف للـprompt فقط إذا كانت الوحدة مفعّلة لهذه المنشأة
  systemPrompt(ctx) {
    return `## نقاط الولاء
كل زيارة = ${ctx.config.pointsPerVisit} نقطة، والمكافأة عند ${ctx.config.rewardAt} نقطة.
إذا سأل العميل عن رصيده استعمل get_points. لا تَعِد بمكافأة قبل بلوغ الحد.`;
  },

  tools(): ToolDefinition[] {
    return [{
      name: 'get_points',
      description: 'يستعلم عن رصيد نقاط العميل الحالي.',
      input_schema: { type: 'object', properties: {} },
    }];
  },

  async runTool(name, input, ctx: ModuleContext): Promise<ToolResult> {
    if (name !== 'get_points') return { content: `أداة غير معروفة: ${name}`, isError: true };

    const row = ctx.db
      .prepare('SELECT points FROM loyalty_points WHERE tenant_id = ? AND customer_wa = ?')
      .get(ctx.tenant.id, ctx.conversation.customer_wa) as { points: number } | undefined;

    const points = row?.points ?? 0;
    const remaining = Number(ctx.config.rewardAt) - points;
    return {
      content: remaining > 0
        ? `رصيد العميل ${points} نقطة، وباقي ${remaining} نقطة للمكافأة. أبلغه بذلك.`
        : `رصيد العميل ${points} نقطة وهو يستحق المكافأة. أبلغه وحوّله للموظف لصرفها.`,
    };
  },

  // اختياري: مسارات API لصفحة الأدمن، تُركَّب تلقائياً
  routes(app, deps) {
    app.get('/api/tenants/:tenantId/loyalty', async (request) => {
      const tenantId = Number((request.params as { tenantId: string }).tenantId);
      const user = request.user;
      if (!user || (user.role !== 'system' && user.tenantId !== tenantId)) {
        throw Object.assign(new Error('لا تملك صلاحية على هذه المنشأة.'), { statusCode: 403 });
      }
      return deps.db
        .prepare('SELECT * FROM loyalty_points WHERE tenant_id = ? ORDER BY points DESC')
        .all(tenantId);
    });
  },

  // اختياري: مهمة دورية كل دقيقة للمنشآت المفعِّلة فقط
  // async onTick(tenant, config, deps) { … },
};
```

### ٢. سجّليها في `src/modules/registry.ts`

```ts
import { loyaltyModule } from './loyalty.ts';

export const MODULES: BotModule[] = [
  inquiriesModule, complaintsModule, handoffModule, bookingsModule,
  loyaltyModule,        // ← هذا كل شيء
];
```

### ٣. هذا كل شيء

عند الإقلاع التالي تلقائياً:

- يُنشأ جدول `loyalty_points`.
- يظهر صف للوحدة في `tenant_modules` لكل منشأة (معطّل).
- تظهر بطاقة رمادية في شاشة **الوحدات** لكل أدمن منشأة، عليها وصفك وزر
  «تواصل معنا على واتساب».
- بعد أن يُفعّلها أدمن النظام: تظهر إعداداتها في نموذج مولَّد تلقائياً من
  `defaultConfig()`، ويرى النموذج أداة `get_points` وتعليماتك.
- قبل التفعيل: **النموذج لا يعرف أن الوحدة موجودة أصلاً.**

لإظهار اسم عربي لمفتاح إعداد جديد في الواجهة، أضيفي سطراً في `LABELS`
داخل `public/js/views/modules.js`. المفتاح غير المذكور يظهر باسمه البرمجي.

### قواعد يجب احترامها

- **العزل:** كل استعلام يجب أن يحمل `tenant_id`. لا استثناء.
- **التوقيت:** استعملي `SQL_NOW` و `SQL_TODAY` من `time.ts`، لا `datetime('now')`
  المجرّدة — الفرق ثلاث ساعات ولا يظهر إلا في الإنتاج.
- **لا تثقي بالنموذج:** استعملي `readString` و `readEnum` و `readNumber` من
  `types.ts` بدل قراءة المدخلات مباشرة.
- **نتيجة الأداة تُكتب للنموذج لا للعميل:** اكتبيها كتعليمة («أبلغ العميل بأن…»)
  لا كرسالة جاهزة.
- **القرار الحرج منطق برمجي:** التصعيد والتعارض والصلاحيات تُقرَّر في الكود، لا
  تُترك للنموذج.

---

## سلوك البوت

- عربي سعودي مختصر، والنبرة حسب إعداد المنشأة.
- يحفظ آخر ٢٠ رسالة كسياق (قابل للضبط بـ`HISTORY_LIMIT`).
- لا يخترع معلومة: ما ليس في قاعدة المعرفة يُحوَّل للموظف.
- يفهم «بكرة» و«بعد بكرة» و«الأحد الجاي»، والغامض يسأل عنه.
- الشكوى عالية الخطورة تنبّه الموظف فوراً على واتساب وتظهر في اللوحة.
- **الوضع الصامت:** إذا ردّ الموظف يدوياً (من جواله أو من اللوحة) يصمت البوت
  ساعتين تلقائياً حتى لا يقاطعه. المدة بـ`SILENT_MINUTES`.
- الرسائل الصوتية تُحوَّل لنص إن وُجد `OPENAI_API_KEY`؛ وإلا يطلب البوت رسالة نصية.

---

## الحماية

- كلمات المرور مخزَّنة بـbcrypt (١٠ جولات).
- الجلسة كوكي موقَّع `httpOnly` + `sameSite=lax`، صلاحيته ١٢ ساعة.
- كل مسار تحت `/api/tenants/:tenantId` يمرّ على `requireTenantAccess` — أدمن
  المنشأة لا يصل لمنشأة غيره بأي حال.
- التفعيل والتعطيل لأدمن النظام وحده؛ أدمن المنشأة يرى الوحدة المعطّلة ولا
  يستطيع تفعيلها.
- حمولات Cloud API يُتحقق من توقيعها بـHMAC-SHA256 على الجسم الخام.
- الأسرار في `.env` وحده، وهو في `.gitignore`.

### ما لم يُطبَّق بعد

- لا تحديد لمعدّل الطلبات على `/api/login` — ينبغي إضافته قبل النشر العام.
- لا HTTPS داخلياً؛ الخادم يفترض أنه خلف نفق أو وكيل عكسي.
- لا تشفير للبيانات في القرص — ملف SQLite نص عادي.
- لا سجل تدقيق لتغييرات الأدمن.

---

## ملاحظات تقنية

- Node ≥ ٢٢. ملفات `.ts` تعمل مباشرة بلا خطوة بناء (Node يجرّد الأنواع)،
  و`npm run build` فحص أنواع فقط.
- SQLite عبر `better-sqlite3` بوضع WAL. قاعدة البيانات ملف واحد في `data/`.
- التوقيت: `SQL_NOW = datetime('now','+3 hours')`. الرياض UTC+3 بلا توقيت صيفي.
- الأرقام المرجعية من جدول `counters`، متسلسلة لكل منشأة وسنة:
  `SHK-2026-000147` للشكاوى، `MWD-2026-000031` للمواعيد.
- إضافة مفتاح جديد لإعدادات وحدة لا تكسر المنشآت القائمة: الإعداد المخزَّن
  يُدمج فوق `defaultConfig()` عند القراءة.
