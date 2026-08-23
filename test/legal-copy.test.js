// Guards the legal and compliance copy.
//
// The pages once said "compliant by design", "zero gaming licence required" and
// "structurally outside the GCGRA definition of commercial gaming" — definitive
// legal conclusions that no qualified UAE lawyer had reviewed, sitting above a
// one-line disclaimer saying this isn't legal advice.
//
// Copy like that comes back. It reads well, it sells, and the person writing it
// is usually not thinking about regulatory exposure. This file fails the build
// if it does, and fails it with the reason attached.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

// A claim is made by what a page SAYS, and the markup between two words is not
// something a reader sees. Scanning the raw file conflated the two, and both
// directions of that were wrong.
//
// It missed claims: "compliant <em>by design</em>" is one sentence to a reader
// and two fragments to a regex, so splitting a prohibited phrase across an
// element hid it entirely.
//
// And it invented one. "This document has <strong>not</strong> been reviewed or
// approved by qualified UAE legal counsel" is a disclaimer; the negation guard
// looks back 60 characters to tell it apart from the claim. Wrapping the tail of
// that sentence in a translation span pushed "not" past the window, and the
// disclaimer was reported as the claim it disclaims. Widening the window is the
// wrong repair — a window long enough to reach across markup is also long enough
// to reach across a sentence boundary and excuse a real claim.
//
// So an HTML page is scanned as two strings. The first is its visible text, with
// every tag replaced by a space, which is what a reader reads and is immune to
// markup entirely. The second is the attribute values that reach a person
// anyway — a meta description in a search result, a title on hover, alt text
// read aloud — joined by a full stop so a negation in one value cannot excuse a
// claim in the next.
const READER_FACING_ATTRS = /\s(?:content|alt|title|aria-label|placeholder)="([^"]*)"/g;

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function readerFacingAttributes(html) {
  return [...html.matchAll(READER_FACING_ATTRS)].map((m) => m[1]).join(' . ');
}

function publicPages() {
  return fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((name) => name.endsWith('.html'))
    .flatMap((name) => {
      const html = read(`public/${name}`);
      return [
        { name: `public/${name}`, text: visibleText(html) },
        { name: `public/${name} (metadata)`, text: readerFacingAttributes(html) },
      ];
    });
}

// Everything a reader could take as a legal conclusion about our regulatory
// standing. Each carries the reason, so a failure explains itself rather than
// just pointing at a regex.
const PROHIBITED = [
  {
    pattern: /compliant by design/i,
    why: 'asserts a compliance conclusion no lawyer has given',
  },
  {
    pattern: /zero (gaming )?licen[cs]e required/i,
    why: 'asserts no licence is required — a legal conclusion, and one we cannot support',
  },
  {
    pattern: /(structurally )?outside the GCGRA/i,
    why: 'asserts a regulatory status for the platform',
  },
  {
    pattern: /sits outside that definition/i,
    why: 'asserts that free entry places a campaign outside gaming regulation',
  },
  {
    pattern: /live and compliant/i,
    why: 'claims present-tense compliance',
  },
  {
    pattern: /the compliant platform/i,
    why: 'brands the platform as compliant',
  },
  {
    pattern: /scoped to stay outside/i,
    why: 'asserts that the platform is outside a regulatory regime',
  },
  {
    pattern: /no (gaming )?licen[cs]e (is )?(needed|required)/i,
    why: 'asserts no licence is needed',
  },
  {
    pattern: /fully compliant|legally compliant|guaranteed compliant/i,
    why: 'unqualified compliance claim',
  },
  {
    pattern: /production[- ]ready/i,
    why: 'this platform has not been declared production-ready, and no document may say it has',
    // "is not production-ready" and "must not be called production-ready" are
    // exactly the sentences we want; only the affirmative claim is banned.
    allowIfNegated: true,
  },
  {
    pattern: /(approved|reviewed) by (our )?(qualified )?(uae )?(legal )?counsel/i,
    why: 'no counsel has reviewed or approved anything here',
    // "has NOT been reviewed by UAE legal counsel" is the sentence we want on
    // these pages, and it contains the phrase we are banning. Only the
    // affirmative claim is a problem.
    allowIfNegated: true,
  },
  {
    pattern: /(we )?guarantee(s)? (delivery|the prize|that you)/i,
    why: 'the platform does not guarantee prize delivery and must not say it does',
  },
  {
    pattern: /no permit(s)? (are |is )?(needed|required)/i,
    why: 'asserts a permit conclusion',
  },
  {
    pattern: /exempt from/i,
    why: 'asserts an exemption',
  },
];

// Files that make claims to the public or to whoever deploys this.
// True when the match is inside a negation — "has not been reviewed by
// counsel" rather than "reviewed by counsel". Looks back a short way, which is
// enough to separate the two without trying to parse English.
function isNegated(text, index) {
  const preceding = text.slice(Math.max(0, index - 60), index).toLowerCase();
  return /\b(not|never|no|nothing|neither|without)\b[^.]*$/.test(preceding);
}

function surfacesUnderReview() {
  return [
    ...publicPages(),
    { name: 'server/lib/emailTemplates.js', text: read('server/lib/emailTemplates.js') },
    { name: 'README.md', text: read('README.md') },
    { name: 'docs/LEGAL_COPY_INVENTORY.md', text: read('docs/LEGAL_COPY_INVENTORY.md') },
    { name: 'docs/UAE_COUNSEL_REVIEW.md', text: read('docs/UAE_COUNSEL_REVIEW.md') },
  ];
}

// The inventory and counsel checklist quote the removed claims in order to
// record what was removed. Those quotes are inside table rows and inline code,
// and must not trip the guard — but only in those two files, and only there.
const DOCUMENTATION_OF_REMOVED_CLAIMS = new Set([
  'docs/LEGAL_COPY_INVENTORY.md',
  'docs/UAE_COUNSEL_REVIEW.md',
]);

test('no prohibited legal or compliance claim appears in any public surface', () => {
  const failures = [];

  surfacesUnderReview()
    .filter((file) => !DOCUMENTATION_OF_REMOVED_CLAIMS.has(file.name))
    .forEach((file) => {
      PROHIBITED.forEach(({ pattern, why, allowIfNegated }) => {
        const match = file.text.match(pattern);
        if (!match) return;
        if (allowIfNegated && isNegated(file.text, match.index)) return;
        failures.push(`${file.name}: "${match[0]}" — ${why}`);
      });
    });

  assert.deepEqual(
    failures,
    [],
    `Prohibited legal claims found:\n  ${failures.join('\n  ')}\n\n` +
      'These assert a regulatory conclusion no qualified UAE lawyer has given. See ' +
      'docs/UAE_COUNSEL_REVIEW.md for what is still open.'
  );
});

test('the pages that discuss regulation say plainly that no counsel has reviewed them', () => {
  // Any page that raises the subject has to carry the caveat with it. A
  // disclaimer three pages away is not a disclaimer.
  const mentionsRegulation = publicPages().filter((page) =>
    /GCGRA|commercial gaming|regulated/i.test(page.text)
  );

  assert.ok(mentionsRegulation.length > 0, 'expected some pages to discuss regulation');

  mentionsRegulation.forEach((page) => {
    assert.match(
      page.text,
      /not (been )?(reviewed|approved) (or approved )?by (qualified )?UAE legal counsel|not legal advice/i,
      `${page.name} discusses regulation but does not say it is unreviewed or not legal advice`
    );
  });
});

test('free entry is never presented as removing other obligations', () => {
  const pages = publicPages().filter((page) => /GCGRA|commercial gaming/i.test(page.text));

  pages.forEach((page) => {
    // Each such page must acknowledge that other obligations can still apply.
    assert.match(
      page.text,
      /permit|consumer[- ]protection|advertising rules|obligation/i,
      `${page.name} discusses gaming regulation without acknowledging other obligations may still apply`
    );
  });
});

test('the four money flows are distinguished wherever payment is explained', () => {
  const terms = read('public/terms.html');
  const about = read('public/about.html');

  [terms, about].forEach((text) => {
    assert.match(text, /[Ee]ntrants pay nothing/, 'entrant position must be explicit');
    assert.match(text, /[Hh]osts may pay Naseeb/, 'host fees must be distinguished');
    assert.match(text, /[Aa]dvertisers may pay Naseeb/, 'advertiser payments must be distinguished');
    assert.match(text, /fund (and deliver )?the(ir own)? prize/i, 'prize funding must be attributed to hosts');
  });

  // And the host fee must be characterised as a service fee, not a stake.
  assert.match(terms, /not a stake/i, 'host fees must be distinguished from a stake');
});

test('facts we do not have are marked, not invented', () => {
  const terms = read('public/terms.html');
  const privacy = read('public/privacy.html');

  // The specific facts the counsel checklist lists as missing must appear as
  // placeholders rather than as plausible-looking values.
  assert.match(terms, /to be confirmed/i, 'Terms must mark unknown facts');
  assert.match(privacy, /to be confirmed/i, 'Privacy must mark unknown facts');

  // A licence number or a court would be invented facts. Nothing should look
  // like one.
  assert.ok(
    !/licen[cs]e (number|no\.?)\s*[:#]?\s*[A-Z0-9-]{4,}/i.test(terms),
    'Terms must not state a licence number'
  );
  assert.ok(
    !/courts? of (Dubai|Abu Dhabi|Sharjah|Ajman|Fujairah|Umm Al Quwain|Ras Al Khaimah)/i.test(terms),
    'Terms must not name a court that counsel has not confirmed'
  );
  assert.ok(
    !/(FZ-?LLC|L\.?L\.?C\.?|DMCC|Free Zone Establishment)\b/.test(privacy),
    'Privacy must not name a legal entity that has not been confirmed'
  );
});

test('retention periods are labelled provisional', () => {
  const privacy = read('public/privacy.html');
  const terms = read('public/terms.html');

  assert.match(
    privacy,
    /retention periods below are provisional/i,
    'Privacy must label its retention periods provisional'
  );
  assert.match(privacy, /pending (approval by )?(qualified )?UAE counsel/i);
  assert.match(terms, /provisional pending/i, 'Terms must label retention provisional');
});

test('policies are versioned drafts that claim no effective date and no acceptance', () => {
  const { POLICIES, POLICY_STATUS } = require('../server/lib/policies');

  ['terms', 'privacy'].forEach((id) => {
    assert.ok(POLICIES[id], `${id} policy must be versioned`);
    assert.match(POLICIES[id].version, /^\d{4}-\d{2}-\d{2}\.\d+-draft$/, 'a draft version must say so');
    assert.equal(POLICIES[id].status, POLICY_STATUS.DRAFT);
    // Not a date, not a placeholder — nothing. See test/policy-status.test.js
    // for why an asserted effective date was the original mistake.
    assert.equal(POLICIES[id].effectiveDate, null);
  });

  // Both documents must say, in the document itself, that acceptance is not
  // recorded — rather than leaving a reader to assume it is.
  const terms = read('public/terms.html');
  const privacy = read('public/privacy.html');
  assert.match(terms, /do not record acceptance/i);
  assert.match(privacy, /do not record acceptance/i);
});

test('the privacy policy names every provider that actually processes data', () => {
  const privacy = read('public/privacy.html');

  // Each of these is wired into the codebase; a policy that omits one is
  // describing a system other than this one.
  ['Render', 'PostgreSQL', 'Resend', 'Stripe', 'Cloudinary', 'Google Analytics', 'Sentry'].forEach(
    (provider) => {
      assert.match(
        privacy,
        new RegExp(provider, 'i'),
        `${provider} processes data for this application and must be named`
      );
    }
  );

  assert.match(privacy, /outside the UAE|cross-border|other countries/i, 'transfers must be disclosed');
});

test('the privacy policy does not claim capabilities that do not exist', () => {
  const privacy = read('public/privacy.html');

  // A self-service account centre now exists (Phase 2.3B), so the page may
  // describe one. What it must still not claim is the thing that does NOT
  // exist: deletion. A deletion request opens a case for a person to review and
  // erases nothing, and the page has to say that rather than implying a button.
  assert.match(
    privacy,
    /request for a person to review, not an erase button|not an erase button/i,
    'must say plainly that a deletion request is not an erasure'
  );
  assert.match(
    privacy,
    /Nothing is deleted when you send one/i,
    'must say that submitting a request deletes nothing'
  );
  assert.match(
    privacy,
    /has not been decided|to be confirmed/i,
    'must say that what happens after approval is undecided'
  );

  // And it must not promise a response deadline nobody has established.
  assert.ok(
    !/within\s+(\d+|thirty|sixty|ninety)\s+(days?|hours?)/i.test(privacy),
    'must not invent a statutory response deadline'
  );

  // Nor call a pseudonymous record anonymous.
  assert.ok(
    !/\banonymou?s(ly)?\b/i.test(privacy.replace(/We do not describe those as anonymous[^<]*/i, '')),
    'must not describe identifiable records as anonymous'
  );
});

test('the counsel review checklist exists and lists the open questions', () => {
  const checklist = read('docs/UAE_COUNSEL_REVIEW.md');

  // The document opens by saying so, across a line wrap.
  assert.match(
    checklist,
    /nothing in this repository has been reviewed or approved by qualified UAE\s+legal counsel/i
  );
  // The facts we refuse to invent.
  ['Legal entity', 'licence number', 'Registered address', 'controller', 'courts'].forEach((fact) => {
    assert.match(checklist, new RegExp(fact, 'i'), `${fact} must be listed as a missing fact`);
  });
  // And the substantive questions.
  ['permit', 'PDPL', 'Retention', 'liability', 'acceptance'].forEach((topic) => {
    assert.match(checklist, new RegExp(topic, 'i'), `${topic} must be an open question`);
  });
});
