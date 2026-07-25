require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { init } = require('./db');

const authRoutes = require('./routes/auth');
const giveawayRoutes = require('./routes/giveaways');
const hostApplicationRoutes = require('./routes/hostApplications');
const adInquiryRoutes = require('./routes/adInquiries');
const adsRoutes = require('./routes/ads');
const adminRoutes = require('./routes/admin');
const configRoutes = require('./routes/config');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/giveaways', giveawayRoutes);
app.use('/api/host-applications', hostApplicationRoutes);
app.use('/api/ad-inquiries', adInquiryRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Naseeb running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to the database:', err.message);
    process.exit(1);
  });
