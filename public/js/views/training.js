/**
 * تدريب البوت.
 *
 * كل سؤال هنا عجز عنه البوت مع عميل حقيقي فحوّله لموظف. الإجابة عليه
 * تُضيفه للمعرفة وتمنع التحويل التالي — فالقائمة تقصر كلما استُعملت.
 */

import { get, post, patch, esc, ago, guard, flash, state } from '../core.js';

export async function renderTraining(main) {
  const status = state.trainingFilter ?? 'open';
  const { gaps, summary } = await get(`/api/tenants/${state.tenantId}/gaps?status=${status}`);
  const canEdit = state.me.role !== 'agent';

  main.innerHTML = `
    <h2>تدريب البوت</h2>
    <p class="subtitle">
      كل سؤال هنا عجز عنه البوت مع عميل حقيقي فحوّله لموظف.
      الإجابة عليه تمنع التحويل التالي.
    </p>

    <div class="kpis">
      <div class="kpi"><div class="kpi-label">أسئلة تنتظر جواباً</div><div class="kpi-value">${summary.open}</div></div>
      <div class="kpi"><div class="kpi-label">تحويلات كان يمكن تفاديها</div><div class="kpi-value">${summary.missedAnswers}</div></div>
    </div>

    <div class="card">
      <div class="actions" style="margin:0 0 12px">
        ${['open', 'answered', 'ignored', 'all']
          .map(
            (s) =>
              `<button class="btn ${s === status ? '' : 'ghost'} small" data-filter="${s}">${
                { open: 'تنتظر جواباً', answered: 'أُجيب عنها', ignored: 'مُهملة', all: 'الكل' }[s]
              }</button>`,
          )
          .join('')}
      </div>

      ${
        gaps.length
          ? gaps
              .map(
                (g) => `
        <div class="module" style="margin-bottom:12px">
          <h4>
            ${esc(g.question)}
            ${g.occurrences > 1 ? `<span class="badge red">تكرر ${g.occurrences} مرات</span>` : ''}
            ${g.status === 'answered' ? '<span class="badge green">أُجيب</span>' : ''}
            ${g.status === 'ignored' ? '<span class="badge grey">مُهمل</span>' : ''}
          </h4>
          <p class="muted">
            آخر مرة ${esc(ago(g.last_seen_at))}${g.reason ? ` · سبب التحويل: ${esc(g.reason)}` : ''}
          </p>
          ${
            g.similar?.length
              ? `<p class="muted" style="background:#f4f6f8;padding:8px;border-radius:8px">
                   جوابك يغطي أيضاً: ${g.similar.map((s) => `«${esc(s.question)}»`).join(' · ')}
                 </p>`
              : ''
          }
          ${
            canEdit && g.status !== 'answered'
              ? `<label for="a-${g.id}">الجواب الذي تريدين أن يقوله البوت</label>
                 <textarea id="a-${g.id}" placeholder="اكتبي الجواب بأسلوبك — البوت سيقوله حرفياً"></textarea>
                 <div class="actions">
                   <button class="btn small" data-answer="${g.id}">أضيفي للمعرفة</button>
                   <button class="btn ghost small" data-ignore="${g.id}">أهمليه</button>
                 </div>`
              : g.status !== 'open' && canEdit
                ? `<div class="actions">
                     <button class="btn ghost small" data-reopen="${g.id}">أعيديه للقائمة</button>
                   </div>`
                : ''
          }
        </div>`,
              )
              .join('')
          : `<div class="empty">${
              status === 'open'
                ? 'لا أسئلة معلّقة — البوت يجيب على كل ما وصله.'
                : 'لا شيء هنا.'
            }</div>`
      }
    </div>

    <div class="card">
      <h3>كيف تكتبين جواباً جيداً</h3>
      <ul class="muted" style="margin:0;padding-inline-start:20px;line-height:2">
        <li>اكتبيه كما تقولينه للعميل — البوت ينقله بأسلوبه لا حرفياً كالببغاء.</li>
        <li>أرقاماً دقيقة لا تقريبية: «٥ محطات» لا «عدة محطات».</li>
        <li>ما لا تريدين للبوت قوله، لا تكتبيه — لن يخترعه.</li>
        <li>جواب واحد يكفي لعدة صيغ من السؤال؛ البوت يفهم المعنى.</li>
      </ul>
    </div>
  `;

  main.querySelectorAll('[data-filter]').forEach((button) => {
    button.onclick = () => {
      state.trainingFilter = button.dataset.filter;
      renderTraining(main);
    };
  });

  main.querySelectorAll('[data-answer]').forEach((button) => {
    button.onclick = guard(async () => {
      const id = button.dataset.answer;
      const answer = document.getElementById(`a-${id}`).value.trim();
      if (!answer) {
        flash('اكتبي الجواب أولاً.', 'error');
        return;
      }
      const result = await post(`/api/tenants/${state.tenantId}/gaps/${id}/answer`, { answer });
      flash(
        result.closed?.length
          ? `أُضيف للمعرفة، وأُغلق معه ${result.closed.length} سؤالاً مشابهاً.`
          : 'أُضيف للمعرفة — لن يحوّل البوت هذا السؤال بعد الآن.',
      );
      await renderTraining(main);
    });
  });

  main.querySelectorAll('[data-reopen]').forEach((button) => {
    button.onclick = guard(async () => {
      await patch(`/api/tenants/${state.tenantId}/gaps/${button.dataset.reopen}`, { status: 'open' });
      flash('أُعيد للقائمة.');
      await renderTraining(main);
    });
  });

  main.querySelectorAll('[data-ignore]').forEach((button) => {
    button.onclick = guard(async () => {
      await patch(`/api/tenants/${state.tenantId}/gaps/${button.dataset.ignore}`, { status: 'ignored' });
      await renderTraining(main);
    });
  });
}
