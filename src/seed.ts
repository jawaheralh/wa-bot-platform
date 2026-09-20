/**
 * بيانات تجريبية.
 *
 * منشأتان مختلفتان عمداً — عيادة رسمية ومطعم ودّي — لأن أكثر ما يُخفي أخطاء
 * تعدد المنشآت هو الاختبار بمنشأة واحدة.
 */

import { loadConfig } from './config.ts';
import { openDb, listTenants } from './db/index.ts';
import { migrateAll } from './modules/registry.ts';
import { createTenant, createUser, findUser } from './tenants.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
migrateAll(db);

if (!findUser(db, 'admin')) {
  createUser(db, {
    tenantId: null,
    username: 'admin',
    password: 'admin12345',
    displayName: 'أدمن النظام',
    role: 'system',
  });
  console.log('أُنشئ أدمن النظام:  admin / admin12345');
}

if (listTenants(db).length === 0) {
  const clinic = createTenant(db, {
    name: 'عيادة النور',
    waNumber: '966500000001',
    tone: 'formal',
    staffWaNumber: '966500000099',
    admin: { username: 'noor', password: 'noor12345', displayName: 'أدمن عيادة النور' },
  });
  const restaurant = createTenant(db, {
    name: 'مطعم الركن',
    waNumber: '966500000002',
    tone: 'friendly',
    staffWaNumber: '966500000098',
    admin: { username: 'rukn', password: 'rukn12345', displayName: 'أدمن مطعم الركن' },
  });
  console.log(`أُنشئت منشأتان: ${clinic.name} (${clinic.wa_number}) و ${restaurant.name} (${restaurant.wa_number})`);
  console.log('مستخدمو المنشآت:  noor / noor12345   و   rukn / rukn12345');
} else {
  console.log('توجد منشآت بالفعل — لم يُضف شيء.');
}

db.close();
