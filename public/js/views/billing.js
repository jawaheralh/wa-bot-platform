/**
 * استهلاك ميتا: ما مُنح، وما استُهلك، وما يُحاسَب عليه العميل.
 *
 * المالك يرى استهلاكه ولا يعدّل منحته ولا سقفه — تلك شروط عقدٍ لا
 * إعداد تشغيل، ومالكٌ يرفع سقف نفسه يُلغي معنى الاتفاق. فالتعديل
 * لأدمن النظام وحده، ويظهر له في نفس الشاشة.
 */

import { get, put, esc, guard, flash, state } from '../core.js';

const riyals = (halalas) => (halalas / 100).toFixed(2);

export async function renderBilling(main) {
  const data = await get(`/api/tenants/${state.tenantId}/billing`);
  const isSystem = state.me.role === 'system';
  const spent = data.used;

  main.innerHTML = `
    <h2>استهلاك ميتا</h2>
    <p class="subtitle">
      شهر ${esc(data.month)} · التكلفة على حساب واتساب للأعمال الخاص بالمنشأة
      <span class="badge grey">صلاحية المالك</span>
    </p>

    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">محادثات مدفوعة</div>
        <div class="kpi-value">${data.conversations}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">استُهلك</div>
        <div class="kpi-value">${riyals(spent)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">ضمن الاشتراك</div>
        <div class="kpi-value">${riyals(data.credit)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">${data.overage > 0 ? 'يُحاسَب عليه' : 'المتبقي من المنحة'}</div>
        <div class="kpi-value">${data.overage > 0 ? riyals(data.overage) : riyals(Math.max(0, data.remaining))}</div>
      </div>
    </div>

    ${
      !data.allowed
        ? `<div class="card"><div class="error">${esc(data.reason)}</div></div>`
        : data.cap > 0 && spent > data.cap * 0.8
          ? `<div class="card"><div class="warn-box">
               اقترب الاستهلاك من السقف (${riyals(data.cap)} ريالاً). عند بلوغه يتوقف إرسال القوالب.
             </div></div>`
          : ''
    }

    <div class="card">
      <h3>أسعار المحادثة</h3>
      <p class="muted" style="margin-top:0">
        بالهللة لكل محادثة. تقديرية وتُضبط من أسعار ميتا المعلنة — فهي تختلف بالدولة وتتغيّر.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>التصنيف</th><th>السعر</th></tr></thead>
        <tbody>
          ${Object.entries(data.categories)
            .map(
              ([key, label]) => `<tr>
                <td>${esc(label)}</td>
                <td>${
                  isSystem
                    ? `<input class="num" data-rate="${key}" type="number" min="0" value="${data.rates[key] ?? 0}" style="max-width:110px">`
                    : `<span class="num">${data.rates[key] ?? 0}</span>`
                } هللة</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>
    </div>

    ${
      isSystem
        ? `<div class="card">
            <h3>شروط الاشتراك</h3>
            <div class="row">
              <div>
                <label for="credit">المنحة الشهرية (هللة)</label>
                <input id="credit" class="num" type="number" min="0" value="${data.credit}">
                <p class="muted" style="margin:4px 0 0">ما يتحمّله الاشتراك. ما بعده يُحاسَب على العميل.</p>
              </div>
              <div>
                <label for="cap">السقف الصارم (هللة)</label>
                <input id="cap" class="num" type="number" min="0" value="${data.cap}">
                <p class="muted" style="margin:4px 0 0">عند بلوغه يتوقف إرسال القوالب. الصفر = بلا سقف.</p>
              </div>
            </div>
            <div class="actions"><button class="btn" id="save">حفظ</button></div>
          </div>`
        : `<div class="card">
            <p class="muted" style="margin:0">
              المنحة والسقف يضبطهما مزوّد الخدمة. وما يتجاوز المنحة يُحاسَب على المنشأة
              ضمن فاتورة حساب واتساب للأعمال الخاص بها.
            </p>
          </div>`
    }
  `;

  if (!isSystem) return;

  main.querySelector('#save').onclick = guard(async () => {
    const rates = {};
    main.querySelectorAll('[data-rate]').forEach((input) => {
      rates[input.dataset.rate] = Number(input.value);
    });

    await put(`/api/tenants/${state.tenantId}/billing`, {
      credit: Number(main.querySelector('#credit').value),
      cap: Number(main.querySelector('#cap').value),
      rates,
    });
    flash('حُفظت شروط الاشتراك.');
    await renderBilling(main);
  });
}
