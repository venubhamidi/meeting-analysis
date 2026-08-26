import { createApp } from './api/app.js';
import { db } from './db.js';
import { storage } from './storage.js';

const port = Number(process.env.PORT ?? 8080);
createApp(db(), storage()).listen(port, () => {
  console.log(`worker api listening on ${port}`);
});
