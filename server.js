import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { paymeRouter } from './payme.js';
import { clickRouter } from './click.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(bodyParser.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// health check
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// routers
app.use('/payme', paymeRouter);
app.use('/click', clickRouter);

// static files
app.use(express.static(path.join(__dirname, 'public')));

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on port ' + port));
