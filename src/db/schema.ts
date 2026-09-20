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
    role          TEXT    NOT NULL,                      -- system | tenant
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
    body            TEXT    NOT NULL DEFAULT '',
    media_type      TEXT,                                -- audio | image | document
    wa_message_id   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id DESC)`,

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
];
