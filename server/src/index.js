'use strict';

const path = require('node:path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'team-lunch.db');

const app = createApp({ dbPath });
app.listen(port, () => {
  console.log(`Team Lunch API listening on http://localhost:${port}`);
});
