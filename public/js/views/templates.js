/**
 * قوالب واتساب: إنشاؤها ومتابعة اعتمادها.
 *
 * القالب هو الإذن الوحيد لمراسلة عميلٍ خارج نافذة الأربع والعشرين
 * ساعة. وإنشاؤه في واجهة Meta يمرّ بأربع شاشات ويُعاد لكل عميل على
 * حدة — فهو هنا بنموذج واحد.
 *
 * والحالات الثلاث تُعرض كلها لا المعتمد وحده: المعلّق يُنتظر، والمرفوض
 * يُصحَّح — وإخفاؤهما يجعل المالك يُنشئ القالب مرة بعد مرة ويظنّ أن
 * النظام لا يحفظه.
 */

import { get, post, del, esc, guard, flash, state } from '../core.js';

const STATUS_AR = {
  APPROVED: ['معتمد', 'green'],
  PENDING: ['قيد المراجعة', 'amber'],
  REJECTED: ['مرفوض', 'red'],
  PAUSED: ['موقوف', 'grey'],
  DISABLED: ['معطّل', 'grey'],
};

export async function renderTemplates(main) {
  main.innerHTML = '<h2>القوالب</h2><div class="empty">جارٍ القراءة من Meta…</div>';

  const data = await get(`/api/tenants/${state.tenantId}/templates/all`);

  if (!data.ok) {
    main.innerHTML = `
      <h2>القوالب</h2>
      <div class="card"><div class="warn-box">${esc(data.message)}</div>
        <p class="muted" style="margin:10px 0 0">
          القوالب تُقرأ من حساب Meta الخاص بالمنشأة. تُضبط بياناته من <strong>الإعداد</strong>.
        </p>
      </div>`;
    return;
  }

  main.innerHTML = `
    <h2>القوالب</h2>
    <p class="subtitle">
      ${data.templates.length} قالباً · القالب هو الإذن الوحيد لمراسلة عميل مضى على آخر رسالة منه ٢٤ ساعة
      <span class="badge grey">صلاحية المالك</span>
    </p>

    <div class="card">
      <h3>قوالب جاهزة</h3>
      <p class="muted" style="margin-top:0">
        مكتوبة بصياغة تمرّ مراجعة Meta. أكثر ما يُرفض يُرفض لصياغته لا لفكرته.
      </p>
      <div class="grid">
        ${data.suggested
          .map((s, i) => {
            const exists = data.templates.some((t) => t.name === s.name);
            return `
              <div class="module${exists ? ' off' : ''}">
                <h4>${esc(s.title)}</h4>
                <p>${esc(s.why)}</p>
                <div class="secret" style="font-size:13px;letter-spacing:0">${esc(s.body)}</div>
                <div class="actions">
                  ${
                    exists
                      ? '<span class="badge green">مُنشأ بالفعل</span>'
                      : `<button class="btn small" data-suggest="${i}">إنشاء</button>`
                  }
                </div>
              </div>`;
          })
          .join('')}
      </div>
    </div>

    <div class="card">
      <h3>قوالب المنشأة</h3>
      ${
        data.templates.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>الاسم</th><th>النصّ</th><th>التصنيف</th><th>اللغة</th><th>الحالة</th><th></th>
              </tr></thead>
              <tbody>${data.templates.map(row).join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا قوالب بعد.</div>'
      }
    </div>

    <div class="card">
      <h3>قالب جديد</h3>
      <div class="row">
        <div>
          <label for="tName">الاسم</label>
          <input id="tName" dir="ltr" placeholder="order_update">
          <p class="muted" style="margin:4px 0 0">حروف إنجليزية صغيرة وأرقام وشرطة سفلية.</p>
        </div>
        <div>
          <label for="tLang">اللغة</label>
          <select id="tLang"><option value="ar">العربية</option><option value="en_US">English</option></select>
        </div>
        <div style="min-width:260px">
          <label for="tCat">التصنيف</label>
          <select id="tCat">
            ${Object.entries(data.categories)
              .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
              .join('')}
          </select>
        </div>
      </div>

      <label for="tBody">نصّ الرسالة</label>
      <textarea id="tBody" placeholder="سجّلنا طلبك برقم {{1}}. تقدر تتابعه في أي وقت."></textarea>
      <p class="muted" style="margin:4px 0 0">
        المتغيّر يُكتب <span class="mono">{{1}}</span> ثم <span class="mono">{{2}}</span> بالتسلسل.
        وMeta تطلب مثالاً واقعياً لكلٍّ منها.
      </p>

      <div id="examples"></div>

      <div class="row" style="margin-top:10px">
        <div><label for="tHeader">ترويسة (اختياري)</label><input id="tHeader" maxlength="60"></div>
        <div><label for="tFooter">تذييل (اختياري)</label><input id="tFooter" maxlength="60"></div>
      </div>

      <div class="actions"><button class="btn" id="tCreate">إرسال للمراجعة</button></div>
    </div>
  `;

  /* --- أمثلة المتغيّرات تظهر بعدد ما يُكتب في النصّ --- */

  const bodyInput = main.querySelector('#tBody');
  const examplesBox = main.querySelector('#examples');

  function drawExamples() {
    const count = new Set([...bodyInput.value.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    examplesBox.innerHTML = count
      ? `<div class="row" style="margin-top:10px">${Array.from({ length: count })
          .map(
            (_, i) => `<div>
              <label for="ex${i}">مثال {{${i + 1}}}</label>
              <input id="ex${i}" data-example="${i}" placeholder="قيمة واقعية">
            </div>`,
          )
          .join('')}</div>`
      : '';
  }

  bodyInput.oninput = drawExamples;
  drawExamples();

  /* --- الإنشاء --- */

  async function create(payload) {
    const result = await post(`/api/tenants/${state.tenantId}/templates`, payload);
    flash(result.message);
    await renderTemplates(main);
  }

  main.querySelector('#tCreate').onclick = guard(() =>
    create({
      name: main.querySelector('#tName').value,
      language: main.querySelector('#tLang').value,
      category: main.querySelector('#tCat').value,
      body: bodyInput.value,
      header: main.querySelector('#tHeader').value,
      footer: main.querySelector('#tFooter').value,
      examples: [...main.querySelectorAll('[data-example]')].map((i) => i.value),
    }),
  );

  main.querySelectorAll('[data-suggest]').forEach((button) => {
    button.onclick = guard(() => create(data.suggested[Number(button.dataset.suggest)]));
  });

  main.querySelectorAll('[data-drop]').forEach((button) => {
    button.onclick = guard(async () => {
      if (!confirm(`حذف القالب «${button.dataset.drop}»؟ الرسائل التي تعتمد عليه تتوقف.`)) return;
      const result = await del(`/api/tenants/${state.tenantId}/templates/${button.dataset.drop}`);
      flash(result.message);
      await renderTemplates(main);
    });
  });
}

function row(t) {
  const [label, tone] = STATUS_AR[t.status] ?? [t.status, 'grey'];
  return `
    <tr>
      <td class="mono">${esc(t.name)}</td>
      <td>${esc(t.body)}${
        t.variables ? `<br><span class="muted">${t.variables} متغيّراً</span>` : ''
      }</td>
      <td class="muted">${esc(t.category)}</td>
      <td class="muted">${esc(t.language)}</td>
      <td><span class="badge ${tone}">${esc(label)}</span></td>
      <td><button class="btn ghost small" data-drop="${esc(t.name)}">حذف</button></td>
    </tr>`;
}
