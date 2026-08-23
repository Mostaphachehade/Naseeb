// Lightweight i18n for a static, no-build-step site: a flat key->string
// dictionary per language, a data-i18n attribute walker, and localStorage
// for the saved preference. Deliberately not a framework — this project has
// no bundler, so anything heavier would mean introducing a build step just
// to translate button labels.
//
// Scope: shared nav/footer plus the core browse -> view -> enter -> winner
// journey (homepage, giveaway detail, winners page). Auth forms, the host
// dashboard, admin, and legal pages are still English-only — legal copy in
// particular should get native review before translation, not a first pass.
const TRANSLATIONS = {
  en: {
    'nav.browse': 'Browse',
    'nav.winners': 'Winners',
    'nav.about': 'About',
    'nav.myGiveaways': 'My giveaways',
    'nav.pricing': 'What things cost',
    'nav.admin': 'Admin',
    'nav.owner': 'Owner',
    'nav.hostGiveaway': 'Host a giveaway',
    'nav.applyToHost': 'Apply to host',
    'nav.signOut': 'Sign out',
    'nav.signIn': 'Sign in',
    'nav.joinFree': 'Join free',
    'nav.hi': 'Hi, {name}',

    // Vocabulary that appears on many pages. One key each, so a label cannot be
    // translated three different ways on three different forms.
    'common.skipToContent': 'Skip to content',
    'common.email': 'Email',
    'common.password': 'Password',
    'common.fullName': 'Full name',
    'common.min8': 'At least 8 characters.',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.back': 'Back',
    'common.loading': 'Loading…',
    'common.submit': 'Submit',
    'common.close': 'Close',
    'common.required': 'Required',
    'common.optional': 'Optional',
    'common.somethingWentWrong': 'Something went wrong. Please try again.',
    'common.networkError': "We couldn't reach Naseeb. Check your connection and try again.",
    'common.notOpenYet': 'Naseeb is not open yet.',

    'footer.tagline': "Free-entry giveaways, always. No purchase is ever required or accepted to enter or to improve your odds.",
    'footer.explore': 'Explore',
    'footer.browseGiveaways': 'Browse giveaways',
    'footer.pastWinners': 'Past winners',
    'footer.aboutNaseeb': 'About Naseeb',
    'footer.advertise': 'Advertise with us',
    'footer.partners': 'Partners',
    'footer.legal': 'Legal',
    'footer.terms': 'Terms of Service',
    'footer.privacy': 'Privacy Policy',
    'footer.bottom': '© {year} Naseeb. Every ticket is free.',

    'hero.eyebrow': 'No purchase necessary',
    // Two lines rather than one string with a <br>: the dictionary holds text,
    // and the line break is an element the page builds. Nothing here is markup,
    // so nothing here needs an innerHTML to render it.
    'hero.headlineLine1': 'Every ticket is free.',
    'hero.headlineLine2': 'Every draw is real.',
    // Kept in step with index.html deliberately. This entry used to say the
    // giveaways were "funded by the people running them", which stopped being
    // true when the premium-prize model was adopted — and because the
    // dictionary overwrites the element's text at runtime, the newer copy in
    // the HTML never reached a single visitor. test/i18n-parity.test.js now
    // fails if the two disagree.
    'hero.lede': 'Naseeb features carefully selected premium prizes intended to create genuine excitement, happiness, and memorable experiences. Every prize is reviewed and approved by Naseeb before publication. Entry is free — no card, no purchase, ever — and every campaign closes at 100 eligible entries or one calendar month, whichever comes first.',
    'hero.membershipNote': 'Entering will need an active, verified Naseeb membership. Naseeb will coordinate delivery with the winner and be their point of contact.',
    'hero.browseBtn': 'Browse giveaways',
    'hero.hostBtn': 'Host your own',

    'howItWorks.title': 'How it works',
    'howItWorks.sub': 'Three steps, no payment screen, ever.',
    'howItWorks.step1Title': 'Browse for free',
    'howItWorks.step1Body': "Every giveaway on Naseeb discloses who's funding the prize. No entry fee exists anywhere in the flow.",
    'howItWorks.step2Title': 'Enter with one tap',
    'howItWorks.step2Body': 'Sign in and enter — one ticket per verified account, so nobody can pay their way to better odds.',
    'howItWorks.step3Title': 'Winner drawn at random',
    'howItWorks.step3Body': "After the deadline passes, a winner is drawn uniformly at random from every eligible entry.",

    'listings.title': 'Open giveaways',
    'listings.sub': 'Free to enter. One entry per verified account, so every ticket carries the same odds.',
    'loadMore': 'Load more',

    'empty.launchEyebrow': 'Launching soon',
    'empty.launchTitle': "The first giveaway hasn't gone live yet.",
    'empty.launchBody': "Be the host that starts it — list a prize, and it's the first thing every visitor sees.",
    'empty.launchCta': 'Host the first giveaway',

    'winners.eyebrow': 'Winners',
    'winners.headline': 'Real people. Real prizes. Drawn at random.',
    'winners.lede': "Every giveaway here is drawn the same way — uniformly at random, after the deadline, from everyone who entered. Here's who's won so far.",
    'winners.wonBy': 'Won by {name}',
    'winners.by': 'by {name}',
    // Split around the link for the same reason: the anchor is created, not
    // parsed out of a translated string.
    'winners.emptyBefore': 'No winners drawn yet — check back once the first giveaway closes, or ',
    'winners.emptyLink': "browse what's open now",
    'winners.emptyAfter': '.',

    'detail.status': 'Status',
    'detail.entriesSoFar': 'Entries so far',
    'detail.estimatedValue': 'Estimated value',
    'detail.entryDeadline': 'Entry deadline',
    'detail.fundedBy': 'Funded by',
    'detail.winnerLabel': 'Winner:',
    'detail.aboutGiveaway': 'About this giveaway',
    'detail.thePrize': 'The prize',
    'detail.enterFree': 'Enter for free',
    'detail.drawWinner': 'Draw winner now',
    'detail.confirmDelivery': 'Confirm prize delivered',
    'detail.hint': 'No payment is ever requested to enter or to improve your odds. One entry per verified account.',
    'detail.hostedBy': 'Hosted by {name}',
    'detail.open': 'Open',
    'detail.winnerDrawn': 'Winner drawn',
    'detail.notDisclosed': 'Not disclosed',
    'detail.signInToEnter': 'Sign in to enter',
    'detail.alreadyEntered': "You're entered ✓",
    'detail.entriesClosed': 'Entries closed',
    'detail.drawAvailable': 'Draw available after deadline',
    'detail.enteredCount': '{n} entered',
    'detail.notFound': 'Not found',
    'detail.enteredSuccess': "You're in! Your ticket number is #{n}.",
    'delivery.delivered': 'Prize delivered',
    'delivery.pending': 'Delivery pending',
    'time.closed': 'Entries closed',
    'time.daysHoursLeft': '{d}d {h}h left',
    'time.hoursMinsLeft': '{h}h {m}m left',
    'detail.loading': "LOADING…",
    'detail.loading2': "Loading…",
    'detail.prizeDelivery': "Prize delivery",
    'detail.whatWentWrong': "What went wrong?",
    'detail.sendToReview': "Send to review",
    'detail.pageTitle': "Giveaway — Naseeb",
    'detail.metaDescription': "Enter this free giveaway on Naseeb — no purchase necessary, ever.",
    'winners.pageTitle': "Winners — Naseeb",
    'winners.metaDescription': "Real people, real prizes, drawn at random. See who's won on Naseeb so far.",
    'policy.status.draft': "DRAFT",
    'policy.status.approved': "APPROVED",
    'policy.status.effective': "EFFECTIVE",
    'policy.notYetEffective': "not yet effective",
  },
  ar: {
    'nav.browse': 'تصفح',
    'nav.winners': 'الفائزون',
    'nav.about': 'من نحن',
    'nav.myGiveaways': 'مسابقاتي',
    'nav.pricing': 'الأسعار',
    'nav.admin': 'الإدارة',
    'nav.owner': 'المالك',
    'nav.hostGiveaway': 'استضف مسابقة',
    'nav.applyToHost': 'قدّم طلب استضافة',
    'nav.signOut': 'تسجيل الخروج',
    'nav.signIn': 'تسجيل الدخول',
    'nav.joinFree': 'انضم مجانًا',
    'nav.hi': 'مرحبًا، {name}',

    'common.skipToContent': 'تخطَّ إلى المحتوى',
    'common.email': 'البريد الإلكتروني',
    'common.password': 'كلمة المرور',
    'common.fullName': 'الاسم الكامل',
    'common.min8': '٨ أحرف على الأقل.',
    'common.cancel': 'إلغاء',
    'common.save': 'حفظ',
    'common.back': 'رجوع',
    'common.loading': 'جارٍ التحميل…',
    'common.submit': 'إرسال',
    'common.close': 'إغلاق',
    'common.required': 'مطلوب',
    'common.optional': 'اختياري',
    'common.somethingWentWrong': 'حدث خطأ ما. يُرجى المحاولة مرة أخرى.',
    'common.networkError': 'تعذّر الوصول إلى نصيب. تحقّق من اتصالك ثم حاول مرة أخرى.',
    'common.notOpenYet': 'نصيب ليست مفتوحة بعد.',

    'footer.tagline': 'مسابقات مجانية دائمًا. لا يُطلب أو يُقبل أي دفع مطلقًا للمشاركة أو لتحسين فرصك.',
    'footer.explore': 'استكشف',
    'footer.browseGiveaways': 'تصفح المسابقات',
    'footer.pastWinners': 'الفائزون السابقون',
    'footer.aboutNaseeb': 'عن نصيب',
    'footer.advertise': 'أعلن معنا',
    'footer.partners': 'شركاؤنا',
    'footer.legal': 'قانوني',
    'footer.terms': 'شروط الخدمة',
    'footer.privacy': 'سياسة الخصوصية',
    'footer.bottom': '© {year} نصيب. كل تذكرة مجانية.',

    'hero.eyebrow': 'لا يُشترط الشراء',
    'hero.headlineLine1': 'كل تذكرة مجانية.',
    'hero.headlineLine2': 'كل سحب حقيقي.',
    'hero.lede': 'تقدّم نصيب جوائز مميّزة مختارة بعناية تهدف إلى صنع حماس حقيقي وسعادة وتجارب لا تُنسى. تراجع نصيب كل جائزة وتعتمدها قبل النشر. المشاركة مجانية — بلا بطاقة دفع وبلا أي عملية شراء على الإطلاق — وتُغلق كل حملة عند بلوغ 100 مشاركة مؤهَّلة أو بعد شهر ميلادي واحد، أيّهما أقرب.',
    'hero.membershipNote': 'تتطلّب المشاركة عضوية نصيب سارية وموثَّقة. وتتولّى نصيب تنسيق تسليم الجائزة مع الفائز وتكون جهة التواصل معه.',
    'hero.browseBtn': 'تصفح المسابقات',
    'hero.hostBtn': 'استضف مسابقتك',

    'howItWorks.title': 'كيف تعمل نصيب',
    'howItWorks.sub': 'ثلاث خطوات، بلا شاشة دفع أبدًا.',
    'howItWorks.step1Title': 'تصفح مجانًا',
    'howItWorks.step1Body': 'كل مسابقة على نصيب تكشف عن الجهة المموِّلة للجائزة. لا توجد رسوم مشاركة في أي خطوة.',
    'howItWorks.step2Title': 'شارك بضغطة واحدة',
    'howItWorks.step2Body': 'سجّل دخولك وشارك — تذكرة واحدة لكل حساب موثّق، فلا يمكن لأحد الدفع لتحسين فرصه.',
    'howItWorks.step3Title': 'يُسحب الفائز عشوائيًا',
    'howItWorks.step3Body': 'بعد انتهاء الموعد النهائي، يُختار الفائز عشوائيًا من بين جميع المشاركين المؤهلين.',

    'listings.title': 'مسابقات مفتوحة',
    'listings.sub': 'المشاركة مجانية. تذكرة واحدة لكل حساب موثّق، فلكل تذكرة نفس الفرصة.',
    'loadMore': 'عرض المزيد',

    'empty.launchEyebrow': 'قريبًا',
    'empty.launchTitle': 'لم تنطلق أول مسابقة بعد.',
    'empty.launchBody': 'كن المستضيف الذي يبدأها — أضف جائزة، وستكون أول ما يراه كل زائر.',
    'empty.launchCta': 'استضف أول مسابقة',

    'winners.eyebrow': 'الفائزون',
    'winners.headline': 'أشخاص حقيقيون. جوائز حقيقية. تُسحب عشوائيًا.',
    'winners.lede': 'كل مسابقة هنا تُسحب بنفس الطريقة — عشوائيًا بالكامل، بعد الموعد النهائي، من بين كل من شارك. إليك من فاز حتى الآن.',
    'winners.wonBy': 'فاز بها {name}',
    'winners.by': 'بواسطة {name}',
    'winners.emptyBefore': 'لم يُسحب أي فائز بعد — تابعنا بعد إغلاق أول مسابقة، أو ',
    'winners.emptyLink': 'تصفح ما هو مفتوح الآن',
    'winners.emptyAfter': '.',

    'detail.status': 'الحالة',
    'detail.entriesSoFar': 'المشاركات حتى الآن',
    'detail.estimatedValue': 'القيمة التقديرية',
    'detail.entryDeadline': 'الموعد النهائي للمشاركة',
    'detail.fundedBy': 'الجهة الممولة',
    'detail.winnerLabel': 'الفائز:',
    'detail.aboutGiveaway': 'عن هذه المسابقة',
    'detail.thePrize': 'الجائزة',
    'detail.enterFree': 'شارك مجانًا',
    'detail.drawWinner': 'اسحب الفائز الآن',
    'detail.confirmDelivery': 'تأكيد تسليم الجائزة',
    'detail.hint': 'لا يُطلب أي دفع مطلقًا للمشاركة أو لتحسين فرصك. تذكرة واحدة لكل حساب موثّق.',
    'detail.hostedBy': 'استضافة {name}',
    'detail.open': 'مفتوحة',
    'detail.winnerDrawn': 'تم سحب الفائز',
    'detail.notDisclosed': 'غير معلنة',
    'detail.signInToEnter': 'سجّل الدخول للمشاركة',
    'detail.alreadyEntered': 'أنت مشارك ✓',
    'detail.entriesClosed': 'المشاركة مغلقة',
    'detail.drawAvailable': 'السحب متاح بعد الموعد النهائي',
    'detail.enteredCount': '{n} مشاركة',
    'detail.notFound': 'غير موجود',
    'detail.enteredSuccess': 'تم! رقم تذكرتك هو #{n}.',
    'delivery.delivered': 'تم تسليم الجائزة',
    'delivery.pending': 'التسليم قيد الانتظار',
    'time.closed': 'المشاركة مغلقة',
    'time.daysHoursLeft': 'باقي {d} يوم و{h} ساعة',
    'time.hoursMinsLeft': 'باقي {h} ساعة و{m} دقيقة',
    'detail.loading': "جارٍ التحميل…",
    'detail.loading2': "جارٍ التحميل…",
    'detail.prizeDelivery': "تسليم الجائزة",
    'detail.whatWentWrong': "ما الذي حدث؟",
    'detail.sendToReview': "إرسال للمراجعة",
    'detail.pageTitle': "مسابقة — نصيب",
    'detail.metaDescription': "شارك في هذه المسابقة المجانية على نصيب — لا يُشترط الشراء إطلاقًا.",
    'winners.pageTitle': "الفائزون — نصيب",
    'winners.metaDescription': "أشخاص حقيقيون وجوائز حقيقية تُسحب عشوائيًّا. اطّلع على من فاز على نصيب حتى الآن.",
    'policy.status.draft': "مسودّة",
    'policy.status.approved': "معتمدة",
    'policy.status.effective': "سارية",
    'policy.notYetEffective': "غير سارية بعد",
  },
};

const LANGS = ['en', 'ar'];

// The language is also addressable, as ?lang=ar.
//
// Without that, Arabic has no URL. The switch stores a preference and reloads,
// so every page lives at exactly one address and renders in whichever language
// that particular browser last chose. An Arabic page cannot then be linked to,
// cannot be shared, and cannot be offered to a search engine as the alternate
// of the English one — and an hreflang alternate pointing at a URL that serves
// English to everybody else is worse than no hreflang at all.
//
// The value is compared against a literal list of the two languages and
// discarded if it does not match. It is never assigned to location, href, src
// or anything else that navigates: a language parameter that reaches one of
// those is how this kind of convenience turns into an open redirect. It is only
// ever a dictionary key.
function langFromUrl() {
  try {
    const requested = new URLSearchParams(location.search).get('lang');
    return LANGS.indexOf(requested) === -1 ? null : requested;
  } catch {
    return null;
  }
}

function getLang() {
  const fromUrl = langFromUrl();
  if (fromUrl) {
    // Persisted so the choice survives the next link click. A shared Arabic
    // link that reverts to English on the second page is not a language, it is
    // a single translated page.
    try {
      localStorage.setItem('naseeb_lang', fromUrl);
    } catch {
      // Private browsing refuses writes. The parameter still applies to this page.
    }
  }
  let stored = null;
  try {
    stored = localStorage.getItem('naseeb_lang');
  } catch {
    stored = null;
  }
  const lang = fromUrl || stored;
  // Anything else in storage — stale, hand-edited, or from a future language
  // that no longer exists — falls back rather than being used as a lookup key.
  return LANGS.indexOf(lang) === -1 ? 'en' : lang;
}

function t(key, vars) {
  const lang = getLang();
  let str = (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.en[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      str = str.replace(`{${k}}`, vars[k]);
    });
  }
  return str;
}

// Bidirectional isolation.
//
// An email address, a URL, a ticket reference or a price dropped into an Arabic
// sentence is a run of left-to-right characters inside a right-to-left
// paragraph, and the Unicode bidi algorithm will reorder the punctuation around
// it. "Contact ops@example.com." becomes ".ops@example.com" with the full stop
// leading — the address still reads correctly, the sentence does not.
//
// U+2068 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE wrap a run so its
// direction is resolved on its own and cannot leak into the surrounding text.
// Applied at render time to VALUES, never to translated copy: the copy already
// has a direction, the value is what does not.
const FSI = '⁨';
const PDI = '⁩';

function isolate(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (!s) return '';
  // Strip any isolate characters already present so hostile input cannot open
  // an isolate it never closes and swallow the rest of the page's text.
  return FSI + s.replace(/[⁦-⁩‪-‮]/g, '') + PDI;
}

function applyI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });

  // Attributes a person actually reads: placeholder, aria-label, title, alt.
  // `data-i18n-attr="placeholder:form.emailPlaceholder; aria-label:nav.menu"`.
  // Kept to that allowlist on purpose — this must never be able to write href,
  // src, or an event handler attribute out of a dictionary entry.
  const TRANSLATABLE_ATTRS = new Set(['placeholder', 'aria-label', 'title', 'alt']);
  document.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    node.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s && s.trim());
      if (!attr || !key) return;
      if (!TRANSLATABLE_ATTRS.has(attr)) return;
      node.setAttribute(attr, t(key));
    });
  });

  // Document metadata. Title and description are read by people — in a browser
  // tab, in a share preview, in a screen reader's document summary.
  document.querySelectorAll('meta[data-i18n-content]').forEach((node) => {
    node.setAttribute('content', t(node.getAttribute('data-i18n-content')));
  });
  const titleEl = document.querySelector('title[data-i18n]');
  if (titleEl) document.title = t(titleEl.getAttribute('data-i18n'));
  // data-i18n-html is gone. It read a key out of an attribute and assigned the
  // dictionary entry with innerHTML — the two entries that needed it are now
  // split into text parts, and the two elements that used it declare their
  // structure instead.
  document.querySelectorAll('[data-i18n-lines]').forEach((node) => {
    const key = node.getAttribute('data-i18n-lines');
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(document.createTextNode(t(key + 'Line1')));
    node.appendChild(document.createElement('br'));
    node.appendChild(document.createTextNode(t(key + 'Line2')));
  });
}

// Page dictionaries.
//
// 700-odd strings in one file, loaded on every page, would be a payload most
// visitors never read a tenth of. Each page's own script — which every page
// already loads, so this costs no extra request — registers its strings, and
// re-applies. Shared nav, footer and form vocabulary stay in this file because
// every page genuinely uses them.
function register(dict) {
  if (dict && dict.en) Object.assign(TRANSLATIONS.en, dict.en);
  if (dict && dict.ar) Object.assign(TRANSLATIONS.ar, dict.ar);
  applyI18n();
}

// A full reload (rather than re-rendering in place) is deliberate: nav,
// footer, and every card/badge on the page are built from JS template
// strings that call t() directly, not just static data-i18n text — a
// reload is simpler and more robust than re-invoking every render
// function in the right order.
//
// location.reload() keeps the current URL exactly as it is, which is the whole
// of the redirect story: the language switch cannot navigate anywhere, so it
// cannot be pointed at another origin. Nothing here reads a `redirect`, `next`
// or `returnTo` parameter, and nothing here should ever start.
function setLang(lang) {
  if (lang !== 'en' && lang !== 'ar') return;
  localStorage.setItem('naseeb_lang', lang);
  location.reload();
}

applyI18n();

// Read-only access to a whole dictionary. Only errors.js uses it, to build
// its English-sentence index; returning a copy so a page cannot reach in and
// rewrite a translation at runtime.
function dictionary(lang) {
  return Object.assign({}, TRANSLATIONS[lang] || {});
}

window.NaseebI18n = { t, isolate, register, setLang, getLang, applyI18n, dictionary };
