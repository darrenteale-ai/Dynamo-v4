require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const shiftRoutes = require('./routes/shifts');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/shifts', shiftRoutes);

// Serve the built React app (built from ../frontend into ./public — see package.json "build" script)
const clientDist = path.join(__dirname, '..', 'public');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Dynamo server listening on :${PORT}`));
