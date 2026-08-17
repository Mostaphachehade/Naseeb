const express = require('express');
const { getSetting } = require('../lib/settings');
const { areClaimsEnabled } = require('../lib/featureFlags');
const { currentPolicies } = require('../lib/policies');
const appConfig = require('../lib/config');
const emailDelivery = require('../lib/emailDelivery');

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

      // What this deployment IS, so every page can say so.
      //
      // The COARSE state only — `private_beta`, `staging`, `development`,
      // `public_launch`. Deliberately not the launch blockers: those name the
      // policy work that is outstanding and the provider configuration that is
      // missing, which is an internal readiness detail and not something an
      // unauthenticated page should enumerate.
      deployment_state: appConfig.deploymentState(),
      is_public_launch: appConfig.isPublicLaunch(),
      // Present on any non-launch deployment. The wording is the truthful
      // disclosure; it carries no blocker detail and no configuration.
      deployment_disclosure: appConfig.stateDisclosure()
        ? appConfig.stateDisclosure().disclosure
        : null,

      // So the UI can say email is temporarily unavailable rather than letting
      // somebody fill in a signup form that will 503. A boolean and nothing
      // else — no provider name, no reason detail, no configuration.
      email_delivery_available: emailDelivery.canDeliver(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
