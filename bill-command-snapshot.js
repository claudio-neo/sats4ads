// BITCOIN BILLS — LNURL-withdraw physical bills
// ============================================
import { bech32 } from '@scure/base';

const LNURL_BASE = 'https://lnurl.neofreight.net';

function encodeLnurl(url) {
  const data = new TextEncoder().encode(url);
  const words = bech32.toWords(data);
  return bech32.encode('lnurl', words, 1500).toUpperCase();
}

bot.onText(/\/bill(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  if (msg.chat.type !== 'private') {
    return bot.sendMessage(chatId, '💵 Usa `/bill <sats>` en privado para crear un billete Bitcoin.', { parse_mode: 'Markdown' });
  }

  const sats = match[1] ? parseInt(match[1]) : null;
  if (!sats || sats < 1) {
    return bot.sendMessage(chatId,
      `💵 *Bitcoin Bills — Billetes Lightning*\n\n` +
      `Crea billetes físicos de Bitcoin con QR rascable.\n` +
      `Cualquier wallet Lightning puede cobrarlos.\n\n` +
      `Uso: \`/bill <sats>\`\n` +
      `Ejemplo: \`/bill 1000\`\n\n` +
      `Los sats se descuentan de tu balance al crear el billete.`,
      { parse_mode: 'Markdown' });
  }

  if (sats > 1000000) {
    return bot.sendMessage(chatId, '❌ Máximo 1.000.000 sats por billete.');
  }

  const amountMsat = S(sats);
  const user = getOrCreateUser(userId, username);
  if (user.balance_msat < amountMsat) {
    return bot.sendMessage(chatId,
      `❌ Saldo insuficiente. Necesitas *${formatSats(amountMsat)}* sats. Tienes *${formatSats(user.balance_msat)}*.`,
      { parse_mode: 'Markdown' });
  }

  // Generate unique bill ID and k1 secret
  const crypto = await import('crypto');
  const billId = `BILL-${Date.now().toString(36).toUpperCase()}`;
  const k1 = crypto.randomBytes(32).toString('hex');

  // Deduct balance
  updateBalance(userId, -amountMsat, 'bill_create', `Bitcoin Bill: ${sats} sats (${billId})`);

  // Store bill
  db.prepare(`
    INSERT INTO lnurl_bills (id, creator_id, amount_msat, k1)
    VALUES (?, ?, ?, ?)
  `).run(billId, userId, amountMsat, k1);

  // Ledger
  try {
    ledgerWrite(userId.toString(), `ESCROW_BILL_${billId}`, amountMsat, 'bill_create', `Bill ${billId}`, `bill_${billId}`);
  } catch (e) { /* dual-write */ }

  // Build LNURL
  const lnurlUrl = `${LNURL_BASE}/lnurl/w/${k1}`;
  const lnurlEncoded = encodeLnurl(lnurlUrl);

  // Generate QR as base64 PNG for embedding in SVG
  const qrDataUrl = await QRCode.toDataURL(lnurlEncoded, {
    width: 280,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' }
  });

  // Format amount for display
  const satsDisplay = sats.toLocaleString('en-US');
  const serialDisplay = billId.replace('BILL-', '');

  // Generate bill SVG
  const billSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 860 400" width="860" height="400">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1a2e"/><stop offset="50%" stop-color="#16213e"/><stop offset="100%" stop-color="#0f3460"/>
    </linearGradient>
    <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f7931a"/><stop offset="100%" stop-color="#ffb347"/>
    </linearGradient>
    <linearGradient id="gv" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f7931a"/><stop offset="100%" stop-color="#e8820b"/>
    </linearGradient>
  </defs>
  <rect width="860" height="400" rx="18" fill="url(#bg)"/>
  <g opacity="0.04">
    <line x1="0" y1="80" x2="860" y2="80" stroke="#fff" stroke-width="0.5"/>
    <line x1="0" y1="160" x2="860" y2="160" stroke="#fff" stroke-width="0.5"/>
    <line x1="0" y1="240" x2="860" y2="240" stroke="#fff" stroke-width="0.5"/>
    <line x1="0" y1="320" x2="860" y2="320" stroke="#fff" stroke-width="0.5"/>
  </g>
  <rect x="6" y="6" width="848" height="388" rx="14" fill="none" stroke="url(#gold)" stroke-width="2" opacity="0.5"/>
  <rect x="16" y="16" width="828" height="368" rx="10" fill="none" stroke="url(#gold)" stroke-width="0.5" opacity="0.2"/>

  <!-- Lightning bolt -->
  <g transform="translate(36,30)"><polygon points="28,0 10,30 22,30 16,52 36,18 24,18" fill="url(#gv)"/></g>
  <text x="82" y="52" font-family="Georgia,serif" font-size="24" font-weight="700" fill="#f7931a" letter-spacing="3">BITCOIN</text>
  <text x="82" y="72" font-family="sans-serif" font-size="13" fill="rgba(255,255,255,0.5)" letter-spacing="5">LIGHTNING BEARER NOTE</text>

  <!-- Denomination badge -->
  <rect x="610" y="26" width="220" height="58" rx="10" fill="rgba(247,147,26,0.1)" stroke="rgba(247,147,26,0.35)" stroke-width="1.5"/>
  <text x="720" y="50" font-family="sans-serif" font-size="12" fill="rgba(255,255,255,0.5)" text-anchor="middle" letter-spacing="2">DENOMINATION</text>
  <text x="720" y="72" font-family="Georgia,serif" font-size="26" font-weight="700" fill="#f7931a" text-anchor="middle">${satsDisplay} SATS</text>

  <line x1="36" y1="96" x2="824" y2="96" stroke="rgba(247,147,26,0.2)" stroke-width="1"/>

  <!-- Amount -->
  <text x="50" y="150" font-family="sans-serif" font-size="14" fill="rgba(255,255,255,0.4)" letter-spacing="2">THIS NOTE ENTITLES THE BEARER TO</text>
  <text x="50" y="218" font-family="Georgia,serif" font-size="80" font-weight="700" fill="url(#gold)">${satsDisplay}</text>
  <text x="50" y="250" font-family="sans-serif" font-size="22" font-weight="600" fill="rgba(255,255,255,0.6)" letter-spacing="8">SATOSHIS</text>
  <text x="50" y="282" font-family="monospace" font-size="12" fill="rgba(255,255,255,0.25)" letter-spacing="2">SN: ${serialDisplay}</text>
  <text x="50" y="306" font-family="sans-serif" font-size="12" fill="rgba(255,255,255,0.35)">Backed 1:1 by Bitcoin on Lightning Network</text>

  <!-- BTC watermark -->
  <text x="280" y="290" font-family="Georgia,serif" font-size="260" font-weight="900" fill="rgba(247,147,26,0.03)" text-anchor="middle">₿</text>

  <!-- QR Code area -->
  <g transform="translate(558,108)">
    <rect width="180" height="180" rx="12" fill="#fff" stroke="rgba(247,147,26,0.3)" stroke-width="1.5"/>
    <image href="${qrDataUrl}" x="10" y="10" width="160" height="160"/>
  </g>
  <text x="648" y="304" font-family="sans-serif" font-size="11" fill="rgba(255,255,255,0.35)" text-anchor="middle" letter-spacing="2">SCAN TO REDEEM</text>

  <!-- Instructions -->
  <line x1="36" y1="326" x2="824" y2="326" stroke="rgba(247,147,26,0.2)" stroke-width="1"/>
  <text x="50" y="350" font-family="sans-serif" font-size="13" font-weight="700" fill="#f7931a" letter-spacing="2">HOW TO REDEEM</text>
  <g transform="translate(50,362)">
    <circle cx="8" cy="6" r="8" fill="rgba(247,147,26,0.15)" stroke="#f7931a" stroke-width="1"/>
    <text x="8" y="10" font-family="sans-serif" font-size="11" font-weight="700" fill="#f7931a" text-anchor="middle">1</text>
    <text x="22" y="10" font-family="sans-serif" font-size="12" fill="rgba(255,255,255,0.6)">Scratch the panel to reveal QR</text>
  </g>
  <g transform="translate(320,362)">
    <circle cx="8" cy="6" r="8" fill="rgba(247,147,26,0.15)" stroke="#f7931a" stroke-width="1"/>
    <text x="8" y="10" font-family="sans-serif" font-size="11" font-weight="700" fill="#f7931a" text-anchor="middle">2</text>
    <text x="22" y="10" font-family="sans-serif" font-size="12" fill="rgba(255,255,255,0.6)">Scan with any Lightning wallet</text>
  </g>
  <g transform="translate(600,362)">
    <circle cx="8" cy="6" r="8" fill="rgba(247,147,26,0.15)" stroke="#f7931a" stroke-width="1"/>
    <text x="8" y="10" font-family="sans-serif" font-size="11" font-weight="700" fill="#f7931a" text-anchor="middle">3</text>
    <text x="22" y="10" font-family="sans-serif" font-size="12" fill="rgba(255,255,255,0.6)">Sats instantly in your wallet ⚡</text>
  </g>
  <text x="50" y="392" font-family="sans-serif" font-size="9" fill="rgba(255,255,255,0.2)">⚠ Single use · First scan redeems · Do not share QR</text>
  <text x="810" y="392" font-family="sans-serif" font-size="9" fill="rgba(255,255,255,0.2)" text-anchor="end">⚡ LightningEasyBot</text>

  <!-- Corner accents -->
  <g stroke="url(#gold)" stroke-width="2" opacity="0.15">
    <path d="M24,24 L24,52"/><path d="M24,24 L52,24"/>
    <path d="M836,24 L836,52"/><path d="M836,24 L808,24"/>
    <path d="M24,376 L24,348"/><path d="M24,376 L52,376"/>
    <path d="M836,376 L836,348"/><path d="M836,376 L808,376"/>
  </g>
</svg>`;

  // Convert SVG to PNG using rsvg-convert
  const { execSync } = await import('child_process');
  const svgPath = `/tmp/bill_${billId}.svg`;
  const pngPath = `/tmp/bill_${billId}.png`;
  fs.writeFileSync(svgPath, billSvg);
  execSync(`rsvg-convert ${svgPath} -o ${pngPath} -w 1720 -h 800`);
  const pngBuffer = fs.readFileSync(pngPath);

  // Cleanup temp files
  try { fs.unlinkSync(svgPath); fs.unlinkSync(pngPath); } catch (e) {}

  logActivity('BILL_CREATED', userId, username, { bill_id: billId, amount_sats: sats });

  // Send bill image + QR-only as second message
  await bot.sendPhoto(chatId, pngBuffer, {
    caption:
      `💵 *Billete Bitcoin creado*\n\n` +
      `🆔 \`${billId}\`\n` +
      `⚡ *${formatSats(amountMsat)} sats*\n\n` +
      `Imprime el billete, cubre el QR con un sticker rascable, y regálalo.\n` +
      `Cualquier wallet Lightning puede cobrarlo escaneando el QR.\n\n` +
      `⚠️ _Un solo uso. El primero en escanear cobra._\n` +
      `Cancelar: \`/cancelbill ${billId}\``,
    parse_mode: 'Markdown'
  });
});

// /cancelbill — recover sats from unredeemed bill
bot.onText(/\/cancelbill\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const billId = match[1].toUpperCase();

  const bill = db.prepare('SELECT * FROM lnurl_bills WHERE id = ? AND creator_id = ?').get(billId, userId);
  if (!bill) return bot.sendMessage(chatId, '❌ Billete no encontrado o no es tuyo.');
  if (bill.status === 'redeemed') return bot.sendMessage(chatId, '❌ Este billete ya fue cobrado.');
  if (bill.status !== 'active') return bot.sendMessage(chatId, '❌ Este billete no se puede cancelar.');

