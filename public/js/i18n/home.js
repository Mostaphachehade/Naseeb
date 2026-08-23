// Arabic for the home page: the hero note, the animated promo strip and the
// statistics bar.
//
// Short lines, and short lines are where a translation most easily stops being
// true. "Zero cost." and "No card. No catch. Ever." are the platform's central
// promise compressed to three words, and the Arabic has to carry the same
// promise rather than an approximation of the rhythm — بلا بطاقة دفع is "no
// payment card", not "no card of any kind", because the claim is about payment.
//
// The statistics bar labels count real things and must not overstate them.
// "AED in prizes listed" is the declared value of prizes that were listed, not
// value delivered and not value verified; الجوائز المعروضة keeps that. A
// translation reading "prizes awarded" would turn a catalogue figure into a
// payout figure.
//
// Uses مسابقة for "giveaway", matching the 77 existing uses across the other
// dictionaries rather than introducing a second word for the same thing. Whether
// مسابقة is the right word at all is a question for native review: it is the
// ordinary marketing term, and it also carries a sense of "contest", which is
// precisely what this platform is not. See docs/ARABIC_RTL.md.
//
// STATUS: machine-drafted Modern Standard Arabic, PENDING NATIVE REVIEW.
register({
  en: {
    'home.promoLiveNow': 'Live now',
    'home.promoZeroCost': 'Zero cost.',
    'home.promoRealPrize': 'Real prize.',
    'home.promoNoCard': 'No card. No catch. Ever.',
    'home.promoThisWeek': "This week's giveaway",
    'home.promoOpenNow': 'Open now',
    'home.promoFundedByHost': 'Funded by the host. Free for you to enter.',
    'home.promoDaysLeft': 'Days left to enter',
    'home.promoOneEntry': 'One entry per account. Winner picked at random.',
    'home.promoEnterFree': 'Enter free.',
    'home.promoWinReal': 'Win real.',
    'home.promoSeeGiveaway': 'See the giveaway',
    'home.promoNoPurchase': 'No purchase. No catch. Just enter.',
    'home.statGiveaways': 'Giveaways hosted',
    'home.statEntries': 'Entries submitted',
    'home.statValue': 'AED in prizes listed',
    'home.pageTitle': "Naseeb — Free-entry giveaways",
    'home.metaDescription': "Naseeb hosts free-entry giveaways — no purchase necessary, ever. Browse open giveaways, enter with one tap, and see winners drawn at random.",
  },
  ar: {
    'home.promoLiveNow': 'مباشر الآن',
    'home.promoZeroCost': 'بلا تكلفة.',
    'home.promoRealPrize': 'جائزة حقيقية.',
    'home.promoNoCard': 'بلا بطاقة دفع. بلا شروط خفية. أبدًا.',
    'home.promoThisWeek': 'مسابقة هذا الأسبوع',
    'home.promoOpenNow': 'مفتوحة الآن',
    'home.promoFundedByHost': 'يموّلها المضيف. والمشاركة مجانية لك.',
    'home.promoDaysLeft': 'الأيام المتبقية للمشاركة',
    'home.promoOneEntry': 'مشاركة واحدة لكل حساب. ويُختار الفائز عشوائيًا.',
    'home.promoEnterFree': 'شارك مجانًا.',
    'home.promoWinReal': 'واربح حقيقةً.',
    'home.promoSeeGiveaway': 'شاهد المسابقة',
    'home.promoNoPurchase': 'بلا شراء. بلا شروط خفية. فقط شارك.',
    'home.statGiveaways': 'المسابقات المستضافة',
    'home.statEntries': 'المشاركات المُقدَّمة',
    'home.statValue': 'درهم إماراتي في الجوائز المعروضة',
    'home.pageTitle': "نصيب — مسابقات مجانية المشاركة",
    'home.metaDescription': "تستضيف نصيب مسابقات مجانية المشاركة — لا يُشترط الشراء إطلاقًا. تصفّح المسابقات المفتوحة، وشارك بنقرة واحدة، وشاهد الفائزين يُسحبون عشوائيًّا.",
  },
});
