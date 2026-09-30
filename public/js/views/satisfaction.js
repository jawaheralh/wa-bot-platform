/**
 * رضا العملاء.
 *
 * الرقم الأهم هنا ليس المتوسط بل **نسبة من أجابوا**: متوسطُ ٤٫٨ من
 * ثلاثة ردود لا يقول شيئاً عن مئة عميل صامت. فتُعرض النسبتان معاً.
 */

import { get, esc, state } from '../core.js';

const KIND_AR = { request: 'طلب', complaint: 'شكوى' };

export async function renderSatisfaction(main) {
  const { summary, ratings } = await get(`/api/tenants/${state.tenantId}/satisfaction`);
  const answered = ratings.filter((r) => r.rating !== null);

  main.innerHTML = `
    <h2>رضا العملاء</h2>
    <p class="subtitle">آخر ٣٠ يوماً · السؤال يُرسل آخر اليوم بعد إغلاق الطلب أو الشكوى</p>

    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">نسبة الرضا (٤ و٥)</div>
        <div class="kpi-value">${summary.csat === null ? '—' : `${summary.csat}٪`}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">متوسط التقييم</div>
        <div class="kpi-value">${summary.average === null ? '—' : summary.average}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">أجابوا</div>
        <div class="kpi-value">${summary.answered}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">سُئلوا</div>
        <div class="kpi-value">${summary.asked}</div>
      </div>
    </div>

    ${
      summary.asked === 0
        ? `<div class="card"><div class="warn-box">
             لم يُرسل أي سؤال بعد. يُفعَّل من <strong>الوحدات ← الطلبات</strong>
             بعد اعتماد قالب التقييم من <strong>القوالب</strong>.
           </div></div>`
        : ''
    }

    ${summary.answered ? distribution(summary.distribution, summary.answered) : ''}

    <div class="card">
      <h3>الردود</h3>
      ${
        ratings.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>التقييم</th><th>على</th><th>العميل</th><th>ما كتبه</th><th>سُئل</th>
              </tr></thead>
              <tbody>${ratings.map(row).join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا ردود بعد.</div>'
      }
      ${
        ratings.length && !answered.length
          ? `<p class="muted" style="margin-top:10px">
               أُرسلت الأسئلة ولم يُجب أحد بعد. الردّ يُقبل حتى ٢٠ ساعة من السؤال.
             </p>`
          : ''
      }
    </div>
  `;
}

/** توزيع التقديرات — العمود يقول أكثر من الرقم. */
function distribution(counts, total) {
  return `
    <div class="card">
      <h3>توزيع التقديرات</h3>
      ${[5, 4, 3, 2, 1]
        .map((score) => {
          const n = counts[score] ?? 0;
          const percent = total ? Math.round((n / total) * 100) : 0;
          const tone = score >= 4 ? 'var(--accent)' : score === 3 ? '#c9a227' : 'var(--danger)';
          return `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <span style="width:34px">${score} ★</span>
              <div style="flex:1;background:var(--bg);border-radius:999px;height:14px;overflow:hidden">
                <div style="width:${percent}%;height:100%;background:${tone}"></div>
              </div>
              <span class="num muted" style="width:70px">${n} · ${percent}٪</span>
            </div>`;
        })
        .join('')}
    </div>`;
}

function row(r) {
  const tone = r.rating === null ? 'grey' : r.rating >= 4 ? 'green' : r.rating === 3 ? 'amber' : 'red';
  return `
    <tr>
      <td><span class="badge ${tone}">${r.rating === null ? 'بانتظار الرد' : `${r.rating} من ٥`}</span></td>
      <td class="num">${esc(KIND_AR[r.kind] ?? r.kind)} ${esc(r.reference)}</td>
      <td class="num muted">${esc(r.customer_wa)}</td>
      <td>${esc(r.comment ?? '—')}</td>
      <td class="num muted">${esc(r.asked_at.slice(0, 16))}</td>
    </tr>`;
}
