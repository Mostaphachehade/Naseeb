const express = require('express');

const router = express.Router();

// Non-secret values only — unsigned Cloudinary uploads only ever need the
// cloud name and an unsigned preset name, never an API secret.
router.get('/', (req, res) => {
  res.json({
    cloudinary_cloud_name: process.env.CLOUDINARY_CLOUD_NAME || null,
    cloudinary_upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET || null,
  });
});

module.exports = router;
