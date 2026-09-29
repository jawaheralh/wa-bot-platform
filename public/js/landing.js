/**
 * صفحة الهبوط: اللغتان والنموذج.
 *
 * كل النصوص في كائن واحد لا في الـHTML: صفحة بلغتين تُكتب نصوصها في
 * الترميز تعني أن كل تعديل يُطبَّق مرتين — وتُنسى إحداهما فتبقى كلمة
 * إنجليزية وسط العربية أمام عميل.
 *
 * وما تَعِد به الصفحة مقصور على ما يعمل فعلاً. الوعد بقنوات لم تُبنَ
 * يبيع ما لا يُسلَّم، وأول عميل يكتشفه يفقد الثقة في الباقي كله.
 */

const T = {
  ar: {
    dir: 'rtl',
    lang: 'ar',
    toggle: 'English',
    login: 'دخول العملاء',
    cta: 'اطلبي عرضاً تجريبياً',

    h1: 'كل محادثات عملائك على واتساب — في لوحة واحدة',
    lead:
      'منصة سحابية لخدمة العملاء عبر واتساب: صندوق وارد موحّد لفريقك، ' +
      'وردود ذكية بالذكاء الاصطناعي من معرفة منشأتك، وشكاوى وطلبات بأرقام ' +
      'مرجعية يتابعها العميل.',
    tick1: 'يرد على عملائك ٢٤ ساعة بمعرفة منشأتك وحدها',
    tick2: 'يحوّل للموظف حين لا يعرف — ولا يخترع جواباً',
    tick3: 'بياناتك على خادم داخل السعودية',

    kpi1: 'محادثة اليوم',
    kpi2: 'حُوّلت لموظف',
    kpi3: 'متوسط الرد',

    formKicker: 'خطوة أخيرة!',
    formTitle: 'اطلبي عرضاً تجريبياً',
    formSub: 'عبّئي النموذج ونتواصل معك خلال يوم عمل.',
    firstName: 'الاسم الأول *',
    lastName: 'اسم العائلة',
    email: 'البريد الإلكتروني للعمل *',
    company: 'اسم المنشأة *',
    phone: 'رقم الجوال *',
    country: 'الدولة',
    role: 'الدور الوظيفي',
    teamSize: 'حجم الفريق',
    marketing: 'أوافق على استلام رسائل عن المنصة وتحديثاتها.',
    legal: 'بإرسال النموذج توافقين على تواصلنا معك بخصوص طلبك. لا نشارك بياناتك مع أي طرف ثالث.',
    submit: 'احجزي عرضي التجريبي',

    doneTitle: 'وصلنا طلبك',
    doneBody: 'سنتواصل معك على البريد أو الجوال خلال يوم عمل.',

    errRequired: 'أكملي الحقول المطلوبة.',
    errEmail: 'البريد الإلكتروني غير صحيح.',
    errPhone: 'رقم الجوال غير صحيح.',
    errSend: 'تعذّر الإرسال. حاولي مرة أخرى.',

    s2Title: 'أديري خدمة عملائك من مكان واحد',
    s2Body:
      'بدل أن يتنقّل فريقك بين جوالات وملاحظات، تصل كل المحادثات لوحة واحدة: ' +
      'من يرد، وماذا رُدّ، وما الذي ما زال معلّقاً.',

    f1Title: 'صندوق وارد موحّد',
    f1Body: 'كل محادثات الرقم في شاشة واحدة، مع إسناد المحادثة لموظف ومنع تضارب الردود.',
    f2Title: 'مساعد ذكي بحدود',
    f2Body: 'يرد من معرفة منشأتك التي تحدّدينها، ويحوّل للموظف حين لا يعرف بدل أن يخترع.',
    f3Title: 'شكاوى وطلبات بأرقام',
    f3Body: 'رقم مرجعي لكل شكوى وطلب، وإبلاغ تلقائي للعميل عند تغيّر الحالة.',

    soon: 'قريباً: إنستغرام وماسنجر والبريد ودردشة الموقع في نفس اللوحة.',

    ctaTitle: 'جرّبيها على منشأتك',
    ctaBody: 'عرض تجريبي على بياناتك أنتِ، بلا التزام.',

    copy: '© 2026 — جميع الحقوق محفوظة.',
    chatLabel: 'تحدثي مع المبيعات',

    faqTitle: 'أسئلة يسألها كل من يجرّبها',
    /**
     * سؤال وجواب في مصفوفة لا في الترميز: العدد يتغيّر مع كل عميل
     * يسأل شيئاً جديداً، وإضافة سطر هنا أسهل من تكرار قالب في ملفين.
     */
    faq: [
      [
        'من أين يأتي البوت بإجاباته؟',
        'من معرفة منشأتك التي تكتبينها أنتِ — الأسعار والمواعيد والفروع والسياسات. ' +
          'وإن لم يجد الجواب فيها لا يخترع، بل يحوّل المحادثة لموظف.',
      ],
      [
        'هل يستغني عن موظف خدمة العملاء؟',
        'لا. يتكفّل بالمتكرّر ويترك ما يحتاج إنساناً. وموظفك يرى كل محادثة ويتدخّل متى شاء — ' +
          'وحين يكتب رداً يصمت البوت تلقائياً حتى لا يتعارض معه.',
      ],
      [
        'كيف أحدّد ما يقوله وما لا يقوله؟',
        'بملف إكسل واحد: ورقة للمعرفة، وورقة لحدود البوت، وورقة للفروع. ' +
          'يُرفع بضغطة زر، وتعدّلينه من اللوحة في أي وقت.',
      ],
      [
        'أين تُحفظ بيانات عملائي؟',
        'على خادم داخل السعودية. الاتصال مشفّر، والدخول للوحة محصور بحسابات منشأتك، ' +
          'والنسخ الاحتياطية تُشفَّر قبل أن تُخزَّن.',
      ],
      [
        'هل أحتاج رقم واتساب جديد؟',
        'لا، يعمل على رقم منشأتك نفسه عبر واتساب بزنس الرسمي من ميتا. يُربط مرة واحدة ويبقى.',
      ],
      [
        'ماذا يحدث للشكوى بعد تسجيلها؟',
        'تأخذ رقماً مرجعياً يصل العميل فوراً، وتظهر في اللوحة بحالتها. ' +
          'وعند تغيّر الحالة يُبلَّغ العميل تلقائياً بلا تدخّل منك.',
      ],
      [
        'هل تختلط بيانات منشأتي بغيرها؟',
        'لا. رقم كل منشأة ومعرفتها وحساباتها ومحادثاتها منفصلة تماماً، ' +
          'ولا يرى حسابُ منشأةٍ شيئاً من أخرى.',
      ],
      [
        'وبقية قنوات التواصل؟',
        'حالياً واتساب وحده — وهو ما نضمن جودته اليوم. والنظام مبني ليقبل إنستغرام ' +
          'وماسنجر والبريد ودردشة الموقع في نفس اللوحة لاحقاً.',
      ],
      [
        'كم التكلفة؟',
        'تعتمد على حجم المحادثات وعدد الأرقام. اطلبي عرضاً تجريبياً ونرد عليك بالتفصيل خلال يوم عمل.',
      ],
    ],

    countries: ['السعودية', 'الإمارات', 'الكويت', 'قطر', 'البحرين', 'عُمان', 'مصر', 'الأردن', 'أخرى'],
    roles: [
      'مدير خدمة العملاء',
      'المالك أو الرئيس التنفيذي',
      'العمليات',
      'التسويق',
      'تقنية المعلومات',
      'المبيعات',
      'أخرى',
    ],
    sizes: ['١–٥', '٦–٢٠', '٢١–٥٠', 'أكثر من ٥٠'],
  },

  en: {
    dir: 'ltr',
    lang: 'en',
    toggle: 'العربية',
    login: 'Client login',
    cta: 'Request a demo',

    h1: 'Every WhatsApp conversation with your customers — in one place',
    lead:
      'A cloud customer-service platform for WhatsApp: a shared inbox for your team, ' +
      'AI replies grounded in your own knowledge base, and complaints and requests ' +
      'with reference numbers your customers can follow.',
    tick1: 'Answers around the clock, from your knowledge only',
    tick2: 'Hands over to a human when unsure — never invents an answer',
    tick3: 'Your data on a server inside Saudi Arabia',

    kpi1: 'chats today',
    kpi2: 'handed over',
    kpi3: 'avg. reply',

    formKicker: 'Almost there!',
    formTitle: 'Request a free demo',
    formSub: 'Fill in the form and we will reach out within one business day.',
    firstName: 'First name *',
    lastName: 'Last name',
    email: 'Work email *',
    company: 'Company name *',
    phone: 'Phone *',
    country: 'Country',
    role: 'Job role',
    teamSize: 'Team size',
    marketing: 'Send me product updates and news.',
    legal: 'By submitting you agree that we may contact you about your request. We never share your data.',
    submit: 'Get my demo',

    doneTitle: 'Request received',
    doneBody: 'We will contact you by email or phone within one business day.',

    errRequired: 'Please complete the required fields.',
    errEmail: 'That email does not look right.',
    errPhone: 'That phone number does not look right.',
    errSend: 'Could not send. Please try again.',

    s2Title: 'Run customer service from one place',
    s2Body:
      'Instead of your team juggling phones and notes, every conversation lands in one ' +
      'dashboard: who replied, what was said, and what is still open.',

    f1Title: 'Shared inbox',
    f1Body: 'All conversations on one screen, with assignment and protection against double replies.',
    f2Title: 'AI with boundaries',
    f2Body: 'Answers from the knowledge you define, and hands over when it does not know.',
    f3Title: 'Tracked complaints & requests',
    f3Body: 'A reference number for each case, and automatic updates to the customer.',

    soon: 'Coming soon: Instagram, Messenger, email and website chat in the same inbox.',

    ctaTitle: 'See it on your own data',
    ctaBody: 'A demo built around your business, no commitment.',

    copy: '© 2026 — All rights reserved.',
    chatLabel: 'Chat with sales',

    faqTitle: 'Questions everyone asks',
    faq: [
      [
        'Where do the answers come from?',
        'From the knowledge you write yourself — prices, hours, branches, policies. ' +
          'If the answer is not there it does not invent one; it hands the conversation to a human.',
      ],
      [
        'Does it replace my support agent?',
        'No. It handles the repetitive questions and leaves the rest to people. Your agent sees every ' +
          'conversation and can step in at any moment — and once they reply, the bot goes quiet on its own.',
      ],
      [
        'How do I control what it says?',
        'With one spreadsheet: a sheet for knowledge, a sheet for the bot\u2019s limits, and a sheet for ' +
          'branches. Upload it with one button, and edit it from the dashboard whenever you like.',
      ],
      [
        'Where is my customer data stored?',
        'On a server inside Saudi Arabia. Traffic is encrypted, dashboard access is limited to your own ' +
          'accounts, and backups are encrypted before they are stored.',
      ],
      [
        'Do I need a new WhatsApp number?',
        'No. It runs on your existing business number through Meta\u2019s official WhatsApp Business API. ' +
          'You connect it once.',
      ],
      [
        'What happens after a complaint is filed?',
        'It gets a reference number sent to the customer immediately and appears in the dashboard with its ' +
          'status. When the status changes, the customer is notified automatically.',
      ],
      [
        'Can one business see another\u2019s data?',
        'No. Each business has its own number, knowledge, accounts and conversations, fully separated — ' +
          'one account can never reach another\u2019s data.',
      ],
      [
        'What about other channels?',
        'Today WhatsApp only — that is what we can stand behind. The system is built to take Instagram, ' +
          'Messenger, email and website chat into the same inbox later.',
      ],
      [
        'What does it cost?',
        'It depends on conversation volume and how many numbers you connect. Request a demo and we will ' +
          'come back to you with details within one business day.',
      ],
    ],

    countries: ['Saudi Arabia', 'UAE', 'Kuwait', 'Qatar', 'Bahrain', 'Oman', 'Egypt', 'Jordan', 'Other'],
    roles: [
      'Customer Service Manager',
      'Owner / CEO',
      'Operations',
      'Marketing',
      'IT',
      'Sales',
      'Other',
    ],
    sizes: ['1–5', '6–20', '21–50', '50+'],
  },
};

let lang = localStorage.getItem('landingLang') === 'en' ? 'en' : 'ar';
let brand = { name: '', supportWhatsapp: '' };

function fill(select, values) {
  const chosen = select.selectedIndex;
  select.innerHTML = values.map((v) => `<option>${v}</option>`).join('');
  if (chosen >= 0) select.selectedIndex = chosen;
}

function apply() {
  const t = T[lang];
  document.documentElement.lang = t.lang;
  document.documentElement.dir = t.dir;
  document.body.dir = t.dir;

  for (const node of document.querySelectorAll('[data-t]')) {
    const key = node.dataset.t;
    if (key === 'brand') {
      node.textContent = brand.name;
    } else if (t[key] !== undefined) {
      node.textContent = t[key];
    }
  }

  // الأسئلة تُبنى لا تُترجَم بـdata-t: عددها يختلف ونصّها فقرتان.
  document.getElementById('faqList').innerHTML = t.faq
    .map(
      ([question, answer], index) =>
        `<details class="qa"${index === 0 ? ' open' : ''}>
           <summary>${question}</summary>
           <p>${answer}</p>
         </details>`,
    )
    .join('');

  document.getElementById('lang').textContent = t.toggle;
  fill(document.getElementById('country'), t.countries);
  fill(document.getElementById('role'), t.roles);
  fill(document.getElementById('teamSize'), t.sizes);

  localStorage.setItem('landingLang', lang);
}

document.getElementById('lang').onclick = () => {
  lang = lang === 'ar' ? 'en' : 'ar';
  apply();
};

/* --- التحقق والإرسال --- */

const form = document.getElementById('demoForm');
const errorBox = document.getElementById('formError');

function markBad(input, bad) {
  input.closest('.field')?.classList.toggle('bad', bad);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const t = T[lang];
  errorBox.hidden = true;

  const value = (id) => document.getElementById(id).value.trim();
  const required = ['firstName', 'email', 'company', 'phone'];

  let firstBad = null;
  for (const id of required) {
    const input = document.getElementById(id);
    const empty = !input.value.trim();
    markBad(input, empty);
    if (empty && !firstBad) firstBad = input;
  }
  if (firstBad) {
    errorBox.textContent = t.errRequired;
    errorBox.hidden = false;
    firstBad.focus();
    return;
  }

  const email = document.getElementById('email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) {
    markBad(email, true);
    errorBox.textContent = t.errEmail;
    errorBox.hidden = false;
    email.focus();
    return;
  }

  const phone = document.getElementById('phone');
  if (phone.value.replace(/\D/g, '').length < 8) {
    markBad(phone, true);
    errorBox.textContent = t.errPhone;
    errorBox.hidden = false;
    phone.focus();
    return;
  }

  const button = document.getElementById('submit');
  button.disabled = true;

  try {
    const response = await fetch('/api/demo-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: value('firstName'),
        lastName: value('lastName'),
        email: value('email'),
        company: value('company'),
        phone: value('phone'),
        country: value('country'),
        role: value('role'),
        teamSize: value('teamSize'),
        marketingOk: document.getElementById('marketingOk').checked,
        lang,
        website: value('website'),
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t.errSend);

    form.hidden = true;
    document.getElementById('done').hidden = false;
  } catch (error) {
    errorBox.textContent = error.message || t.errSend;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/* --- زر المبيعات: يظهر فقط إن كان هناك رقم فعلاً --- */

async function boot() {
  try {
    brand = await fetch('/api/brand').then((r) => r.json());
  } catch {
    brand = { name: '', supportWhatsapp: '' };
  }

  const chat = document.getElementById('chat');
  if (brand.supportWhatsapp) {
    chat.hidden = false;
    chat.onclick = () => {
      const text = encodeURIComponent(lang === 'ar' ? 'السلام عليكم، أبغى أعرف عن المنصة.' : 'Hi, I would like to know more.');
      window.open(`https://wa.me/${brand.supportWhatsapp}?text=${text}`, '_blank', 'noopener');
    };
  }

  apply();
}

void boot();
