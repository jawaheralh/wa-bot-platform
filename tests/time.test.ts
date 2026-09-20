/**
 * اتساق التوقيت (الرياض في كل مكان).
 * هذا القسم مستقل عن ساعة التشغيل عمداً — الاختبارات كانت تسقط مساءً في
 * مشروع 9200 لهذا السبب بالذات.
 */

import { describe, it, expect } from 'vitest';
import {
  SQL_NOW,
  SQL_TODAY,
  now,
  today,
  fromSql,
  addMinutes,
  addHours,
  diffMinutes,
  formatDateAr,
  formatTimeAr,
  dayNameAr,
  parseArabicDate,
} from '../src/time.ts';
import { freshDb } from './helpers.ts';

describe('التوقيت', () => {
  it('ثوابت SQL تستعمل إزاحة الرياض لا UTC', () => {
    expect(SQL_NOW).toContain('+3 hours');
    expect(SQL_TODAY).toContain('+3 hours');
  });

  it('now() تُنتج صيغة SQLite بلا T ولا Z', () => {
    expect(now(new Date('2026-09-21T06:35:00Z'))).toBe('2026-09-21 09:35:00');
  });

  it('منتصف الليل بتوقيت الرياض يُكتب 00 لا 24', () => {
    expect(now(new Date('2026-09-20T21:00:00Z'))).toBe('2026-09-21 00:00:00');
  });

  it('SQL_NOW في القاعدة يطابق now() في جافاسكربت', () => {
    const db = freshDb();
    const row = db.prepare(`SELECT ${SQL_NOW} AS t, ${SQL_TODAY} AS d`).get() as { t: string; d: string };
    // فرق ثانية أو ثانيتين وارد بين النداءين، لكن ليس فرق ساعات.
    expect(Math.abs(diffMinutes(now(), row.t))).toBeLessThan(2);
    expect(row.d).toBe(today());
    db.close();
  });

  it('fromSql تفسّر النص كتوقيت رياض', () => {
    expect(fromSql('2026-09-21 09:35:00').toISOString()).toBe('2026-09-21T06:35:00.000Z');
  });

  it('الإضافة والفرق بالدقائق', () => {
    expect(addMinutes('2026-09-21 09:35:00', 45)).toBe('2026-09-21 10:20:00');
    expect(addHours('2026-09-21 23:00:00', 2)).toBe('2026-09-22 01:00:00');
    expect(diffMinutes('2026-09-21 09:00:00', '2026-09-21 11:30:00')).toBe(150);
  });

  it('العرض بالعربي', () => {
    expect(dayNameAr('2026-09-21')).toBe('الإثنين');
    expect(formatDateAr('2026-09-21')).toBe('الإثنين 21 سبتمبر 2026');
    expect(formatTimeAr('09:35')).toBe('09:35 صباحاً');
    expect(formatTimeAr('20:05')).toBe('08:05 ليلاً');
  });

  it('فهم التعبيرات العامية للتواريخ', () => {
    expect(parseArabicDate('بكرة', '2026-09-21')).toBe('2026-09-22');
    expect(parseArabicDate('بعد بكرة', '2026-09-21')).toBe('2026-09-23');
    expect(parseArabicDate('اليوم', '2026-09-21')).toBe('2026-09-21');
    expect(parseArabicDate('2026-10-01', '2026-09-21')).toBe('2026-10-01');
    // الإثنين ٢١ سبتمبر ⇐ «الخميس الجاي» هو ٢٤
    expect(parseArabicDate('الخميس الجاي', '2026-09-21')).toBe('2026-09-24');
  });

  it('التعبير غير المفهوم يُعيد null بدل تخمين يوم خاطئ', () => {
    expect(parseArabicDate('قريباً', '2026-09-21')).toBeNull();
    expect(parseArabicDate('', '2026-09-21')).toBeNull();
  });
});
