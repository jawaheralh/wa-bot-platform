/**
 * سياق المحادثة.
 *
 * نحفظ آخر N رسالة فقط ونمررها كنص بسيط. لا نحفظ كتل tool_use/tool_result
 * بين الرسائل عن قصد: النموذج لا يحتاج أن يرى «كيف» أجاب سابقاً، والاحتفاظ
 * بها يضاعف التكلفة ويُبقي نتائج قديمة قد تكون تغيّرت (موعد أُلغي مثلاً).
 */

import { recentMessages, type Db, type MessageRow } from '../db/index.ts';
import type { ChatMessage } from './claude.ts';

/** رسالة الموظف تُقدَّم للنموذج كأنها منه، فهي فعلاً من المنشأة للعميل. */
function toRole(role: MessageRow['role']): 'user' | 'assistant' | null {
  if (role === 'customer') return 'user';
  if (role === 'bot' || role === 'staff') return 'assistant';
  return null;
}

export function buildHistory(db: Db, conversationId: number, limit: number): ChatMessage[] {
  const rows = recentMessages(db, conversationId, limit);
  const messages: ChatMessage[] = [];

  for (const row of rows) {
    const role = toRole(row.role);
    if (!role || !row.body.trim()) continue;
    const prefix = row.role === 'staff' ? '(رد الموظف) ' : '';
    const last = messages[messages.length - 1];
    // دمج الرسائل المتتالية من نفس الطرف: واتساب يشجّع الرسائل القصيرة
    // المتتابعة، وتبادل الأدوار الصارم يمنع الـAPI من قبولها.
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n${prefix}${row.body}`;
    } else {
      messages.push({ role, content: `${prefix}${row.body}` });
    }
  }

  // الـAPI يشترط أن تبدأ المحادثة برسالة مستخدم.
  while (messages.length && messages[0]?.role !== 'user') messages.shift();
  return messages;
}
