/**
 * بيانات تجريبية.
 *
 * منشأتان مختلفتان عمداً — عيادة رسمية ومطعم ودّي — لأن أكثر ما يُخفي أخطاء
 * تعدد المنشآت هو الاختبار بمنشأة واحدة.
 *
 * كلمات المرور **تُولَّد عشوائياً وتُطبع مرة واحدة**. الثابتة منها تسري إلى
 * الإنتاج ثم تُنشر مع الكود، فيدخل كل من قرأ المستودع لوحة التحكم.
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.ts';
import { openDb, listTenants } from './db/index.ts';
import { migrateAll } from './modules/registry.ts';
import { createTenant, createUser, findUser } from './tenants.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
migrateAll(db);

/** ١٢ خانة عشوائية — قوية وقابلة للنسخ يدوياً. */
const newPassword = (): string => randomBytes(9).toString('base64url');

const created: [label: string, username: string, password: string][] = [];

if (!findUser(db, 'admin')) {
  const password = newPassword();
  createUser(db, {
    tenantId: null,
    username: 'admin',
    password,
    displayName: 'أدمن النظام',
    role: 'system',
  });
  created.push(['أدمن النظام', 'admin', password]);
}

if (listTenants(db).length === 0) {
  const clinicPassword = newPassword();
  const clinic = createTenant(db, {
    name: 'عيادة النور',
    waNumber: '966500000001',
    tone: 'formal',
    staffWaNumber: '966500000099',
    admin: { username: 'noor', password: clinicPassword, displayName: 'مالك عيادة النور' },
  });
  created.push([clinic.name, 'noor', clinicPassword]);

  const restaurantPassword = newPassword();
  const restaurant = createTenant(db, {
    name: 'مطعم الركن',
    waNumber: '966500000002',
    tone: 'friendly',
    staffWaNumber: '966500000098',
    admin: { username: 'rukn', password: restaurantPassword, displayName: 'مالك مطعم الركن' },
  });
  created.push([restaurant.name, 'rukn', restaurantPassword]);
}

if (created.length === 0) {
  console.log('لا جديد — الحسابات والمنشآت موجودة بالفعل.');
} else {
  console.log('\n  احفظي هذه الآن — لن تُعرض مرة أخرى:\n');
  for (const [label, username, password] of created) {
    console.log(`    ${username.padEnd(8)} ${password.padEnd(14)} ${label}`);
  }
  console.log('\n  غيّريها من شاشة «الموظفون» بعد أول دخول.\n');
}

db.close();
