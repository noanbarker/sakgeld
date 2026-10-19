#!/usr/bin/env node
// Makes the personal 30-day trial links for the offer email (see
// lib/trial-offer.js). Run on your own computer, never on Vercel:
//
//   TRIAL_OFFER_SECRET=... node tools/trial-offer/make-links.js families.csv > links.csv
//
// families.csv has a header row and the columns id,email,first_name (the
// Supabase user id, their email, their first name). links.csv comes out with
// an offer_url column added, ready to load into Loops. The secret must be the
// same TRIAL_OFFER_SECRET that's set in Vercel, or every link will be refused.
const fs = require('fs');
const { makeOfferToken } = require('../../lib/trial-offer');

const SITE = 'https://www.sproutearnsave.com';
const TRIAL_DAYS = 30;
const UTM = 'utm_source=loops&utm_medium=email&utm_campaign=trial_offer_30';

const file = process.argv[2];
const secret = process.env.TRIAL_OFFER_SECRET;
if (!file || !secret) {
  console.error('Usage: TRIAL_OFFER_SECRET=... node tools/trial-offer/make-links.js families.csv > links.csv');
  process.exit(1);
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const [header, ...rows] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
const cols = header.split(',').map((c) => c.trim());
const idCol = cols.indexOf('id');
if (idCol === -1) {
  console.error('families.csv needs an "id" column');
  process.exit(1);
}

console.log([...cols, 'offer_url'].join(','));
for (const row of rows) {
  if (!row.trim()) continue;
  const cells = row.split(',');
  const token = makeOfferToken(cells[idCol].trim(), TRIAL_DAYS, secret);
  console.log([...cells, csvCell(`${SITE}/app/?offer=${token}&${UTM}`)].join(','));
}
