const { pool } = require('../db');

// Defaults double as the source of truth for which settings keys exist —
// setSetting() rejects anything not listed here, so a typo'd key can't
// silently create an orphaned row nobody reads.
const DEFAULTS = {
  ad_price_per_week_aed: '500',
  hosting_plan_standard_price_aed: '250',
  hosting_plan_partner_price_aed: '900',
  maintenance_mode: 'false',
  maintenance_message: 'Naseeb is undergoing scheduled maintenance. Some features may be temporarily unavailable.',
};

async function getSetting(key) {
  const result = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return result.rows[0] ? result.rows[0].value : DEFAULTS[key];
}

async function getAllSettings() {
  const result = await pool.query('SELECT key, value FROM site_settings');
  const settings = { ...DEFAULTS };
  result.rows.forEach((row) => {
    settings[row.key] = row.value;
  });
  return settings;
}

async function setSetting(key, value) {
  if (!(key in DEFAULTS)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

module.exports = { getSetting, getAllSettings, setSetting, DEFAULTS };
