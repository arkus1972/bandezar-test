/* Bandezar – wysyłka oferty koncertowej z serwera (Resend). Opis: dokumentacja/WYSYLKA-OFERT.md
   POST /api/oferta  (Authorization: Bearer <token zalogowanej osoby z Supabase>)
   body: { band, to, subj, body, tok, from, name, reply, img?, btn?, btnl? }  ->  { ok: true, id }

   Kto może wysłać: zalogowana osoba z prawem edycji (lider/edycja) w tym zespole. Sprawdzamy to w Supabase
   jej własnym tokenem (RLS), więc serwer nie potrzebuje klucza service_role.
   Nadawca: tylko adres w domenie z listy SEND_DOMAINS (zmienna Workera), odpowiedzi tylko na domenę z REPLY_DOMAINS.
   Treść: zwykły tekst od zespołu. HTML robimy tu sami: wszystko escapowane, linki tylko https, bez znaczników od użytkownika.
   Klucz Resend tylko jako sekret Workera (RESEND_KEY), nigdy w repo ani w przeglądarce. */

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOK = /^[a-z0-9]{8,24}$/;
const DOMAIN = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' };
const out = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...CORS } });
const fail = (status, error) => out({ ok: false, error }, status);

const line = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const text = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
const list = v => String(v || '').toLowerCase().split(/[\s,;]+/).filter(d => DOMAIN.test(d));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* tekst -> prosty, bezpieczny HTML: akapity, nowe linie, klikalne linki https.
   o.img: zdjęcie zespołu na górze (https), o.btn: link do oferty pokazany jako przycisk z napisem o.btnl,
   pierwszy akapit po powitaniu jako ukryty „preheader” (to, co skrzynka pokazuje pod tematem). */
const IMG = /^https:\/\/[^\s<>"'\\]{1,600}$/;
export function toHtml(body, band, o = {}) {
  const btn = IMG.test(o.btn || '') ? o.btn : '', img = IMG.test(o.img || '') ? o.img : '', btnl = o.btnl || 'Zobacz ofertę';
  const a = u => u === esc(btn)
    ? '</p><p style="margin:4px 0 18px"><a href="' + u + '" style="display:inline-block;background:#B5532F;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:6px">' + esc(btnl) + '</a></p><p style="margin:0 0 14px">'
    : '<a href="' + u + '" style="color:#B5532F">' + u + '</a>';
  const link = s => esc(s).replace(/https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, a);
  const ps = body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const paras = ps.map(p => '<p style="margin:0 0 14px">' + p.split('\n').map(link).join('<br>') + '</p>').join('').replace(/<p style="margin:0 0 14px">(\s|<br>)+/g, '<p style="margin:0 0 14px">').replace(/(\s|<br>)+<\/p>/g, '</p>').replace(/<p style="margin:0 0 14px"><\/p>/g, '');
  const pre = (ps.length > 1 && ps[0].length < 60 ? ps[1] : ps[0] || '').replace(/https:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
  return '<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>'
    + '<body style="margin:0;background:#F2EFE8">'
    + (pre ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(pre) + '</div>' : '')
    + '<div style="max-width:600px;margin:0 auto;padding:24px 20px;font:16px/1.5 Arial,Helvetica,sans-serif;color:#1E2124">'
    + (band ? '<div style="font:bold 13px Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#6B6F73;margin-bottom:16px">' + esc(band) + '</div>' : '')
    + (img ? '<img src="' + esc(img) + '" alt="' + esc(band || '') + '" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:8px;margin:0 0 20px">' : '')
    + paras + '</div></body></html>';
}

async function sb(env, path, token) {
  const r = await fetch(env.SB_URL + path, { headers: { apikey: env.SB_ANON, authorization: 'Bearer ' + token, accept: 'application/json' } });
  if (!r.ok) return null;
  try { return await r.json(); } catch (_) { return null; }
}

export default async function oferta(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return fail(405, 'method');
  if (!env.RESEND_KEY || (!env.AUTH && (!env.SB_URL || !env.SB_ANON))) return fail(503, 'not_configured');
  const auth = request.headers.get('authorization') || '', m = /^Bearer ([A-Za-z0-9._-]{20,4000})$/.exec(auth);
  if (!m) return fail(401, 'login');
  if (!/^application\/json/i.test(request.headers.get('content-type') || '')) return fail(415, 'json');
  const raw = await request.text();
  if (raw.length > 20000) return fail(413, 'too_big');
  let q; try { q = JSON.parse(raw); } catch (_) { return fail(400, 'json'); }
  if (!q || typeof q !== 'object') return fail(400, 'json');

  const band = String(q.band || ''), to = line(q.to, 120), subj = line(q.subj, 200), body = text(q.body, 4000).trim();
  const from = line(q.from, 120).toLowerCase(), name = line(q.name, 80).replace(/[<>"@,;:\\]/g, ''), tok = String(q.tok || ''), reply = line(q.reply, 120).toLowerCase();
  const img = line(q.img, 600), btn = line(q.btn, 600), btnl = line(q.btnl, 40);
  if (!UUID.test(band)) return fail(400, 'band');
  if (!EMAIL.test(to)) return fail(400, 'to');
  if (!subj || !body) return fail(400, 'empty');
  if (!EMAIL.test(from) || !list(env.SEND_DOMAINS).includes(from.split('@')[1])) return fail(400, 'from');
  if (tok && !TOK.test(tok)) return fail(400, 'tok');
  if (img && !IMG.test(img)) return fail(400, 'img');
  if (reply && (!DOMAIN.test(reply) || !list(env.REPLY_DOMAINS).includes(reply))) return fail(400, 'reply');

  /* kto pyta i czy może wysyłać w imieniu tego zespołu */
  /* env.AUTH: wersja na samym Cloudflare (worker-app.js) sprawdza logowanie we własnej bazie; inaczej pytamy Supabase */
  const user = env.AUTH ? await env.AUTH.user(request) : await sb(env, '/auth/v1/user', m[1]);
  if (!user || !UUID.test(String(user.id || ''))) return fail(401, 'login');
  let role = '';
  if (env.AUTH) role = await env.AUTH.role(band, user.id);
  else { const rows = await sb(env, '/rest/v1/band_members?select=role&band_id=eq.' + band + '&user_id=eq.' + user.id, m[1]); role = Array.isArray(rows) && rows[0] ? rows[0].role : ''; }
  if (role !== 'lider' && role !== 'edycja') return fail(403, 'role');

  const mail = { from: (name ? '"' + name + '" ' : '') + '<' + from + '>', to: [to], subject: subj, text: body, html: toHtml(body, name, { img, btn: IMG.test(btn) ? btn : '', btnl }),
    reply_to: reply && tok ? 'oferta-' + tok + '@' + reply : from, tags: [{ name: 'app', value: 'bandezar' }, { name: 'kind', value: 'oferta' }] };
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json', 'idempotency-key': tok ? 'oferta-' + band + '-' + tok : crypto.randomUUID() }, body: JSON.stringify(mail) });
  } catch (_) { return fail(502, 'send'); }
  let d = {}; try { d = await r.json(); } catch (_) { /* pusta odpowiedź */ }
  if (r.status === 429) return fail(429, 'limit');
  if (!r.ok) return fail(502, line(d && (d.name || d.message), 80) || 'send');
  return out({ ok: true, id: line(d.id, 80) });
}
