/**
 * LNURL-withdraw server for Bitcoin Bills
 * Runs on port 3901, proxied via Caddy
 */
import express from 'express';
import { lndRequest, httpsAgent } from './lnd.js';
import { db } from './db.js';

const app = express();
const PORT = 3901;
const BASE_URL = process.env.LNURL_BASE || 'https://lnurl.neofreight.net';

// ── LNURL-withdraw: initial request ─────────────────────────────────────────
// Wallet scans QR → decodes LNURL → calls this endpoint
app.get('/lnurl/w/:k1', (req, res) => {
  const { k1 } = req.params;
  const bill = db.prepare('SELECT * FROM lnurl_bills WHERE k1 = ?').get(k1);

  if (!bill) {
    return res.json({ status: 'ERROR', reason: 'Bill not found.' });
  }
  if (bill.status === 'redeemed') {
    return res.json({ status: 'ERROR', reason: 'This bill has already been redeemed.' });
  }
  if (bill.status === 'expired') {
    return res.json({ status: 'ERROR', reason: 'This bill has expired.' });
  }

  res.json({
    tag: 'withdrawRequest',
    callback: `${BASE_URL}/lnurl/w/callback`,
    k1: k1,
    minWithdrawable: bill.amount_msat,
    maxWithdrawable: bill.amount_msat,
    defaultDescription: `Bitcoin Bill ⚡ ${Math.floor(bill.amount_msat / 1000)} sats`
  });
});

// ── LNURL-withdraw: callback (wallet sends invoice) ─────────────────────────
app.get('/lnurl/w/callback', async (req, res) => {
  const { k1, pr } = req.query;

  if (!k1 || !pr) {
    return res.json({ status: 'ERROR', reason: 'Missing k1 or pr parameter.' });
  }

  const bill = db.prepare('SELECT * FROM lnurl_bills WHERE k1 = ?').get(k1);
  if (!bill) {
    return res.json({ status: 'ERROR', reason: 'Bill not found.' });
  }
  if (bill.status !== 'active') {
    return res.json({ status: 'ERROR', reason: 'This bill has already been redeemed.' });
  }

  // Mark as processing to prevent double-spend
  const updated = db.prepare(
    "UPDATE lnurl_bills SET status = 'processing' WHERE k1 = ? AND status = 'active'"
  ).run(k1);
  if (updated.changes === 0) {
    return res.json({ status: 'ERROR', reason: 'Bill already being processed.' });
  }

  try {
    // Decode the invoice to verify amount
    const decoded = await lndRequest('GET', `/v1/payreq/${pr}`);
    const invoiceMsat = parseInt(decoded.num_satoshis) * 1000;

    if (invoiceMsat > bill.amount_msat) {
      db.prepare("UPDATE lnurl_bills SET status = 'active' WHERE k1 = ?").run(k1);
      return res.json({ status: 'ERROR', reason: 'Invoice amount exceeds bill value.' });
    }

    // Pay the invoice
    const payment = await lndRequest('POST', '/v1/channels/transactions', {
      payment_request: pr,
      fee_limit: { fixed: '10' }, // max 10 sat fee
      timeout_seconds: 30
    });

    if (payment.payment_error) {
      db.prepare("UPDATE lnurl_bills SET status = 'active' WHERE k1 = ?").run(k1);
      return res.json({ status: 'ERROR', reason: `Payment failed: ${payment.payment_error}` });
    }

    // Success — mark bill as redeemed
    db.prepare(
      "UPDATE lnurl_bills SET status = 'redeemed', redeemed_at = strftime('%s','now'), payment_hash = ? WHERE k1 = ?"
    ).run(payment.payment_hash || '', k1);

    console.log(`[LNURL] Bill ${bill.id} redeemed: ${Math.floor(bill.amount_msat/1000)} sats`);
    res.json({ status: 'OK' });

  } catch (e) {
    console.error('[LNURL] Payment error:', e.message);
    // Revert to active so it can be tried again
    db.prepare("UPDATE lnurl_bills SET status = 'active' WHERE k1 = ?").run(k1);
    res.json({ status: 'ERROR', reason: 'Payment processing failed. Please try again.' });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/lnurl/health', (_, res) => res.json({ ok: true, service: 'lnurl-withdraw' }));

app.listen(PORT, () => console.log(`[LNURL] Server running on port ${PORT}`));
