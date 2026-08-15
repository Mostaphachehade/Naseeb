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

function publicPages() {
  return fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => ({ name: `public/${name}`, text: read(`public/${name}`) }));
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

test('policies carry a version and effective date, and claim no prior acceptance', () => {
  const { POLICIES } = require('../server/lib/policies');

  ['terms', 'privacy'].forEach((id) => {
    assert.ok(POLICIES[id], `${id} policy must be versioned`);
    assert.match(POLICIES[id].version, /^\d{4}-\d{2}-\d{2}\.\d+$/, 'version must be dated');
    assert.match(POLICIES[id].effectiveDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(POLICIES[id].reviewStatus, 'pending_counsel_review');
  });

  // Both documents must say, in the document itself, that acceptance is not
  // recorded — rather than leaving a reader to assume it is.
  const terms = read('public/terms.html');
  const privacy = read('public/privacy.html');
  assert.match(terms, /do not currently record acceptance/i);
  assert.match(privacy, /do not currently record acceptance/i);
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

  // The original said users could "review or correct your account details at any
  // time by signing in". No such screen exists.
  assert.ok(
    !/review or correct your account details at any time by signing in/i.test(privacy),
    'must not claim a self-service profile screen that does not exist'
  );
  assert.match(
    privacy,
    /no self-service screen|handled manually|planned work/i,
    'must say plainly that data requests are manual today'
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
