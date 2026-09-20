/** المحادثات: العرض، والإسناد، وإيقاف/تشغيل البوت، والرد اليدوي. */

import { get, post, esc, ago, guard, flash, state } from '../core.js';

const ROLE_LABEL = { customer: 'العميل', bot: 'البوت', staff: 'الموظف', system: 'النظام' };

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
                    <td>${esc(c.customer_name || '—')}<br><span class="num muted">${esc(c.customer_wa)}</span></td>
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
}

async function openThread(conversationId, main, staff) {
  const { conversation, messages, assigneeName, viewer } = await get(
    `/api/tenants/${state.tenantId}/conversations/${conversationId}`,
  );

  const assignedToOther = conversation.assigned_to && conversation.assigned_to !== state.me.id;

  const thread = document.getElementById('thread');
  thread.innerHTML = `
    <div class="card">
      <h3>${esc(conversation.customer_name || conversation.customer_wa)}
        <span class="num muted" style="font-weight:400">${esc(conversation.customer_wa)}</span></h3>
      ${conversation.handoff_reason ? `<p class="muted">سبب آخر تحويل: ${esc(conversation.handoff_reason)}</p>` : ''}

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
                (m) => `<div class="bubble ${esc(m.role)}">${esc(m.body)}
                  <span class="meta">${esc(
                    m.role === 'staff' && m.author_name ? m.author_name : ROLE_LABEL[m.role] || m.role,
                  )} · ${esc(m.created_at.slice(5, 16))}</span>
                </div>`,
              )
              .join('')
          : '<div class="empty">لا رسائل.</div>'
      }</div>

      <label for="reply">رد يدوي (يُسكت البوت تلقائياً ويُسجَّل باسمك)</label>
      <textarea id="reply" placeholder="اكتبي ردك للعميل…"></textarea>
      <div class="actions">
        <button class="btn" id="send">إرسال</button>
        <button class="btn ghost" id="toggle">${conversation.bot_enabled ? 'إيقاف البوت' : 'تشغيل البوت'}</button>
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
}
