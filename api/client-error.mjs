// =====================================================
// Vercel Serverless Function — POST /api/client-error
// =====================================================
// Tiny error sink: receives client-side errors (window.onerror +
// unhandledrejection) and logs them. No DB writes for the error itself,
// only a Supabase-backed throttle counter.
//
// Rate limiting is global (not per-instance) via the ep_check_ip_throttle
// RPC in lib/ipThrottle.mjs, so an attacker cannot multiply the limit by
// hitting different Vercel instances.
// =====================================================

import { checkIpThrottle, getClientIp } from '../lib/ipThrottle.mjs';

export const config = { maxDuration: 5 };

const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD_LEN = 2000;

function truncate(s) {
  if (typeof s !== 'string') return '';
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) + '…' : s;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const throttle = await checkIpThrottle(req, 'client_error', { maxDay: 200, maxWeek: 1000, blockHours: 1 });
  if (!throttle.allowed) {
    return res.status(429).json({ error: 'rate limited' });
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }

  const ip = getClientIp(req);
  const type = truncate(body.type || 'unknown');
  const msg = truncate(body.msg || '');
  const stack = truncate(body.stack || '');
  const url = truncate(body.url || '');
  const ua = truncate(body.ua || req.headers['user-agent'] || '');
  const extra = body.extra && typeof body.extra === 'object' ? body.extra : null;

  // Single-line log so Vercel's log view groups it cleanly.
  console.error(
    `[client-error] ${type} ip=${ip} url=${url} msg="${msg}" ua="${ua}"` +
    (stack ? ` stack="${stack.replace(/\n/g, ' | ')}"` : '') +
    (extra ? ` extra=${JSON.stringify(extra).slice(0, 500)}` : '')
  );

  return res.status(204).end();
}
