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
