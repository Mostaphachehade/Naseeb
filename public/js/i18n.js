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
    'nav.pricing': 'Pricing',
    'nav.admin': 'Admin',
    'nav.hostGiveaway': 'Host a giveaway',
    'nav.signOut': 'Sign out',
    'nav.signIn': 'Sign in',
    'nav.joinFree': 'Join free',
    'nav.hi': 'Hi, {name}',

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
    'hero.headline': 'Every ticket is free.<br>Every draw is real.',
    'hero.lede': "Naseeb hosts giveaways funded by the people running them, not by entry fees. Enter with one tap, no card required, and see exactly how the winner is picked.",
    'hero.browseBtn': 'Browse giveaways',
    'hero.hostBtn': 'Host your own',

    'howItWorks.title': 'How it works',
    'howItWorks.sub': 'Three steps, no payment screen, ever.',
    'howItWorks.step1Title': 'Browse for free',
    'howItWorks.step1Body': "Every giveaway on Naseeb discloses who's funding the prize. No entry fee exists anywhere in the flow.",
    'howItWorks.step2Title': 'Enter with one tap',
    'howItWorks.step2Body': "Sign in and enter — one ticket per person, so nobody can pay or game their way to better odds.",
    'howItWorks.step3Title': 'Winner drawn at random',
    'howItWorks.step3Body': "After the deadline passes, a winner is drawn uniformly at random from every eligible entry.",

    'listings.title': 'Open giveaways',
    'listings.sub': 'Free to enter. One entry per person, so every ticket carries the same odds.',
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
    'winners.emptyBody': "No winners drawn yet — check back once the first giveaway closes, or <a href=\"/index.html\">browse what's open now</a>.",

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
    'detail.hint': 'No payment is ever requested to enter or to improve your odds. One entry per person.',
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
  },
  ar: {
    'nav.browse': 'تصفح',
    'nav.winners': 'الفائزون',
    'nav.about': 'من نحن',
    'nav.myGiveaways': 'مسابقاتي',
    'nav.pricing': 'الأسعار',
    'nav.admin': 'الإدارة',
    'nav.hostGiveaway': 'استضف مسابقة',
    'nav.signOut': 'تسجيل الخروج',
    'nav.signIn': 'تسجيل الدخول',
    'nav.joinFree': 'انضم مجانًا',
    'nav.hi': 'مرحبًا، {name}',

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
    'hero.headline': 'كل تذكرة مجانية.<br>كل سحب حقيقي.',
    'hero.lede': 'تستضيف نصيب مسابقات يموّلها القائمون عليها، وليس رسوم المشاركة. شارك بضغطة واحدة، بلا بطاقة دفع، وشاهد بنفسك كيف يُختار الفائز.',
    'hero.browseBtn': 'تصفح المسابقات',
    'hero.hostBtn': 'استضف مسابقتك',

    'howItWorks.title': 'كيف تعمل نصيب',
    'howItWorks.sub': 'ثلاث خطوات، بلا شاشة دفع أبدًا.',
    'howItWorks.step1Title': 'تصفح مجانًا',
    'howItWorks.step1Body': 'كل مسابقة على نصيب تكشف عن الجهة المموِّلة للجائزة. لا توجد رسوم مشاركة في أي خطوة.',
    'howItWorks.step2Title': 'شارك بضغطة واحدة',
    'howItWorks.step2Body': 'سجّل دخولك وشارك — تذكرة واحدة لكل شخص، فلا يمكن لأحد الدفع أو التلاعب لتحسين فرصه.',
    'howItWorks.step3Title': 'يُسحب الفائز عشوائيًا',
    'howItWorks.step3Body': 'بعد انتهاء الموعد النهائي، يُختار الفائز عشوائيًا من بين جميع المشاركين المؤهلين.',

    'listings.title': 'مسابقات مفتوحة',
    'listings.sub': 'المشاركة مجانية. تذكرة واحدة لكل شخص، فلكل تذكرة نفس الفرصة.',
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
    'winners.emptyBody': 'لم يُسحب أي فائز بعد — تابعنا بعد إغلاق أول مسابقة، أو <a href="/index.html">تصفح ما هو مفتوح الآن</a>.',

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
    'detail.hint': 'لا يُطلب أي دفع مطلقًا للمشاركة أو لتحسين فرصك. تذكرة واحدة لكل شخص.',
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
  },
};

function getLang() {
  return localStorage.getItem('naseeb_lang') || 'en';
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

function applyI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
}

// A full reload (rather than re-rendering in place) is deliberate: nav,
// footer, and every card/badge on the page are built from JS template
// strings that call t() directly, not just static data-i18n text — a
// reload is simpler and more robust than re-invoking every render
// function in the right order.
function setLang(lang) {
  localStorage.setItem('naseeb_lang', lang);
  location.reload();
}

applyI18n();
