// Email delivery with provider abstraction: Resend (HTTP API), SMTP, or "log"
// (development: printed to the server log only).
import { config } from '../config.js';

let smtpTransport;

export function emailDelivery() {
  if (config.email.resendApiKey) return 'resend';
  if (config.email.smtpUrl) return 'smtp';
  return 'log';
}

export async function sendEmail({ to, subject, text, html }) {
  const delivery = emailDelivery();
  if (delivery === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Resend failed: ${r.status} ${await r.text()}`);
  } else if (delivery === 'smtp') {
    if (!smtpTransport) {
      const { default: nodemailer } = await import('nodemailer');
      smtpTransport = nodemailer.createTransport(config.email.smtpUrl);
    }
    await smtpTransport.sendMail({ from: config.email.from, to, subject, text, html });
  } else {
    console.log(`[email:log] to=${to} subject="${subject}"\n${text}\n`);
  }
  return delivery;
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
