// Authenticated encryption for winner delivery details.
//
// A winner's home address and phone number are the most sensitive data this
// platform will ever hold, and they exist for one narrow purpose: getting a
// prize to them. They are encrypted with AES-256-GCM before they touch the
// database, so a leaked backup or a stray SELECT is ciphertext rather than a
// list of addresses.
//
// GCM rather than CBC because it authenticates as well as encrypts: a record
// altered in the database fails to decrypt instead of quietly returning
// tampered plaintext. Every record gets its own random IV — reusing an IV under
// the same key in GCM is catastrophic, not merely untidy.
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96 bits, the size GCM is defined for

// Keys are carried as "version:base64" so a rotation can be told apart from a
// re-encryption. The version is stored alongside each record, which is what
// makes it possible to introduce a new key without rewriting every existing
// row on the same day.
function parseKey(spec, label) {
  const raw = String(spec || '').trim();
  const separator = raw.indexOf(':');
  if (separator < 1) {
    throw new Error(`${label} must be in the form "version:base64key".`);
  }
  const version = raw.slice(0, separator);
  const key = Buffer.from(raw.slice(separator + 1), 'base64');
  if (key.length !== KEY_BYTES) {
    // Deliberately reports the length only. The value itself never appears in
    // an error, a log line or a stack trace.
    throw new Error(`${label} must decode to ${KEY_BYTES} bytes, got ${key.length}.`);
  }
  return { version, key };
}

// The key new records are encrypted with.
function activeKey() {
  if (!process.env.CLAIM_ENCRYPTION_KEY) {
    throw new Error('CLAIM_ENCRYPTION_KEY is not configured.');
  }
  return parseKey(process.env.CLAIM_ENCRYPTION_KEY, 'CLAIM_ENCRYPTION_KEY');
}

// Older keys, kept only so records written before a rotation can still be read.
// Rotation is therefore: add the current key to this list, generate a new
// active key, deploy. Nothing needs re-encrypting up front — records written
// under an old key stay readable until retention erases them, and every new
// record uses the new key.
function decryptionKeys() {
  const keys = [];
  try {
    keys.push(activeKey());
  } catch {
    // An unreadable active key must not stop an old record being decrypted.
  }
  const previous = String(process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS || '').trim();
  if (previous) {
    previous
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry, index) => {
        keys.push(parseKey(entry, `CLAIM_ENCRYPTION_KEYS_PREVIOUS[${index}]`));
      });
  }
  return keys;
}

function isConfigured() {
  try {
    activeKey();
    decryptionKeys();
    return true;
  } catch {
    return false;
  }
}

// Returns the three parts a record needs, plus the key version that produced
// them. Nothing here is reversible without the key.
function encryptDeliveryDetails(details) {
  const { version, key } = activeKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(details), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: version,
  };
}

// Throws if the record has been altered, if the tag does not verify, or if no
// configured key can read it. A failure here is a real signal — it means the
// stored bytes are not what this system wrote — so it is never swallowed into
// "no details available".
function decryptDeliveryDetails({ ciphertext, iv, tag, keyVersion }) {
  if (!ciphertext || !iv || !tag) {
    throw new Error('Delivery details are incomplete.');
  }

  const candidates = decryptionKeys().filter(
    (candidate) => !keyVersion || candidate.version === keyVersion
  );
  if (candidates.length === 0) {
    throw new Error(
      `No configured encryption key can read delivery details written under key version "${keyVersion}".`
    );
  }

  let lastError;
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        candidate.key,
        Buffer.from(iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch (err) {
      lastError = err;
    }
  }
  // Says that it failed, never what it was decrypting.
  throw new Error('Delivery details could not be decrypted or failed authentication.');
}

// For the setup documentation and for operators rotating a key.
function generateKeyMaterial() {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}

module.exports = {
  ALGORITHM,
  KEY_BYTES,
  IV_BYTES,
  isConfigured,
  activeKey,
  encryptDeliveryDetails,
  decryptDeliveryDetails,
  generateKeyMaterial,
};
