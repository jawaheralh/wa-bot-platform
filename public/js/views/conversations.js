/** المحادثات: العرض، والإسناد، وإيقاف/تشغيل البوت، والرد اليدوي. */

import { get, post, esc, ago, guard, flash, state } from '../core.js';

const ROLE_LABEL = { customer: 'العميل', bot: 'البوت', staff: 'الموظف', system: 'النظام' };

const MEDIA_AR = {
  image: 'صورة', document: 'ملف', audio: 'رسالة صوتية',
  video: 'فيديو', sticker: 'ملصق', location: 'موقع', contact: 'جهة اتصال',
};

/** يعرض المرفق: الصورة تُعرض، والصوت والفيديو يُشغَّلان، والبقية رابط تنزيل. */
function attachment(m) {
  if (!m.media_path) return '';
  const url = `/api/tenants/${state.tenantId}/media/${m.id}`;
  const mime = m.media_mime || '';
  const size = m.media_bytes ? ` · ${Math.round(m.media_bytes / 1024)} ك.ب` : '';

  if (mime.startsWith('image/')) {
    return `<a href="${url}" target="_blank" rel="noopener">
      <img src="${url}" alt="${esc(MEDIA_AR[m.media_type] || 'مرفق')}"
           style="max-width:220px;border-radius:8px;display:block;margin:6px 0"></a>`;
  }
  if (mime.startsWith('audio/')) {
    return `<audio controls src="${url}" style="display:block;margin:6px 0;max-width:240px"></audio>`;
  }
  if (mime.startsWith('video/')) {
    return `<video controls src="${url}" style="max-width:240px;border-radius:8px;display:block;margin:6px 0"></video>`;
  }
  return `<a class="btn ghost small" href="${url}" target="_blank" rel="noopener" style="margin:6px 0">
    ⬇ ${esc(m.media_name || MEDIA_AR[m.media_type] || 'ملف')}${size}</a>`;
}

export async function renderConversations(main) {
  const [list, { staff }] = await Promise.all([
    get(`/api/tenants/${state.tenantId}/conversations`),
    get(`/api/tenants/${state.tenantId}/staff`),
  ]);
  const active = staff.filter((s) => s.active);

  main.innerHTML = `
    <h2>المحادثات</h2>
    <p class="subtitle">${list.length} محادثة · اضغطي على محادثة لعرضها والرد فيها</p>
    <div class="card">
      ${
        list.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>العميل</th><th>آخر رسالة</th><th>النشاط</th><th>المسؤول</th><th>البوت</th><th></th>
              </tr></thead>
              <tbody>${list
                .map(
                  (c) => `<tr>
                    <td>${esc(c.customer_name || '—')}
                      ${c.customer_city ? `<span class="badge grey">${esc(c.customer_city)}</span>` : ''}
                      <br><span class="num muted">${esc(c.customer_wa)}</span></td>
                    <td class="muted">${esc((c.last_body || '').slice(0, 70))}</td>
                    <td class="muted">${esc(ago(c.last_message_at))}</td>
                    <td>${
                      c.assigned_name
                        ? `<span class="badge ${c.assigned_to === state.me.id ? 'green' : 'grey'}">${esc(
                            c.assigned_name,
                          )}</span>`
                        : '<span class="muted">—</span>'
                    }</td>
                    <td>${
                      c.bot_enabled
                        ? c.silent
                          ? '<span class="badge amber">صامت مؤقتاً</span>'
                          : '<span class="badge green">يعمل</span>'
                        : '<span class="badge red">موقوف</span>'
                    }</td>
                    <td><button class="btn ghost small" data-open="${c.id}">فتح</button></td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد محادثات بعد.</div>'
      }
    </div>
    <div id="thread"></div>
  `;

  main.querySelectorAll('[data-open]').forEach((button) => {
    button.onclick = guard(() => openThread(Number(button.dataset.open), main, active));
  });

  /**
   * المحادثة المفتوحة تُعاد بعد كل رسم.
   *
   * التحديث المباشر يُعيد رسم الشاشة كلما وصلت رسالة، فبلا هذا تُغلق
   * المحادثة تحت يد الموظفة وهي تقرأها — وكلما زاد نشاط العملاء ساء
   * الأمر، فتصير الميزة عائقاً.
   */
  if (state.openConversation && list.some((r) => r.id === state.openConversation)) {
    await openThread(state.openConversation, main, active);
  }
}

async function openThread(conversationId, main, staff) {
  state.openConversation = conversationId;
  const { conversation, messages, assigneeName, viewer } = await get(
    `/api/tenants/${state.tenantId}/conversations/${conversationId}`,
  );

  const assignedToOther = conversation.assigned_to && conversation.assigned_to !== state.me.id;

  const thread = document.getElementById('thread');
  thread.innerHTML = `
    <div class="card">
      <h3>${esc(conversation.customer_name || conversation.customer_wa)}
        <span class="num muted" style="font-weight:400">${esc(conversation.customer_wa)}</span>
        ${conversation.customer_city ? `<span class="badge grey">${esc(conversation.customer_city)}</span>` : ''}
        ${conversation.contact_phone ? `<span class="badge grey num">${esc(conversation.contact_phone)}</span>` : ''}
      </h3>
      ${conversation.handoff_reason ? `<p class="muted">سبب آخر تحويل: ${esc(conversation.handoff_reason)}</p>` : ''}

      ${silenceNotice(conversation)}

      ${
        viewer
          ? `<div class="error">⚠️ ${esc(viewer.display_name)} فتح هذه المحادثة قبل ${
              viewer.seconds < 60 ? `${viewer.seconds} ثانية` : 'دقيقة'
            } — تأكدي قبل الرد حتى لا يصل العميل ردّان.</div>`
          : ''
      }
      ${
        assignedToOther
          ? `<div class="ok" style="background:#fdf3e2;color:#b7791f">هذه المحادثة مُسندة إلى ${esc(
              assigneeName,
            )}.</div>`
          : ''
      }

      <div class="row" style="margin-bottom:10px">
        <div>
          <label for="assignee">المسؤول عن المحادثة</label>
          <select id="assignee">
            <option value="">— غير مُسندة —</option>
            ${staff
              .map(
                (s) =>
                  `<option value="${s.id}"${s.id === conversation.assigned_to ? ' selected' : ''}>${esc(
                    s.displayName,
                  )}</option>`,
              )
              .join('')}
          </select>
        </div>
      </div>

      <div class="chat">${
        messages.length
          ? messages
              .map(
                (m) => `<div class="bubble ${esc(m.role)}">${attachment(m)}${esc(m.body)}
                  <span class="meta">${esc(
                    m.role === 'staff' && m.author_name ? m.author_name : ROLE_LABEL[m.role] || m.role,
                  )} · ${esc(m.created_at.slice(5, 16))}</span>
                </div>`,
              )
              .join('')
          : '<div class="empty">لا رسائل.</div>'
      }</div>

      ${windowNotice(messages)}

      <label for="reply">رد يدوي (يُسكت البوت تلقائياً ويُسجَّل باسمك)</label>
      <textarea id="reply" placeholder="اكتبي ردك للعميل…"></textarea>
      <div class="actions">
        <button class="btn" id="send">إرسال</button>
        <button class="btn ghost" id="toggle">${conversation.bot_enabled ? 'إيقاف البوت' : 'تشغيل البوت'}</button>
        <button class="btn ghost" id="wake" hidden>أعيدي البوت الآن</button>
        <button class="btn ghost" id="markTest" title="الموسوم وحده يُحذف بزر «حذف بيانات التجربة»">
          ${conversation.is_test ? '✓ موسومة تجريبية' : 'وسم كتجربة'}
        </button>
      </div>
    </div>
  `;
  thread.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const chat = thread.querySelector('.chat');
  chat.scrollTop = chat.scrollHeight;

  document.getElementById('assignee').onchange = guard(async (event) => {
    const value = event.target.value;
    await post(`/api/tenants/${state.tenantId}/conversations/${conversationId}/assign`, {
      userId: value ? Number(value) : null,
    });
    flash(value ? 'أُسندت المحادثة.' : 'رُفع الإسناد.');
    await renderConversations(main);
    await openThread(conversationId, main, staff);
  });

  document.getElementById('send').onclick = guard(async () => {
    const text = document.getElementById('reply').value.trim();
    if (!text) return;
    if (assignedToOther && !confirm(`هذه المحادثة مُسندة إلى ${assigneeName}. ترسلين على أي حال؟`)) return;
    await post(`/api/tenants/${state.tenantId}/conversations/${conversationId}/reply`, { text });
    flash('أُرسل الرد، والبوت صامت لساعتين.');
    await openThread(conversationId, main, staff);
  });

  document.getElementById('toggle').onclick = guard(async () => {
    await post(`/api/tenants/${state.tenantId}/conversations/${conversationId}/bot`, {
      enabled: !conversation.bot_enabled,
    });
    flash(conversation.bot_enabled ? 'أُوقف البوت لهذه المحادثة.' : 'عاد البوت للعمل.');
    await renderConversations(main);
    await openThread(conversationId, main, staff);
  });

  /**
   * الوسم يدوي لا مخمَّن.
   *
   * لا يحذف شيئاً بنفسه — يجعل المحادثة مؤهّلة للحذف بزر الأدمن.
   * الفصل بين الوسم والحذف مقصود: خطوتان لفعلٍ لا يُسترجع.
   */
  /**
   * إعادة البوت قبل انتهاء مدة الصمت.
   *
   * البوت يصمت بعد التحويل أو بعد رد الموظف — وهذا مقصود لئلا يقاطع
   * الموظفَ وهو يعالج الحالة. لكن حين يتبيّن أن لا حاجة للتدخّل كان
   * الوحيد سبيلٌ هو الانتظار ساعتين: زرّ «إيقاف البوت» لا يفيد لأن
   * البوت مفعَّل أصلاً، والصامت شيء آخر.
   */
  const wake = document.getElementById('wake');
  if (wake && silentUntil(conversation)) {
    wake.hidden = false;
    wake.onclick = guard(async () => {
      await post(`/api/tenants/${state.tenantId}/conversations/${conversationId}/bot`, { enabled: true });
      flash('عاد البوت — سيرد على الرسالة القادمة.');
      await renderConversations(main);
      await openThread(conversationId, main, staff);
    });
  }

  document.getElementById('markTest').onclick = guard(async () => {
    const next = !conversation.is_test;
    await post(`/api/tenants/${state.tenantId}/conversations/${conversationId}/test`, { isTest: next });
    flash(next ? 'وُسمت كتجربة — صارت قابلة للحذف من الإعداد.' : 'رُفع الوسم — لم تعد تُحذف.');
    await renderConversations(main);
    await openThread(conversationId, main, staff);
  });
}


/* ---------------------------------------------------------------
   الصمت المؤقت
--------------------------------------------------------------- */

/** وقت انتهاء الصمت إن كان قائماً، وإلا لا شيء. */
function silentUntil(conversation) {
  const until = conversation.silent_until;
  if (!until) return null;
  // الختم بتوقيت الرياض بصيغة SQLite؛ نقارنه بالوقت نفسه صيغةً.
  const nowRiyadh = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  return until > nowRiyadh ? until : null;
}

/**
 * يشرح الصمت بدل أن يتركه لغزاً.
 *
 * شارة «صامت مؤقتاً» وحدها لا تكفي: تظهر بلا سبب ولا مدة، فتبدو
 * اللوحة وكأن البوت معطّل — ويُفتَح بلاغ عطل لا وجود له.
 */
function silenceNotice(conversation) {
  const until = silentUntil(conversation);
  if (!until) return '';
  const time = until.slice(11, 16);
  return `
    <div class="warn-box">
      🔇 <strong>البوت صامت في هذه المحادثة حتى ${esc(time)}</strong>
      <p class="muted" style="margin:6px 0 0">
        يصمت تلقائياً بعد التحويل لموظف أو بعد ردّ يدوي، حتى لا يقاطع
        الموظف وهو يعالج الحالة. رسائل العميل تصل وتُحفظ، ولا يُرد
        عليها آلياً. اضغطي «أعيدي البوت الآن» إن لم تعد هناك حاجة للتدخّل.
      </p>
    </div>`;
}


/* ---------------------------------------------------------------
   نافذة الأربع والعشرين ساعة
--------------------------------------------------------------- */

/**
 * واتساب لا يسمح بنص حر بعد ٢٤ ساعة من آخر رسالة للعميل.
 *
 * قاعدة Meta لا قيد نظامنا، ولا حيلة فيها إلا قالب معتمد. وإظهارها
 * قبل الكتابة يوفّر على الموظفة أن تكتب رداً طويلاً ثم يُرفض — وأن
 * تظنّ العطل في النظام.
 */
function windowNotice(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'customer');
  if (!last) return '';

  const sent = new Date(`${last.created_at.replace(' ', 'T')}+03:00`).getTime();
  const closesAt = sent + 24 * 3600_000;
  const left = closesAt - Date.now();

  if (left <= 0) {
    return `
      <div class="warn-box">
        ⏳ <strong>انتهت نافذة الرد (٢٤ ساعة من آخر رسالة للعميل)</strong>
        <p class="muted" style="margin:6px 0 0">
          واتساب لا يسمح بإرسال نص حر بعدها — قاعدة من Meta لا قيد في
          النظام. لبدء المحادثة يلزم <strong>قالب رسالة معتمد</strong>.
          رسالة العميل القادمة تفتح النافذة من جديد.
        </p>
      </div>`;
  }

  // التنبيه في الساعتين الأخيرتين فقط: تنبيه دائم يُتجاهَل.
  if (left < 2 * 3600_000) {
    const minutes = Math.round(left / 60_000);
    return `
      <div class="warn-box">
        ⏳ يتبقّى <strong>${minutes} دقيقة</strong> على انتهاء نافذة الرد.
        بعدها لا يُقبل إلا قالب معتمد.
      </div>`;
  }
  return '';
}
