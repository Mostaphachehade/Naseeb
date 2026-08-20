// What Naseeb will and will not put its name on.
//
// ---------------------------------------------------------------------------
// The positioning this file enforces
// ---------------------------------------------------------------------------
//
// Naseeb is a curated premium-giveaway platform — not a general freebie, coupon
// or sample site. Every prize is reviewed and approved by Naseeb before
// publication, and the point of that review is that somebody would genuinely be
// delighted to win it.
//
// Before this file, `POST /api/giveaways` published instantly: an approved host
// filled in a title, a free-text prize description and a deadline of their
// choosing, and the campaign was live. There was no category, no sponsor, no
// value, no evidence that the prize existed, no statement of who would fulfil
// it, and no administrator in the loop at all. That is the gap this closes.
//
// ---------------------------------------------------------------------------
// What this file is NOT
// ---------------------------------------------------------------------------
//
// It is not a price filter. There is deliberately no minimum monetary value,
// because "premium" is a judgement about quality, desirability and how the
// prize will actually feel to receive — and a threshold would admit an
// expensive but dismal prize while excluding a genuinely special one. The value
// is recorded because a misleadingly inflated one is a rejection ground, not
// because a number decides the answer.
//
// It is also not a substitute for the reviewer. Everything below is the
// structure a deliberate human decision is recorded in. Nothing here approves
// anything by itself.

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
//
// A closed list, mirrored by a CHECK constraint in 003_giveaway_lifecycle.sql.
// `other_approved_premium` exists so a genuinely special prize that fits none of
// the rest is not refused on a taxonomy technicality — it still needs the same
// deliberate approval as everything else, and it is the only category whose name
// says out loud that a human chose it.
const CATEGORIES = [
  {
    id: 'premium_electronics',
    label: 'Premium electronics',
    examples: 'Flagship phones, laptops, tablets, cameras, audio.',
  },
  {
    id: 'luxury_stay_or_holiday',
    label: 'Luxury accommodation and holidays',
    examples: 'Hotel and resort stays, package holidays, travel experiences.',
  },
  {
    id: 'designer_fashion_or_accessories',
    label: 'Designer clothing, watches, bags and accessories',
    examples: 'Recognised designer and luxury brands.',
  },
  {
    id: 'fine_dining_experience',
    label: 'High-end dining experiences',
    examples:
      'Tasting menus, chef’s table, notable restaurants. Not ordinary food, not groceries, not a delivery credit.',
  },
  {
    id: 'beauty_and_wellness',
    label: 'Premium beauty and wellness packages',
    examples: 'Spa days, treatment courses, premium product sets.',
  },
  {
    id: 'events_and_experiences',
    label: 'Concerts, sporting events and exclusive experiences',
    examples: 'Tickets, hospitality, access somebody could not simply buy on the day.',
  },
  {
    id: 'home_technology_and_appliances',
    label: 'Premium home technology and appliances',
    examples: 'Major appliances, home audio and video, smart-home systems.',
  },
  {
    id: 'vehicle_or_major_prize',
    label: 'Vehicles and other major prizes',
    examples: 'Cars, motorcycles, and prizes of comparable significance.',
  },
  {
    id: 'brand_voucher',
    label: 'Valuable vouchers from reputable brands',
    examples:
      'A substantial credit with a brand people know. Not a discount code, not money off a purchase.',
  },
  {
    id: 'other_approved_premium',
    label: 'Other lawful, high-quality product or experience',
    examples:
      'Deliberately approved by Naseeb as premium. The reviewer records why in the internal notes.',
  },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// ---------------------------------------------------------------------------
// Rejection grounds
// ---------------------------------------------------------------------------
//
// An allowlist, so a refusal is a category somebody can audit rather than free
// text. The wording a host reads is looked up from the code — a reviewer's own
// notes about a sponsor never become the message.
const REJECTION_GROUNDS = {
  NOT_PREMIUM: 'not_premium',
  PROMOTIONAL_MERCHANDISE: 'promotional_merchandise',
  ORDINARY_FOOD_OR_GROCERIES: 'ordinary_food_or_groceries',
  SAMPLE: 'sample',
  DISCOUNT_PRESENTED_AS_PRIZE: 'discount_presented_as_prize',
  CONDITION_UNACCEPTABLE: 'condition_unacceptable',
  UNLAWFUL_OR_UNSAFE: 'unlawful_or_unsafe',
  UNDISCLOSED_PURCHASE_REQUIRED: 'undisclosed_purchase_required',
  VALUE_MISLEADING: 'value_misleading',
  RESTRICTIONS_UNREASONABLE: 'restrictions_unreasonable',
  COMMITMENT_UNRELIABLE: 'commitment_unreliable',
  EVIDENCE_INSUFFICIENT: 'evidence_insufficient',
  INCOMPLETE_SUBMISSION: 'incomplete_submission',
};

const REJECTION_GROUND_IDS = Object.values(REJECTION_GROUNDS);

// What the host is told. Fixed sentences, chosen by code, never edited per row.
// None of them accuses anybody: a refused submission is a prize that does not
// fit this platform, not a charge against the person who offered it.
const REJECTION_COPY = {
  [REJECTION_GROUNDS.NOT_PREMIUM]:
    'This prize does not meet the premium standard Naseeb publishes. That is a judgement about fit rather than a comment on the product.',
  [REJECTION_GROUNDS.PROMOTIONAL_MERCHANDISE]:
    'Branded promotional merchandise is not published as a prize on Naseeb.',
  [REJECTION_GROUNDS.ORDINARY_FOOD_OR_GROCERIES]:
    'Ordinary food and grocery items are not published as prizes on Naseeb. High-end dining experiences are.',
  [REJECTION_GROUNDS.SAMPLE]: 'Product samples are not published as prizes on Naseeb.',
  [REJECTION_GROUNDS.DISCOUNT_PRESENTED_AS_PRIZE]:
    'A discount, money-off code or purchase credit is not a prize. A substantial voucher from a reputable brand can be.',
  [REJECTION_GROUNDS.CONDITION_UNACCEPTABLE]:
    'Naseeb publishes new, genuine and undamaged prizes only.',
  [REJECTION_GROUNDS.UNLAWFUL_OR_UNSAFE]:
    'This prize cannot be published because it is unlawful, unsafe, or cannot be given away lawfully here.',
  [REJECTION_GROUNDS.UNDISCLOSED_PURCHASE_REQUIRED]:
    'A prize that requires the winner to buy something cannot be published. Entry and receipt are free on Naseeb, always.',
  [REJECTION_GROUNDS.VALUE_MISLEADING]:
    'The stated value does not reflect what this prize is genuinely worth. Please submit the real retail or market value.',
  [REJECTION_GROUNDS.RESTRICTIONS_UNREASONABLE]:
    'The conditions attached to this prize are either unreasonable or were not disclosed up front. Every restriction has to be visible on the listing before anybody enters.',
  [REJECTION_GROUNDS.COMMITMENT_UNRELIABLE]:
    'This prize is not committed reliably enough to publish — for example it depends on remaining stock, or on availability that could disappear before the draw.',
  [REJECTION_GROUNDS.EVIDENCE_INSUFFICIENT]:
    'We could not confirm that this prize exists and is committed. Please submit something that shows it does.',
  [REJECTION_GROUNDS.INCOMPLETE_SUBMISSION]:
    'This submission is missing details Naseeb needs before it can review the prize.',
};

function rejectionCopyFor(ground) {
  return REJECTION_COPY[ground] || REJECTION_COPY[REJECTION_GROUNDS.INCOMPLETE_SUBMISSION];
}

// ---------------------------------------------------------------------------
// Custody and fulfilment
// ---------------------------------------------------------------------------
//
// Recorded per campaign because it genuinely differs per campaign. Naseeb is the
// winner-facing contact in all three cases; what changes is who is physically
// holding the thing, and saying "Naseeb personally delivers every prize" would
// be false for a hotel stay and false for a concert ticket.
const CUSTODY = {
  NASEEB_HOLDS: 'naseeb_holds',
  SPONSOR_HOLDS_COMMITTED: 'sponsor_holds_committed',
  PROVIDER_FULFILS: 'provider_fulfils',
};

const CUSTODY_IDS = Object.values(CUSTODY);

// Public wording. Truthful about who holds what, and consistent about who the
// winner talks to.
const CUSTODY_COPY = {
  [CUSTODY.NASEEB_HOLDS]:
    'Naseeb holds this prize and will arrange delivery or collection with the winner directly.',
  [CUSTODY.SPONSOR_HOLDS_COMMITTED]:
    'The sponsor holds this prize under a commitment to Naseeb. Naseeb coordinates delivery and stays the winner’s point of contact throughout.',
  [CUSTODY.PROVIDER_FULFILS]:
    'The provider fulfils this prize directly — for example the hotel, restaurant or venue. Naseeb coordinates the booking and stays the winner’s point of contact throughout.',
};

// Evidence: a reference and a verdict, never a document. Storing a sponsor's
// invoice or purchase order would put third-party commercial paperwork, and
// quite possibly personal data inside it, into this database for no operational
// gain. What is needed later is "did somebody check, and what did they check".
const EVIDENCE_KINDS = [
  'purchase_receipt_sighted',
  'supplier_invoice_sighted',
  'stock_confirmed_in_writing',
  'voucher_codes_held',
  'booking_reference_held',
  'prize_physically_inspected',
  'written_commitment_from_sponsor',
];

// ---------------------------------------------------------------------------
// The submission
// ---------------------------------------------------------------------------

// Everything a submission must carry before a reviewer can even look at it.
// Returned as a list of missing field names — never as a merged sentence, so a
// caller can render whichever it needs.
const REQUIRED_FOR_SUBMISSION = [
  'title',
  'description',
  'prize_description',
  'prize_category',
  'sponsor_name',
  'prize_supplied_by',
  'prize_retail_value_aed',
  'naseeb_custody',
  'fulfilment_method',
  'funded_by',
];

// Everything that must additionally be true before it may be PUBLISHED. These
// are the reviewer's, not the submitter's: evidence has to have been verified by
// a named administrator, and that is not something a host can assert about
// themselves.
const REQUIRED_FOR_PUBLICATION = [
  'prize_evidence_kind',
  'prize_evidence_reference',
  'prize_evidence_verified',
];

function missingForSubmission(submission = {}) {
  return REQUIRED_FOR_SUBMISSION.filter((field) => {
    const value = submission[field];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value.trim() === '') return true;
    if (field === 'prize_retail_value_aed') return !(Number(value) > 0);
    return false;
  });
}

function missingForPublication(row = {}) {
  const missing = REQUIRED_FOR_PUBLICATION.filter((field) => {
    const value = row[field];
    if (field === 'prize_evidence_verified') return value !== true;
    return value === undefined || value === null || String(value).trim() === '';
  });
  return missingForSubmission(row).concat(missing);
}

function isCategory(id) {
  return CATEGORY_IDS.includes(id);
}

function isCustody(id) {
  return CUSTODY_IDS.includes(id);
}

function isRejectionGround(id) {
  return REJECTION_GROUND_IDS.includes(id);
}

// What a public page may say about the standard. A statement of the approval
// process, not a claim about approval, licensing or compliance that has not
// happened.
const POSITIONING =
  'Naseeb features carefully selected premium prizes intended to create genuine excitement, happiness, and memorable experiences. Every prize is reviewed and approved by Naseeb before publication.';

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  CUSTODY,
  CUSTODY_IDS,
  CUSTODY_COPY,
  EVIDENCE_KINDS,
  REJECTION_GROUNDS,
  REJECTION_GROUND_IDS,
  REJECTION_COPY,
  REQUIRED_FOR_SUBMISSION,
  REQUIRED_FOR_PUBLICATION,
  POSITIONING,
  rejectionCopyFor,
  missingForSubmission,
  missingForPublication,
  isCategory,
  isCustody,
  isRejectionGround,
};
