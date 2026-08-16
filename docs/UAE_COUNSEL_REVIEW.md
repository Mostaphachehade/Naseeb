# UAE counsel review — open questions and missing facts

**Status: nothing in this repository has been reviewed or approved by qualified UAE
legal counsel.** This document is the handover: every legal decision that is still
open, and every fact that is deliberately blank because we will not invent it.

Nobody should read this repository, its documentation or its public pages as advice
that any campaign — ours or a host's — is lawful.

**The Terms and Privacy Policy are drafts with no effective date.** They have never been
presented to any user, nobody has accepted them, and the system refuses to record an
acceptance against a draft. Approving the text and making it effective are two separate,
deliberate steps — see §D. Neither happens automatically, and neither happens on deploy.

---

## A. Facts we do not have, and will not invent

Each of these appears in the product as *to be confirmed*. They are blank on purpose.
Filling them in with a plausible guess would be worse than leaving them empty, because
a reader cannot tell a guess from a fact.

| # | Missing fact | Where it is needed | Who can answer |
|---|---|---|---|
| A1 | Legal entity name operating Naseeb | Terms §1, §13; Privacy (controller); email footers | Owner |
| A2 | Trade licence number and issuing authority | Terms §13; About page | Owner |
| A3 | Registered address | Terms §13; Privacy (controller) | Owner |
| A4 | Data controller identity (which entity, in which capacity) | Privacy — "Who is responsible" | Owner + counsel |
| A5 | Contact address for legal notices | Terms §13 | Owner |
| A6 | Contact point for data-protection requests | Privacy — "Your rights" | Owner |
| A7 | Governing emirate and competent courts | Terms §11 | Counsel |
| A8 | Whether a consumer-dispute or arbitration route applies | Terms §11 | Counsel |
| A9 | VAT registration status and how it affects host/advertiser pricing | Pricing page; Terms §9 | Owner + accountant |

**Do not** substitute placeholders with invented values to make the pages look finished.
The automated check in `test/legal-copy.test.js` asserts the *to be confirmed* markers
are present precisely so they cannot quietly disappear.

---

## B. Legal questions that are open

### B1. Does anything about our model require a permit or licence?
We describe the platform factually — entry is free, hosts fund prizes, advertisers pay
for banners — and we have removed every claim that this places us outside any regulatory
regime. **We need advice on whether operating this platform, at any scale, requires
registration, a permit, or a licence in the UAE**, and whether the answer differs by
emirate.

### B2. Do individual promotional campaigns need permits, and whose duty is it?
Promotional campaigns and prize draws may require permits from emirate-level authorities
(for example a department of economic development). The Terms currently place that
responsibility on the host. **We need advice on whether that allocation is effective**,
or whether the platform carries obligations regardless of what the Terms say.

### B3. Consumer-protection obligations
UAE consumer-protection law may impose duties around advertised prizes, prize delivery,
and how winners are selected and announced. **We need advice on which apply to a platform
in our position, and what disclosures they require.**

### B4. Data protection (PDPL)
The Privacy Policy describes actual data flows and providers, but the legal analysis is
missing. Open:
- Which entity is controller, and are our providers processors?
- What lawful basis applies to each processing purpose?
- Do our cross-border transfers (Render, Neon, Stripe, Resend, Cloudinary, Google,
  Sentry — all at least partly outside the UAE) require specific safeguards?
- Which data-subject rights apply, and within what response times?
- Is a data-protection officer or registration required?
- Is our consent mechanism for sharing delivery details with a host adequate, and is the
  wording sufficient?

### B5. Retention periods
Every period in the product is **provisional** and set by our judgement, not advice:

| Data | Current provisional period |
|---|---|
| Encrypted delivery details (after delivery confirmed or dispute closed) | 30 days |
| Claim records and transition history | Indefinite |
| Account, giveaway and entry data | While the account is active; post-closure period undefined |
| Host applications, advertising enquiries | Undefined |
| Advertising payment records | Undefined — accounting/tax minimum needed |

**We need advice on minimum and maximum periods**, particularly where accounting or tax
law requires retention that conflicts with data-minimisation.

### B6. The three money flows
Host fees, advertiser payments and (absent) entrant payments are now distinguished
explicitly in the Terms and on the About page. **We need confirmation that a host paying
the platform for listing and marketing services does not change the character of the
giveaway** — our position is that it is a service fee, not a stake, and that it has no
bearing on any draw.

Note as of the host-access phase: **no host currently pays us anything.** The hosting
plans that were advertised were never built and have been removed; hosting is a free
closed beta. The question above is therefore not live today, but it becomes live the
moment a paid tier is introduced, so it stays open rather than being closed off.

### B7. Prize fulfilment and our role
The Terms state Naseeb is not a party to the giveaway, holds no prize, and is not an
escrow. An administrator resolves disputes about *the record on this platform*, which we
have been careful not to describe as determining anyone's legal rights. **We need advice
on whether that position holds**, and what our exposure is when a host fails to deliver.

### B8. Limitation of liability
Terms §10 limits liability "to the extent permitted by applicable law". **We need advice
on what is actually enforceable in the UAE**, and on whether consumer-facing limits are
narrower than business-facing ones.

### B9. Eligibility and the one-entry rule
The Terms now say plainly that the platform enforces one entry per verified account and
cannot verify one account per person. **We need advice on whether that is an adequate
fairness statement**, or whether stronger identity controls are required — and whether
those controls would themselves create data-protection obligations.

**Added in the entry-integrity phase.** There is now a review-and-disqualification
workflow: an administrator, never an algorithm, may place an entry under review or
disqualify it, with a written reason, and the entry itself is preserved whatever the
outcome. Three questions follow from that:

- **Is a written administrator reason, shown to the entrant, an adequate basis for
  excluding them from a prize draw** under UAE consumer-protection expectations — or is
  something more formal (notice period, appeal route, defined evidential standard)
  required?
- **What must happen when abuse is credibly alleged after a winner has been drawn?** The
  platform deliberately does *not* replace a winner, cancel a prize or redraw: it pauses
  fulfilment, records the case and waits for a human decision. **We need advice on
  whether any replacement or redraw policy is lawful here at all**, and if so what notice
  and evidence it requires, before such a policy is written.
- **Does the review workflow itself need to be described in the Terms**, and in what
  words, so that "entries obtained by holding several accounts may be voided" is
  enforceable rather than decorative?

### B9a. Entry-integrity signals and PDPL
When somebody enters a giveaway, the platform stores a one-way keyed hash of a coarsened
network address (IPv4 /24, IPv6 /48) beside the entry. The raw address is never written
anywhere. The hash is keyed with a dedicated secret and with the current retention window,
so it cannot be reversed and stops matching across windows; the default retention is 30
days. It feeds two indicators — several recently created accounts on one network, and
unusually rapid entries — which surface an entry to an administrator and nothing else. No
automated decision is taken from them.

**We need advice on:**

- whether a keyed, window-scoped hash of a coarsened network prefix is **personal data**
  in this context, and if so what lawful basis and notice apply;
- whether 30 days is a defensible retention period for it;
- whether the "no automated decision-making" position is correctly maintained given that
  a signal is what puts a human in front of the entry;
- whether the privacy-policy wording added for this (draft, "What we collect" and "Entry
  review and disqualification") is adequate.

### B10. Age
The Terms require entrants to be 18+, but signup does not currently ask for or record an
age confirmation. **We need advice on what confirmation is required**, and whether
anything more than self-declaration is expected.

### B11. Advertising terms and refunds
Terms §9 states that a placement we fail to run is refunded or rescheduled at the
advertiser's choice, and that a placement already run is not refundable. **We need
confirmation this is enforceable**, and whether any cooling-off right applies.

### B12. Policy acceptance
No account has ever been shown a versioned policy, and we record no historical
acceptance. Acceptance capture at signup is planned but not built. **We need advice on
what is required, whether existing users must be asked to accept afresh, and how a
material change should be communicated.**

---

## C. What we changed, and what we deliberately did not

**Removed** — every definitive claim that free entry places the platform outside a
regulatory regime, including "compliant by design", "zero gaming licence required",
"structurally outside the GCGRA definition of commercial gaming", "live and compliant
today", and "scoped to stay outside the licensing requirements the GCGRA applies".

**Kept, as factual description** — that paid-entry raffles are regulated in the UAE and
that the GCGRA oversees commercial gaming (both true and uncontroversial), and that this
application does not implement paid entry (a statement about our code, verifiable by
reading it).

**Deliberately not written** — any statement that a campaign run through Naseeb is
lawful, permitted, exempt, or does not require a permit. We do not have that advice and
will not imply it.

---

## D. Before this platform is offered publicly

- [ ] Section A facts supplied by the owner and published
- [ ] Section B questions answered by qualified UAE counsel
- [ ] Terms and Privacy revised to reflect that advice, with a new version and date
- [ ] Retention periods confirmed and the provisional wording removed
- [ ] Both policies moved from `draft` to `approved` in `server/lib/policies.js`, recording
      who approved them and when
- [ ] A deliberate, separate transition from `approved` to `effective` with an explicit
      effective date — not inferred from a version number or a calendar date
- [ ] Acceptance capture built, so a version and timestamp exist per account, from that
      point forward and never backdated
- [ ] Data access, correction and deletion workflows built (they are manual today, and
      the Privacy Policy says so)
- [x] A decision recorded on whether host paid plans are offered at all, given that they
      were advertised but not enforced — **answered for today only**: the three plans
      (free pilot, AED 250 / 3 listings, AED 900 per month) have been removed rather than
      repriced, no paid hosting tier exists, and no replacement price has been invented.
      Hosting is a closed beta granted per account by an administrator. Whether a paid tier
      is offered in future is still an open commercial decision, and B6 below (whether a
      host fee changes the character of a giveaway) remains open regardless

Until every box is ticked, this platform should not be described as compliant, approved,
or production-ready — including internally.
