/**
 * جداول النواة.
 *
 * كلها CREATE TABLE IF NOT EXISTS إدماجية تُنفَّذ عند كل إقلاع، فقاعدة
 * البيانات تُصلح نفسها ولا تحتاج نظام هجرات — نفس أسلوب مشروع 9200.
 * جداول الوحدات ليست هنا: كل وحدة تُصرّح جداولها في ملفها وتُنفَّذ من
 * registry.migrateAll().
 */

import { SQL_NOW } from '../time.ts';

export const CORE_TABLES: string[] = [
  /* --- المنشآت: كل صف عميل يدفع اشتراكاً --- */
  `CREATE TABLE IF NOT EXISTS tenants (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL,
    wa_number          TEXT    NOT NULL UNIQUE,          -- الرقم المستقبِل، مفتاح التوجيه (أرقام فقط)
    wa_phone_number_id TEXT    UNIQUE,                   -- معرّف الرقم في Cloud API
    tone               TEXT    NOT NULL DEFAULT 'friendly', -- formal | friendly
    staff_wa_number    TEXT,                             -- رقم الموظف الذي تصله التنبيهات
    status             TEXT    NOT NULL DEFAULT 'active',   -- active | suspended
    retention_days     INTEGER NOT NULL DEFAULT 0,          -- 0 = احتفاظ بلا حد
    -- بيانات Meta الخاصة بالمنشأة. الفارغ يرث القيمة العامة من .env،
    -- فالمنشأة التي تملك حساب Meta خاصاً تستعمله، وغيرها تستعمل حسابك.
    wa_access_token    TEXT,
    wa_app_secret      TEXT,
    wa_app_id          TEXT,
    wa_business_id     TEXT,
    -- مفتاح Claude الخاص بالمنشأة: ينفد رصيده وحده فلا يوقف بقية العملاء.
    anthropic_api_key  TEXT,
    anthropic_model    TEXT,
    notes              TEXT,
    created_at         TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tenants_wa_number ON tenants(wa_number)`,

  /* --- المستخدمون: tenant_id فارغ يعني أدمن النظام --- */
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL,                      -- system | tenant | agent
    wa_number     TEXT,                                  -- جواله لتصله التنبيهات
    active        INTEGER NOT NULL DEFAULT 1,            -- التعطيل بدل الحذف يحفظ نسبة الردود السابقة
    created_at    TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,

  /* --- الوحدات المفعّلة لكل منشأة وإعداداتها --- */
  `CREATE TABLE IF NOT EXISTS tenant_modules (
    tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    module     TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 0,
    config     TEXT    NOT NULL DEFAULT '{}',            -- JSON، شكله تحدده الوحدة نفسها
    updated_at TEXT    NOT NULL DEFAULT (${SQL_NOW}),
    PRIMARY KEY (tenant_id, module)
  )`,

  /* --- المحادثات: صف واحد لكل (منشأة، رقم عميل) --- */
  `CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_wa     TEXT    NOT NULL,
    customer_name   TEXT,
    bot_enabled     INTEGER NOT NULL DEFAULT 1,          -- إيقاف يدوي من صفحة الأدمن
    silent_until    TEXT,                                -- صمت مؤقت بعد تدخّل الموظف
    handoff_reason  TEXT,
    contact_phone   TEXT,                                -- رقم تواصل بديل يذكره العميل
    customer_city   TEXT,                                -- مدينته أو المحطة التي يقصدها
    intake_done     INTEGER NOT NULL DEFAULT 0,          -- اكتملت بيانات الاستقبال
    assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at     TEXT,
    viewing_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    viewing_at      TEXT,
    last_message_at TEXT,
    created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
    UNIQUE (tenant_id, customer_wa)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id, last_message_at DESC)`,

  /* --- الرسائل: تُحفظ كلها حتى ما يتجاهله البوت، فالأدمن يحتاج السياق --- */
  `CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL,                    -- customer | bot | staff | system
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- أي موظف كتبها
    body            TEXT    NOT NULL DEFAULT '',
    media_type      TEXT,                                -- audio | image | document
    wa_message_id   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id DESC)`,

  /* --- سجل التدقيق: من فعل ماذا ومتى --- */
  `CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username   TEXT    NOT NULL DEFAULT '',   -- يُنسخ نصاً ليبقى بعد حذف الحساب
    action     TEXT    NOT NULL,              -- login | status_change | delete_customer | ...
    target     TEXT    NOT NULL DEFAULT '',
    detail     TEXT    NOT NULL DEFAULT '',
    ip         TEXT,
    created_at TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  /**
   * طلبات التجربة من صفحة الهبوط.
   *
   * جدول مستقل لا صلة له بالمنشآت: من يملأ النموذج ليس عميلاً بعد،
   * وربطه بمنشأة قبل أن يشترك يخلط المحتمَل بالقائم فتُفسد الإحصاءات.
   */
  `CREATE TABLE IF NOT EXISTS demo_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name   TEXT    NOT NULL,
    last_name    TEXT,
    email        TEXT    NOT NULL,
    company      TEXT    NOT NULL,
    phone        TEXT    NOT NULL,
    country      TEXT,
    role         TEXT,
    team_size    TEXT,
    marketing_ok INTEGER NOT NULL DEFAULT 0,
    lang         TEXT    NOT NULL DEFAULT 'ar',
    source_ip    TEXT,
    status       TEXT    NOT NULL DEFAULT 'new',   -- new | contacted | done | spam
    note         TEXT,
    created_at   TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_demo_requests_new ON demo_requests(status, id DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, id DESC)`,

  /* --- ثغرات المعرفة: أسئلة عجز عنها البوت مع عملاء حقيقيين --- */
  `CREATE TABLE IF NOT EXISTS knowledge_gaps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    question        TEXT    NOT NULL,
    normalized      TEXT    NOT NULL,          -- للتجميع: نفس السؤال بصيغ مختلفة
    reason          TEXT    NOT NULL DEFAULT '',
    occurrences     INTEGER NOT NULL DEFAULT 1,
    status          TEXT    NOT NULL DEFAULT 'open',  -- open | answered | ignored
    created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
    last_seen_at    TEXT    NOT NULL DEFAULT (${SQL_NOW}),
    UNIQUE (tenant_id, normalized)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gaps_tenant ON knowledge_gaps(tenant_id, status, occurrences DESC)`,

  /* --- استهلاك كل منشأة: للفوترة ولكشف من يستنزف رصيده --- */
  `CREATE TABLE IF NOT EXISTS usage_log (
    tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    month      TEXT    NOT NULL,              -- YYYY-MM بتوقيت الرياض
    replies    INTEGER NOT NULL DEFAULT 0,    -- ردود البوت
    tool_calls INTEGER NOT NULL DEFAULT 0,
    failures   INTEGER NOT NULL DEFAULT 0,
    followups  INTEGER NOT NULL DEFAULT 0,    -- متابعات قبل إغلاق النافذة
    -- توكنات الإدخال: المقروء من التخزين بعُشر السعر، والمكتوب بضعف وربع
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_written INTEGER NOT NULL DEFAULT 0,
    uncached      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, month)
  )`,

  /* --- سجل فحص الصحة: آخر نتيجة لكل فحص --- */
  `CREATE TABLE IF NOT EXISTS health_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    severity   TEXT    NOT NULL,              -- ok | warn | down
    summary    TEXT    NOT NULL,
    detail     TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,

  /* --- عدّادات الأرقام المرجعية المقروءة: SHK-2026-000147 --- */
  `CREATE TABLE IF NOT EXISTS counters (
    scope TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )`,

  /* --- تنبيهات الموظف: ما لم يُقرأ بعد يظهر في صفحة الأدمن --- */
  `CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    kind            TEXT    NOT NULL,                    -- complaint | handoff | booking
    title           TEXT    NOT NULL,
    body            TEXT    NOT NULL DEFAULT '',
    seen            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON alerts(tenant_id, seen, id DESC)`,
  /* --- رموز استرجاع كلمة المرور --- */
  `CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    -- الرمز مُجزّأ لا نصاً: من يقرأ القاعدة لا يدخل بحساب أحد.
    code_hash  TEXT    NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT    NOT NULL,
    used_at    TEXT,
    created_at TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id, used_at)`,
];


/**
 * أعمدة أُضيفت بعد الإطلاق.
 *
 * القاعدة التي أُنشئت قبل ميزة الفريق لا تملك هذه الأعمدة، و CREATE TABLE
 * IF NOT EXISTS لن يضيفها. تُمرَّر على ensureColumn عند كل إقلاع.
 * ملاحظة: SQLite لا يقبل REFERENCES في ALTER TABLE ADD COLUMN بقيمة
 * افتراضية غير ثابتة، فنكتفي هنا بالنوع — القيد قائم في الجداول الجديدة.
 */
export const CORE_COLUMNS: [table: string, column: string, definition: string][] = [
  ['users', 'wa_number', 'TEXT'],
  ['users', 'active', 'INTEGER NOT NULL DEFAULT 1'],
  // التحقق بخطوتين: السرّ يبقى محفوظاً بعد التعطيل ليعاد التفعيل بلا
  // إعداد جديد، والراية وحدها هي التي تقرّر.
  ['users', 'totp_secret', 'TEXT'],
  ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'totp_last_counter', 'INTEGER'],
  ['users', 'recovery_hashes', 'TEXT'],
  // صلاحيات الموظف: JSON. الفارغ يعني افتراضي الدور لا منعاً.
  ['users', 'permissions', 'TEXT'],
  // هوية المنشأة: لونها وشعارها. الفارغ يعني ألوان المنصة.
  ['tenants', 'brand_color', 'TEXT'],
  ['tenants', 'brand_deep', 'TEXT'],
  ['tenants', 'brand_logo', 'TEXT'],
  ['conversations', 'contact_phone', 'TEXT'],
  ['conversations', 'customer_city', 'TEXT'],
  ['conversations', 'intake_done', 'INTEGER NOT NULL DEFAULT 0'],
  ['conversations', 'assigned_to', 'INTEGER'],
  ['conversations', 'assigned_at', 'TEXT'],
  ['conversations', 'viewing_user_id', 'INTEGER'],
  ['conversations', 'viewing_at', 'TEXT'],
  // وسم التجربة: هو وحده ما يجيز الحذف. محادثة بلا وسم لا تُحذف أبداً.
  ['conversations', 'is_test', 'INTEGER NOT NULL DEFAULT 0'],
  // آخر متابعة أُرسلت — تُقارَن بآخر رسالة للعميل فلا تتكرر لنافذة واحدة.
  ['conversations', 'followup_at', 'TEXT'],
  /**
   * القناة التي وصلت منها المحادثة.
   *
   * افتراضها whatsapp فلا تُمَسّ البيانات القائمة. وقيمتها اليوم للعرض
   * والمنطق (نافذة كل قناة تختلف)، أما منع التصادم فيتكفّل به
   * channelKey أدناه — لأن UNIQUE (tenant_id, customer_wa) قائم في
   * الجدول، وSQLite لا يعدّل القيود بـALTER، وإعادة بناء جدول محادثات
   * عميل يعمل ليست مخاطرة تُحتمَل لأجل قناة لم تُبنَ بعد.
   */
  ['conversations', 'channel', "TEXT NOT NULL DEFAULT 'whatsapp'"],
  ['messages', 'user_id', 'INTEGER'],
  ['messages', 'media_path', 'TEXT'],
  ['messages', 'media_name', 'TEXT'],
  ['messages', 'media_mime', 'TEXT'],
  ['messages', 'media_bytes', 'INTEGER'],
  ['complaints', 'notified_status', 'TEXT'],
  ['tenants', 'retention_days', 'INTEGER NOT NULL DEFAULT 0'],
  ['tenants', 'wa_access_token', 'TEXT'],
  ['tenants', 'wa_app_secret', 'TEXT'],
  ['tenants', 'wa_app_id', 'TEXT'],
  ['tenants', 'wa_business_id', 'TEXT'],
  ['tenants', 'anthropic_api_key', 'TEXT'],
  ['tenants', 'anthropic_model', 'TEXT'],
  ['usage_log', 'followups', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_log', 'cache_read', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_log', 'cache_written', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_log', 'uncached', 'INTEGER NOT NULL DEFAULT 0'],
];
