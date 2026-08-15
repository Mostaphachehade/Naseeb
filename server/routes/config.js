const express = require('express');
const { getSetting } = require('../lib/settings');
const { areClaimsEnabled } = require('../lib/featureFlags');
const { currentPolicies } = require('../lib/policies');

const router = express.Router();

// Non-secret values only — unsigned Cloudinary uploads only ever need the
// cloud name and an unsigned preset name, never an API secret.
router.get('/', async (req, res) => {
  try {
    const [maintenanceMode, maintenanceMessage] = await Promise.all([
      getSetting('maintenance_mode'),
      getSetting('maintenance_message'),
    ]);
    res.json({
      cloudinary_cloud_name: process.env.CLOUDINARY_CLOUD_NAME || null,
      cloudinary_upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET || null,
      ga_measurement_id: process.env.GA_MEASUREMENT_ID || null,
      maintenance_mode: maintenanceMode === 'true',
      maintenance_message: maintenanceMessage,
      // No hosting prices are published here, because hosting has no paid tier
      // to price. It is a closed beta and it is free while it lasts.
      hosting_is_paid: false,
      hosting_access_model: 'private_beta_application',
      // So the host and winner UI can hide claim controls entirely rather than
      // rendering buttons that answer 503.
      claims_enabled: areClaimsEnabled(),
      // So the policy pages can show which version a reader is looking at
      // without that version being hard-coded into the markup twice.
      policies: currentPolicies(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
