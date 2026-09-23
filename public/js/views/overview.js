/** نظرة عامة على المنشأة: أرقام سريعة وحالة الاتصال. */

import { get, post, esc, el, guard } from '../core.js';
import { state } from '../core.js';

export async function renderOverview(main) {
  const data = await get(`/api/tenants/${state.tenantId}`);
  const { tenant, stats, connection, modules, readOnly } = data;

  const enabled = modules.filter((m) => m.enabled);
  const disabled = modules.filter((m) => !m.enabled);

  main.innerHTML = `
    ${
      readOnly
        ? `<div class="error" style="background:#fdf3e2;color:#b7791f;border:1px solid #f0d9a8">
             👁 <strong>وضع «عرض فقط»</strong> — تُستقبل رسائل العملاء وتُحفظ وتظهر هنا،
             ولا يُرسل النظام أي رد أو تنبيه إطلاقاً. لتفعيل الرد أزيلي
             <span class="mono">READ_ONLY</span> من ملف <span class="mono">.env</span>.
           </div>`
        : ''
    }
    <h2>${esc(tenant.name)}</h2>
    <p class="subtitle">
      الرقم <span class="num">${esc(tenant.wa_number)}</span> ·
      النبرة ${tenant.tone === 'formal' ? 'رسمية' : 'ودّية'} ·
      ${tenant.status === 'active' ? '<span class="badge green">نشطة</span>' : '<span class="badge red">موقوفة</span>'}
    </p>

    <div class="kpis">
      <div class="kpi"><div class="kpi-label">المحادثات</div><div class="kpi-value">${stats.conversations}</div></div>
      <div class="kpi"><div class="kpi-label">شكاوى جديدة</div><div class="kpi-value">${stats.newComplaints}</div></div>
      <div class="kpi"><div class="kpi-label">تحويلات مفتوحة</div><div class="kpi-value">${stats.openHandoffs}</div></div>
      <div class="kpi"><div class="kpi-label">تنبيهات غير مقروءة</div><div class="kpi-value">${stats.unseenAlerts}</div></div>
    </div>

    <div class="card">
      <h3>حالة الاتصال بواتساب</h3>
      <p class="muted">المزوّد: <span class="num">${esc(connection.provider)}</span> —
        ${connection.connected ? '<span class="badge green">متصل</span>' : '<span class="badge amber">غير متصل</span>'}
        ${connection.detail ? ` · ${esc(connection.detail)}` : ''}</p>
      ${
        connection.qr
          ? `<div style="text-align:center;padding:12px">
               <img src="/api/tenants/${state.tenantId}/qr?t=${Date.now()}" alt="رمز QR"
                    style="width:280px;height:280px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px">
               <p class="muted" style="margin:10px 0 0">
                 واتساب على جوالك ← الإعدادات ← <strong>الأجهزة المرتبطة</strong> ← ربط جهاز ← وجّهي الكاميرا للرمز.
                 <br>الرمز يتجدد كل ٢٠ ثانية — اضغطي «تحديث» إن انتهت صلاحيته.
               </p>
               <button class="btn ghost small" id="refreshQr" style="margin-top:8px">تحديث الرمز</button>
             </div>`
          : ''
      }
    </div>

    <div class="card">
      <h3>الوحدات المفعّلة</h3>
      <p class="muted">${enabled.map((m) => esc(m.titleAr)).join(' · ') || 'لا شيء'}</p>
      ${disabled.length ? `<p class="muted">غير مفعّلة: ${disabled.map((m) => esc(m.titleAr)).join(' · ')}</p>` : ''}
    </div>

    <div class="card">
      <h3>آخر التنبيهات</h3>
      <div id="alerts" class="empty">جارٍ التحميل…</div>
    </div>
  `;

  if (connection.qr) {
    document.getElementById('refreshQr').onclick = () => renderOverview(main);
    // الرمز ينتهي خلال ثوانٍ؛ التحديث التلقائي يجنّب المستخدم رمزاً ميتاً.
    setTimeout(() => {
      if (document.getElementById('refreshQr')) renderOverview(main);
    }, 20000);
  }

  const alerts = await get(`/api/tenants/${state.tenantId}/alerts`);
  const box = document.getElementById('alerts');
  if (!alerts.length) {
    box.textContent = 'لا توجد تنبيهات.';
    return;
  }
  box.classList.remove('empty');
  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>التنبيه</th><th>التفاصيل</th><th>الوقت</th></tr></thead>
      <tbody>${alerts
        .slice(0, 15)
        .map(
          (a) => `<tr>
            <td>${a.seen ? '' : '<span class="badge red">جديد</span> '}${esc(a.title)}</td>
            <td class="muted">${esc(a.body).replace(/\n/g, '<br>')}</td>
            <td class="num muted">${esc(a.created_at.slice(5, 16))}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <div class="actions"><button class="btn ghost small" id="seen">تعليم الكل كمقروء</button></div>
  `;
  document.getElementById('seen').onclick = guard(async () => {
    await post(`/api/tenants/${state.tenantId}/alerts/seen`);
    renderOverview(main);
  });
}
