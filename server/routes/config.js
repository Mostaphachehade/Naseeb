const express = require('express');
const { getSetting } = require('../lib/settings');

const router = express.Router();

// Non-secret values only — unsigned Cloudinary uploads only ever need the
// cloud name and an unsigned preset name, never an API secret.
router.get('/', async (req, res) => {
  try {
    const [maintenanceMode, maintenanceMessage, standardPrice, partnerPrice] = await Promise.all([
      getSetting('maintenance_mode'),
      getSetting('maintenance_message'),
      getSetting('hosting_plan_standard_price_aed'),
      getSetting('hosting_plan_partner_price_aed'),
    ]);
    res.json({
      cloudinary_cloud_name: process.env.CLOUDINARY_CLOUD_NAME || null,
      cloudinary_upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET || null,
      ga_measurement_id: process.env.GA_MEASUREMENT_ID || null,
      maintenance_mode: maintenanceMode === 'true',
      maintenance_message: maintenanceMessage,
      hosting_plan_standard_price_aed: Number(standardPrice),
      hosting_plan_partner_price_aed: Number(partnerPrice),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
