# Legal and compliance copy — inventory of every claim, and what changed

Covers every HTML page, email template, README section and metadata tag that made a
legal, regulatory, licensing, fairness, privacy or guarantee claim. Compiled by
searching for *GCGRA, licence, compliant, regulated, gambling, gaming, lawful, legal,
guarantee, always, never, verified, fair, transparent, proven, certified* across
`public/*.html`, `server/lib/emailTemplates.js`, `README.md` and page metadata.

Enforced going forward by `test/legal-copy.test.js`, which fails if a prohibited claim
reappears.

---

## 1. Removed — definitive claims not approved by counsel

| Where | Claim as it stood | Now |
|---|---|---|
| `partners.html` `<title>`/meta description | "the compliant platform … built to avoid gaming-license requirements by design" | Factual description: free-entry platform, hosts fund prizes |
| `partners.html` og:description | "The compliant platform for free-entry giveaway marketing in the UAE." | Same, without the claim |
| `partners.html` H1 | "The compliant platform for free-entry giveaway marketing." | "Free-entry giveaway marketing, with a record of what happened." |
| `partners.html` lede | "compliant by design, not by policy" | Describes what the platform records; no compliance claim |
| `partners.html` body | "A genuine promotional giveaway … sits outside that definition entirely" | States we do not operate paid entry; explicitly says what that means legally is a question for counsel |
| `partners.html` comparison grid | "Zero gaming license required" · "Live and compliant today" · "No AML / KYC build-out needed to launch" · "Structurally outside the GCGRA definition of commercial gaming" | Replaced with a factual product comparison: what a paid-entry raffle is, and what Naseeb does |
| `partners.html` closing note | "Naseeb doesn't offer legal advice, and this isn't it." (a disclaimer under four compliance claims) | Prominent box: not legal advice, **not reviewed by UAE counsel**, no claim that use satisfies any requirement |
| `partners.html` "Why now" | "Naseeb was built to stay clearly on the right side of that line" | We built it free-entry because that is the model we want; we are seeking advice |
| `about.html` meta description | "free, transparent, and compliant" | "free, hosts fund their own prizes, every draw on the record" |
| `about.html` H2 | "Why it matters legally, not just ethically" | "Why free entry is built in, not bolted on" |
| `about.html` body | "A genuine promotional giveaway … sits outside that definition." | Describes the code; states plainly that free entry does not remove permit, advertising, consumer-protection or data-protection obligations |
| `about.html` disclaimer | "Naseeb doesn't offer legal advice, and this page isn't it." | Adds: not reviewed by UAE counsel; no claim that using the platform makes a campaign lawful |
| `terms.html` §7 Governing law | "Naseeb … is scoped to stay outside the licensing requirements the GCGRA applies to paid commercial gaming" | Removed entirely. Governing law now states UAE law and marks emirate/courts *to be confirmed* |
| `pricing.html` FAQ | "keeps Naseeb entirely in the free-promotion model rather than anything resembling paid gambling" | A host fee is a service fee — not a stake, not pooled, no effect on any draw |
| `README.md` "Why it's built this way" | "sits outside that definition. This app is scoped to stay in the free/promotional lane." | Describes the code; states explicitly it is not a legal conclusion; points to the counsel checklist |
| `index.html` meta | "compliant" in the description | "free-entry" |

## 2. Kept — factual, verifiable, uncontroversial

| Statement | Why it stays |
|---|---|
| "Paid-entry raffles and lotteries are regulated in most countries" | True and general |
| "In the UAE, commercial gaming is overseen by the GCGRA" | A statement about who the regulator is, not about our status |
| "There is no field for an entry price anywhere in the code" | A statement about this repository, verifiable by reading it |
| "Entry is free — no payment, no paid odds" | A description of the product, enforced by its schema |
| "Winners are selected using a cryptographically secure RNG after the deadline" | Describes `crypto.randomInt` in `routes/giveaways.js` |
| "Only the winner can confirm receipt" | Describes the state machine in `lib/claimStateMachine.js` |

## 3. Softened — fairness and guarantee wording

| Where | Was | Now |
|---|---|---|
| `terms.html` §3 Eligibility | "Each person may hold one account" — implied enforcement | States the platform enforces one entry per **verified account**, cannot verify one account per person, and that the phrase describes what the system enforces rather than a guarantee about people |
| `terms.html` prize delivery | "Naseeb is not responsible for a host failing to deliver a prize" | Expanded: not a party, no escrow, cannot compel delivery, does not underwrite it — plus what we *can* do (the record, and admin review) |
| `terms.html` disputes | Admin resolves disputes | Adds that an admin decision is operational, about the record on this platform, and does not determine legal rights or prevent a remedy elsewhere |
| `privacy.html` "Your rights" | "You can review or correct your account details at any time by signing in" | States plainly that no self-service screen exists yet, requests are manual, and building them is planned work |
| `privacy.html` retention | "we keep the encrypted delivery details for a limited period" | Table of every category with its period, all marked **provisional pending counsel approval** |

## 4. Added — the four money flows, distinguished explicitly

Previously conflated across pricing, partners and terms. Now stated in the same terms in
`about.html` ("Who pays for what") and `terms.html` §2:

1. **Entrants pay nothing** — no fee, ticket, paid odds or upgrade; no payment path exists on the entry journey.
2. **Hosts may pay Naseeb** for platform and marketing services for their own listing — a service fee, not a stake, not pooled, no effect on any draw.
3. **Advertisers may pay Naseeb** for banner placement — ordinary advertising, unconnected to any giveaway, entrant or draw.
4. **Hosts fund and deliver prizes** — the prize is the host's marketing cost; money paid to Naseeb never funds one.

## 5. Terms — now describes what the platform actually does

Rewritten to cover, in order: what Naseeb is and is not · who pays for what · eligibility
(including the honest limit of the one-entry rule) · hosting obligations · how winners are
selected · claiming, including single-use expiring links and that an expired claim goes to
admin review and is **never** auto-redrawn · delivery, winner-only confirmation, disputes
and the limits of an admin decision · cancellation and suspension · host fees, advertising
payments and refunds · no warranty · governing law · changes and versioning · contact.

## 6. Privacy — now describes real data flows and every provider

Names each provider and what it receives: **Render** (hosting), **hosted PostgreSQL,
currently Neon** (all stored data), **Resend** (email — and that addresses and phone
numbers are deliberately never put in an email), **Stripe** (advertiser card payments;
never reaches us), **Cloudinary** (uploaded images), **Google Analytics** (when
configured; signals and ad personalisation disabled; not loaded on the claim page),
**Sentry** (when configured; identifiers not personal data). Adds cross-border transfers,
how delivery details are encrypted, the fragment-based claim link, and the retention
table.

## 7. Versioning and effective dates

`server/lib/policies.js` holds a version and effective date per document, exposed through
`/api/config` and rendered on both pages, so the page and the record cannot drift.

A `policy_acceptances` table exists and **starts empty on purpose**. No account has ever
been shown a versioned policy, so there is no historical acceptance — and both documents
say so in as many words rather than implying otherwise. Acceptance capture at signup is
planned work (Phase 2), not something claimed to exist.

## 8. Not done, on purpose

- No legal entity name, licence number, registered address, controller identity, contact
  email or court jurisdiction has been invented. Each is marked *to be confirmed* and
  listed in `docs/UAE_COUNSEL_REVIEW.md` §A.
- No statement that the platform is compliant, approved, exempt, or production-ready
  appears anywhere — including in this document.
