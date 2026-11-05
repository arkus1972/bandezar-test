/* Bandezar – SERWER DANYCH na Cloudflare (zamiast Supabase). Opis: dokumentacja/CLOUDFLARE-BAZA.md.
   Baza: D1 (SQLite) pod nazwą DB. Pliki z Mediów: R2 pod nazwą PLIKI. Zmiany na żywo: Durable Object ZESPOL (serwer/na-zywo.mjs).
   Wszystko pod jednym adresem /api/... tej samej strony, więc aplikacja nie łączy się z żadnym obcym serwerem.

   Bezpieczeństwo (to samo, co pilnowały reguły RLS w Supabase, tylko tutaj w kodzie serwera):
   * logowanie kodem z maila: kod 6 cyfr, ważny 15 min, 5 prób; w bazie tylko skrót (SHA-256 z tajnym dodatkiem), limity wysyłki na adres i na IP,
   * sesja: losowy klucz 256 bitów, w bazie tylko jego skrót; ważna 60 dni od ostatniego użycia,
   * każde zapytanie sprawdza członkostwo i rolę w zespole (lider / edycja / odczyt) PO STRONIE SERWERA,
   * wszystkie zapytania SQL z parametrami (bind), żadnego sklejania tekstu z danymi → brak SQL injection,
   * dane z aplikacji sprawdzane: nazwy magazynów z listy, identyfikatory [A-Za-z0-9_:.-], limity długości i rozmiaru,
   * pliki: tylko typy z listy (bez HTML/SVG), max 50 MB, podawane z nosniff i jako załącznik/inline bez wykonywania,
   * wiadomości: serwer dostaje tylko szyfr (bz1:...), nadawcę i czas wpisuje sam. */

import { sprawdzLicencje } from './licencja.mjs';
import { schowek } from './pliki-do.mjs';

const ROLES = ['lider', 'edycja', 'odczyt'];
const STORES = ['members', 'albums', 'songs', 'setlists', 'events', 'riders', 'media', 'radio', 'venues', 'band', 'pulse'];
const RID = /^[A-Za-z0-9_:.-]{1,64}$/;
const FID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>"'(),;:\\]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
const MEDIA_OK = /^(audio\/(mpeg|mp4|aac|wav|x-wav|wave|ogg|webm|x-m4a|flac)|video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp|gif)|application\/pdf|text\/plain)$/;
const MEDIA_MAX = 50 * 1024 * 1024;
const DAY = 86400000;
const SESSION_DAYS = 60;
const CODE_MIN = 15;

/* ---------- odpowiedzi ---------- */
const NOSTORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function json(d, status) { return new Response(JSON.stringify(d), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', ...NOSTORE } }); }
function fail(status, error) { return json({ error }, status); }
class Blad extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const oops = (s, c) => { throw new Blad(s, c); };

/* ---------- pomocnicze ---------- */
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64url(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmac(key, s) { const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(s))); }
function same(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
function line(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); }
function email(v) { const e = line(v, 120).toLowerCase(); return EMAIL.test(e) ? e : ''; }
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }
async function body(request, max) {
  const raw = await request.text();
  if (raw.length > max) oops(413, 'too_big');
  try { const d = JSON.parse(raw || '{}'); if (d && typeof d === 'object') return d; } catch (_) { /* niżej */ }
  oops(400, 'json');
}

/* ---------- schemat bazy: zakładany sam przy pierwszym użyciu (nikt nie musi uruchamiać SQL) ---------- */
const SCHEMA_V = '2';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, h TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL, last INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bands (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS band_members (band_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, member_id TEXT, email TEXT, joined_at INTEGER NOT NULL, seen_at INTEGER, PRIMARY KEY (band_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS band_members_user ON band_members(user_id)`,
  `CREATE TABLE IF NOT EXISTS band_invites (code TEXT PRIMARY KEY, band_id TEXT NOT NULL, role TEXT NOT NULL, member_id TEXT, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS records (band_id TEXT NOT NULL, store TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL, PRIMARY KEY (band_id, store, id))`,
  `CREATE INDEX IF NOT EXISTS records_sync ON records(band_id, rev)`,
  `CREATE TABLE IF NOT EXISTS band_messages (id TEXT PRIMARY KEY, band_id TEXT NOT NULL, from_user TEXT NOT NULL, from_member TEXT, to_member TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS band_messages_band ON band_messages(band_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS msg_keys (user_id TEXT PRIMARY KEY, pub TEXT NOT NULL, priv TEXT NOT NULL, salt TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS device_codes (h TEXT PRIMARY KEY, user_id TEXT NOT NULL, exp INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', '0')`
];
let ready = null, SECRET = '';
async function ensure(env) {
  if (!env.DB) oops(503, 'not_configured');
  if (!ready) ready = (async () => {
    let v = null;
    try { v = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first('v'); } catch (_) { v = null; }
    if (v !== SCHEMA_V) {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      await env.DB.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('secret', ?)`).bind(b64url(rand(32))).run();
      await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(SCHEMA_V).run();
    }
    SECRET = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'secret'`).first('v');
    if (!SECRET) throw new Error('no secret');
  })().catch(e => { ready = null; throw e; });
  await ready;
}
export async function secret(env) { await ensure(env); return SECRET; }

/* limit: najwyżej n zdarzeń w oknie ms (i co najmniej gap ms odstępu) */
async function limit(env, k, n, ms, gap) {
  const now = Date.now(), r = await env.DB.prepare(`SELECT n, since, last FROM limits WHERE k = ?`).bind(k).first();
  if (r && gap && now - r.last < gap) oops(429, 'wait');
  if (r && now - r.since < ms && r.n >= n) oops(429, 'limit');
  if (!r || now - r.since >= ms) await env.DB.prepare(`INSERT INTO limits (k, n, since, last) VALUES (?, 1, ?, ?) ON CONFLICT(k) DO UPDATE SET n = 1, since = excluded.since, last = excluded.last`).bind(k, now, now).run();
  else await env.DB.prepare(`UPDATE limits SET n = n + 1, last = ? WHERE k = ?`).bind(now, k).run();
}

/* ---------- logowanie ---------- */
function mailHtml(code, app) {
  return '<!doctype html><html><body style="margin:0;background:#F3F0EA"><div style="max-width:480px;margin:0 auto;padding:28px 20px;font:16px/1.5 Arial,Helvetica,sans-serif;color:#1E2124">'
    + '<div style="font:bold 13px Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#6B6F73;margin-bottom:16px">Bandezar</div>'
    + '<p>Twój kod logowania do ' + app + ':</p><p style="font:bold 34px/1.2 Arial,sans-serif;letter-spacing:.2em;margin:18px 0">' + code + '</p>'
    + '<p style="color:#6B6F73;font-size:14px">Kod jest ważny ' + CODE_MIN + ' minut. Jeśli to nie Ty, zignoruj tę wiadomość.</p></div></body></html>';
}
async function sendCode(env, request, url) {
  const d = await body(request, 2000), e = email(d.email);
  if (!e) oops(400, 'email');
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  await limit(env, 'ip:' + ip, 30, 3600000, 0);
  await limit(env, 'mail:' + e, 6, 3600000, 50000);
  const test = env.TEST_KOD && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const code = test ? String(env.TEST_KOD) : String(100000 + (new Uint32Array(rand(4).buffer)[0] % 900000));
  await env.DB.prepare(`INSERT INTO codes (email, h, exp, tries) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET h = excluded.h, exp = excluded.exp, tries = 0`)
    .bind(e, await sha(SECRET + '|' + e + '|' + code), Date.now() + CODE_MIN * 60000).run();
  if (test) return json({ ok: true });
  if (!env.RESEND_KEY || !env.MAIL_FROM) oops(503, 'mail_not_configured');
  const app = line(env.APP_NAME || 'Bandezara', 60).replace(/[<>&"]/g, '');
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [e], subject: 'Kod logowania: ' + code, text: 'Twój kod logowania do ' + app + ': ' + code + '\nKod jest ważny ' + CODE_MIN + ' minut. Jeśli to nie Ty, zignoruj tę wiadomość.', html: mailHtml(code, app), tags: [{ name: 'kind', value: 'logowanie' }] }) });
  } catch (_) { oops(502, 'mail'); }
  if (!r.ok) oops(r.status === 429 ? 429 : 502, 'mail');
  return json({ ok: true });
}
async function verify(env, request) {
  const d = await body(request, 2000), e = email(d.email), code = String(d.code || '').replace(/\D/g, '');
  if (!e || code.length !== 6) oops(400, 'code');
  const r = await env.DB.prepare(`SELECT h, exp, tries FROM codes WHERE email = ?`).bind(e).first();
  if (!r || r.exp < Date.now() || r.tries >= 5) oops(400, 'code_expired');
  if (!same(r.h, await sha(SECRET + '|' + e + '|' + code))) {
    await env.DB.prepare(`UPDATE codes SET tries = tries + 1 WHERE email = ?`).bind(e).run();
    oops(400, 'code_wrong');
  }
  await env.DB.prepare(`DELETE FROM codes WHERE email = ?`).bind(e).run();
  let u = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(e).first('id');
  if (!u) { u = crypto.randomUUID(); await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`).bind(u, e, Date.now()).run();
    u = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(e).first('id'); }
  return json({ token: await newSession(env, u), user: { id: u, email: e }, days: SESSION_DAYS });
}
async function newSession(env, u) {
  const tok = b64url(rand(32)), now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND last_at < ?`).bind(u, now - SESSION_DAYS * DAY),
    env.DB.prepare(`INSERT INTO sessions (h, user_id, created_at, last_at) VALUES (?, ?, ?, ?)`).bind(await sha(tok), u, now, now)
  ]);
  return tok;
}
/* konto bez e-maila (instalacja zespołu: wejście kodem licencji, linkiem zaproszenia); w polu email wewnętrzny znacznik */
async function newUser(env) {
  const u = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).bind(u, 'brak:' + u, Date.now()).run();
  return u;
}
function imie(v) { return line(v, 60).replace(/[<>"]/g, '') || 'Ktoś z zespołu'; }
const ZES = env => env.TRYB === 'zespol';
/* kto pyta: z nagłówka Authorization: Bearer <klucz sesji> */
export async function userFrom(env, request) {
  await ensure(env);
  const m = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const h = await sha(m[1]), now = Date.now();
  const r = await env.DB.prepare(`SELECT s.user_id AS id, s.last_at AS last, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.h = ?`).bind(h).first();
  if (!r || now - r.last > SESSION_DAYS * DAY) return null;
  if (now - r.last > 6 * 3600000) await env.DB.prepare(`UPDATE sessions SET last_at = ? WHERE h = ?`).bind(now, h).run();
  return { id: r.id, email: r.email, h };
}
export async function roleOf(env, band, uid) {
  if (!UUID.test(String(band || '')) || !uid) return '';
  return (await env.DB.prepare(`SELECT role FROM band_members WHERE band_id = ? AND user_id = ?`).bind(band, uid).first('role')) || '';
}
async function need(env, band, uid, roles) {
  const r = await roleOf(env, band, uid);
  if (!r) oops(403, 'not_member');
  if (roles && !roles.includes(r)) oops(403, 'role');
  return r;
}
function bandP(v) { const b = String(v || ''); if (!UUID.test(b)) oops(400, 'band'); return b; }
function poke(env, ctx, band, what) {
  if (!env.ZESPOL) return;
  const stub = env.ZESPOL.get(env.ZESPOL.idFromName(band));
  const p = stub.fetch('https://zespol/' + what, { method: 'POST' }).catch(() => null);
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

/* ---------- zespoły, członkowie, zaproszenia ---------- */
async function myBands(env, me) {
  const r = await env.DB.prepare(`SELECT m.band_id, m.role, m.member_id, b.name FROM band_members m JOIN bands b ON b.id = m.band_id WHERE m.user_id = ? ORDER BY m.joined_at`).bind(me.id).all();
  return json(r.results.map(x => ({ band_id: x.band_id, role: x.role, member_id: x.member_id, name: x.name })));
}
async function createBand(env, request, me) {
  const d = await body(request, 2000), name = line(d.name, 120) || 'Zespół';
  if (ZES(env)) oops(403, 'one_band');   /* instalacja zespołu: jeden zespół, zakładany przy pierwszym uruchomieniu */
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bands WHERE created_by = ?`).bind(me.id).first('n');
  if (n >= 20) oops(429, 'too_many_bands');
  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bands (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`).bind(id, name, me.id, now),
    env.DB.prepare(`INSERT INTO band_members (band_id, user_id, role, email, joined_at) VALUES (?, ?, 'lider', ?, ?)`).bind(id, me.id, me.email, now)
  ]);
  return json({ id });
}
async function joinBand(env, request, me) {
  const d = await body(request, 2000), code = String(d.code || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) oops(400, 'invite');
  await limit(env, 'join:' + me.id, 20, 3600000, 0);
  return json({ id: await useInvite(env, code, me.id, me.email) });
}
async function useInvite(env, code, uid, label) {
  const now = Date.now();
  const i = await env.DB.prepare(`SELECT band_id, role, member_id FROM band_invites WHERE code = ? AND used_by IS NULL AND expires_at > ?`).bind(code, now).first();
  if (!i) oops(400, 'invite');
  /* zużycie kodu warunkowo (used_by IS NULL), żeby dwie osoby naraz nie weszły jednym kodem */
  const u = await env.DB.prepare(`UPDATE band_invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`).bind(uid, now, code).run();
  if (!u.meta || u.meta.changes !== 1) oops(400, 'invite');
  await env.DB.prepare(`INSERT INTO band_members (band_id, user_id, role, member_id, email, joined_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(band_id, user_id) DO NOTHING`)
    .bind(i.band_id, uid, i.role, i.member_id, label, now).run();
  return i.band_id;
}

/* ---------- INSTALACJA ZESPOŁU (TRYB=zespol): jeden zespół na własnym koncie Cloudflare, bez poczty ----------
   Pierwsze uruchomienie: kod licencji + nazwa zespołu → osoba zostaje liderem. Koledzy: link zaproszenia (#zaproszenie=…).
   Kolejne urządzenie tej samej osoby: link „Dodaj urządzenie” (#urzadzenie=…, ważny 15 min, jednorazowy). Opis: dokumentacja/INSTALACJA-ZESPOLU.md */
async function setupInfo(env) {
  if (!ZES(env)) return json({ tryb: 'app' });
  const b = await env.DB.prepare(`SELECT name FROM bands LIMIT 1`).first('name');
  return json({ tryb: 'zespol', gotowe: !!b, nazwa: b || '' });
}
async function setupStart(env, request) {
  if (!ZES(env)) oops(404, 'not_found');
  const d = await body(request, 4000);
  await limit(env, 'start:' + (request.headers.get('cf-connecting-ip') || 'x'), 10, 3600000, 0);
  const lic = await sprawdzLicencje(d.licencja, env.LICENCJA_PUBLICZNY);
  if (!lic) oops(400, 'licencja');
  const name = line(d.name, 120), who = imie(d.imie);
  if (!name) oops(400, 'name');
  /* tylko pierwszy: zajęcie instalacji jednym zapisem (drugi dostaje „już jest”) */
  const c = await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('zespol', ?) ON CONFLICT(k) DO NOTHING`).bind(JSON.stringify(lic)).run();
  if (!c.meta || c.meta.changes !== 1) oops(409, 'installed');
  const u = await newUser(env), id = crypto.randomUUID(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bands (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`).bind(id, name, u, now),
    env.DB.prepare(`INSERT INTO band_members (band_id, user_id, role, email, joined_at) VALUES (?, ?, 'lider', ?, ?)`).bind(id, u, who, now)
  ]);
  return json({ token: await newSession(env, u), user: { id: u, email: who }, band: { id, name } });
}
async function inviteEnter(env, request) {
  const d = await body(request, 2000), code = String(d.code || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) oops(400, 'invite');
  await limit(env, 'wejdz:' + (request.headers.get('cf-connecting-ip') || 'x'), 20, 3600000, 0);
  const ok = await env.DB.prepare(`SELECT 1 AS x FROM band_invites WHERE code = ? AND used_by IS NULL AND expires_at > ?`).bind(code, Date.now()).first('x');
  if (!ok) oops(400, 'invite');
  const who = imie(d.imie), u = await newUser(env);
  let band;
  try { band = await useInvite(env, code, u, who); } catch (e) { await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(u).run(); throw e; }
  return json({ token: await newSession(env, u), user: { id: u, email: who }, band: { id: band } });
}
async function deviceCode(env, me) {
  await limit(env, 'urz:' + me.id, 10, 3600000, 0);
  const code = b64url(rand(12));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM device_codes WHERE exp < ?`).bind(Date.now()),
    env.DB.prepare(`INSERT INTO device_codes (h, user_id, exp) VALUES (?, ?, ?)`).bind(await sha(code), me.id, Date.now() + CODE_MIN * 60000)
  ]);
  return json({ code });
}
async function deviceEnter(env, request) {
  const d = await body(request, 2000), code = String(d.code || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) oops(400, 'device');
  await limit(env, 'wejdz:' + (request.headers.get('cf-connecting-ip') || 'x'), 20, 3600000, 0);
  const h = await sha(code), r = await env.DB.prepare(`SELECT user_id, exp FROM device_codes WHERE h = ?`).bind(h).first();
  const del = await env.DB.prepare(`DELETE FROM device_codes WHERE h = ?`).bind(h).run();   /* jednorazowy */
  if (!r || r.exp < Date.now() || !del.meta || del.meta.changes !== 1) oops(400, 'device');
  const m = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(r.user_id).first('email');
  const lab = await env.DB.prepare(`SELECT email FROM band_members WHERE user_id = ? LIMIT 1`).bind(r.user_id).first('email');
  return json({ token: await newSession(env, r.user_id), user: { id: r.user_id, email: m && !m.startsWith('brak:') ? m : (lab || '') } });
}
async function licenseInfo(env) {
  const v = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'zespol'`).first('v');
  let d = null; try { d = v ? JSON.parse(v) : null; } catch (_) { d = null; }
  return json(d ? { n: d.n, i: d.i, d: d.d } : {});
}

/* ---------- KALENDARZ jako link do subskrypcji (Google, Apple, Outlook): tylko koncerty, próby i inne terminy zespołu ---------- */
async function calLink(env, request, url, me) {
  const d = await body(request, 1000), b = bandP(d.band);
  await need(env, b, me.id);
  return json({ url: url.origin + '/api/kalendarz/' + b + '.ics?k=' + await hmac(SECRET, 'ics|' + b) });
}
function icsText(v) { return String(v || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(l) { const out = []; let cur = ''; for (const ch of l) { if (enc.encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch; } out.push(cur); return out.join('\r\n'); }
async function icsFeed(env, url) {
  await ensure(env);
  const m = /^\/api\/kalendarz\/([0-9a-f-]{36})\.ics$/.exec(url.pathname), k = url.searchParams.get('k') || '';
  if (!m || !same(k, await hmac(SECRET, 'ics|' + m[1]))) return fail(404, 'not_found');
  const b = m[1];
  const bn = await env.DB.prepare(`SELECT data FROM records WHERE band_id = ? AND store = 'band' AND id = 'band'`).bind(b).first('data');
  let name = await env.DB.prepare(`SELECT name FROM bands WHERE id = ?`).bind(b).first('name') || 'Bandezar';
  try { const x = JSON.parse(bn || '{}'); if (x && typeof x.name === 'string' && x.name.trim()) name = x.name; } catch (_) { /* zostaje nazwa z bazy */ }
  const r = await env.DB.prepare(`SELECT id, data FROM records WHERE band_id = ? AND store = 'events' AND deleted = 0 LIMIT 3000`).bind(b).all();
  /* setlisty z datą, do których nie ma terminu: w Bandezarze też są w Terminach (jako koncert) */
  const sl = await env.DB.prepare(`SELECT id, data FROM records WHERE band_id = ? AND store = 'setlists' AND deleted = 0 LIMIT 3000`).bind(b).all();
  const linked = new Set();
  for (const row of r.results) { try { const e = JSON.parse(row.data); if (e && e.setlistId) linked.add(String(e.setlistId)); } catch (_) { /* pomijamy */ } }
  for (const row of sl.results) {
    let x; try { x = JSON.parse(row.data); } catch (_) { continue; }
    const g = x && x.org || {};
    if (!x || x.deleted || linked.has(String(row.id)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(g.date || ''))) continue;
    r.results.push({ id: 'sl_' + row.id, data: JSON.stringify({ type: 'koncert', title: line(x.pulse && x.pulse.name, 120), date: g.date, tStart: g.time, place: g.place, status: 'potw' }) });
  }
  const TYP = { koncert: 'Koncert', proba: 'Próba', inne: '' }, now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bandezar//PL', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText(line(name, 80)), 'X-WR-TIMEZONE:Europe/Warsaw', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const row of r.results) {
    let e; try { e = JSON.parse(row.data); } catch (_) { continue; }
    if (!e || e.deleted || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) || !/^[A-Za-z0-9_:.-]{1,70}$/.test(String(row.id))) continue;
    const day = e.date.replace(/-/g, ''), tm = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.tStart || '')) ? e.tStart.replace(':', '') + '00' : '';
    const typ = TYP[e.type] != null ? TYP[e.type] : '', title = line(e.title, 120) || line(e.place, 120) || typ || 'Termin';
    const where = [line(e.place, 120), line(e.address, 200), line(e.city, 80)].filter(Boolean).join(', ');
    const nd = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
    L.push('BEGIN:VEVENT', 'UID:' + row.id + '@' + b.slice(0, 8) + '.bandezar', 'DTSTAMP:' + now);
    if (tm) L.push('DTSTART;TZID=Europe/Warsaw:' + day + 'T' + tm, 'DURATION:PT3H'); else L.push('DTSTART;VALUE=DATE:' + day, 'DTEND;VALUE=DATE:' + nd);
    L.push('SUMMARY:' + icsText((typ && title !== typ ? typ + ': ' : '') + title));
    if (where) L.push('LOCATION:' + icsText(where));
    const desc = [e.tArrive ? 'Przyjazd ' + line(e.tArrive, 5) : '', e.tSound ? 'Próba dźwięku ' + line(e.tSound, 5) : '', e.tStart ? 'Start ' + line(e.tStart, 5) : ''].filter(Boolean).join(' · ');
    if (desc) L.push('DESCRIPTION:' + icsText(desc));
    L.push('STATUS:' + (e.status === 'odw' ? 'CANCELLED' : e.status === 'wstep' ? 'TENTATIVE' : 'CONFIRMED'), 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return new Response(L.map(icsFold).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=900', 'x-content-type-options': 'nosniff' } });
}
async function invite(env, request, me) {
  const d = await body(request, 2000), b = bandP(d.band);
  await need(env, b, me.id, ['lider']);
  const role = ROLES.includes(d.role) ? d.role : 'edycja', mem = d.member && RID.test(String(d.member)) ? String(d.member) : null;
  const code = b64url(rand(12));
  await env.DB.prepare(`INSERT INTO band_invites (code, band_id, role, member_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(code, b, role, mem, me.id, Date.now() + 14 * DAY).run();
  return json({ code });
}
async function members(env, url, me) {
  const b = bandP(url.searchParams.get('b'));
  await need(env, b, me.id);
  const r = await env.DB.prepare(`SELECT user_id, role, member_id, email, seen_at FROM band_members WHERE band_id = ? ORDER BY joined_at`).bind(b).all();
  return json(r.results.map(x => ({ user_id: x.user_id, role: x.role, member_id: x.member_id, email: x.email, seen_at: iso(x.seen_at) })));
}
async function setRole(env, request, me) {
  const d = await body(request, 2000), b = bandP(d.band), u = String(d.user || ''), role = String(d.role || '');
  await need(env, b, me.id, ['lider']);
  if (!UUID.test(u) || !ROLES.includes(role)) oops(400, 'role');
  if (u === me.id) oops(400, 'own_role');
  const r = await env.DB.prepare(`UPDATE band_members SET role = ? WHERE band_id = ? AND user_id = ?`).bind(role, b, u).run();
  if (!r.meta || r.meta.changes !== 1) oops(404, 'member');
  return json({ ok: true });
}
/* „jestem” (co minutę) + opcjonalnie „to ja w składzie”; odpowiedź: lista członków z czasem obecności */
async function ping(env, request, me) {
  const d = await body(request, 2000), b = bandP(d.band);
  await need(env, b, me.id);
  if (d.member != null && d.member !== '') {
    if (!RID.test(String(d.member))) oops(400, 'member');
    await env.DB.prepare(`UPDATE band_members SET seen_at = ?, member_id = ? WHERE band_id = ? AND user_id = ?`).bind(Date.now(), String(d.member), b, me.id).run();
  } else await env.DB.prepare(`UPDATE band_members SET seen_at = ? WHERE band_id = ? AND user_id = ?`).bind(Date.now(), b, me.id).run();
  const r = await env.DB.prepare(`SELECT user_id, member_id, email, seen_at FROM band_members WHERE band_id = ?`).bind(b).all();
  return json(r.results.map(x => ({ user_id: x.user_id, member_id: x.member_id, email: x.email, seen_at: iso(x.seen_at) })));
}

/* ---------- rekordy (piosenki, terminy, setlisty…) ---------- */
async function push(env, request, me, ctx) {
  const d = await body(request, 30 * 1024 * 1024), b = bandP(d.band);
  await need(env, b, me.id, ['lider', 'edycja']);
  const rows = Array.isArray(d.rows) ? d.rows : oops(400, 'rows');
  if (rows.length > 200) oops(413, 'too_many');
  const st = [];
  for (const x of rows) {
    if (!x || typeof x !== 'object' || !STORES.includes(x.store) || !RID.test(String(x.id || ''))) oops(400, 'row');
    const data = JSON.stringify(x.data == null ? {} : x.data), upd = Number(x.updated_at);
    if (data.length >= 1000000) oops(413, 'row_too_big');
    if (!Number.isSafeInteger(upd) || upd < 0) oops(400, 'updated_at');
    st.push(env.DB.prepare(`UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'rev'`));
    /* starsza zmiana nie nadpisuje nowszej (urządzenie, które długo było offline) */
    st.push(env.DB.prepare(`INSERT INTO records (band_id, store, id, data, updated_at, updated_by, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'rev'))
      ON CONFLICT(band_id, store, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted, rev = excluded.rev
      WHERE excluded.updated_at >= records.updated_at`).bind(b, x.store, String(x.id), data, upd, me.id, x.deleted === true ? 1 : 0));
  }
  if (st.length) { await env.DB.batch(st); poke(env, ctx, b, 'zmiana'); }
  return json({ ok: true, n: rows.length });
}
async function pull(env, url, me) {
  const b = bandP(url.searchParams.get('b'));
  await need(env, b, me.id);
  const after = Math.max(0, parseInt(url.searchParams.get('po') || '0', 10) || 0);
  const r = await env.DB.prepare(`SELECT store, id, data, updated_at, deleted, rev FROM records WHERE band_id = ? AND rev > ? ORDER BY rev LIMIT 500`).bind(b, after).all();
  return json(r.results.map(x => { let data = null; try { data = JSON.parse(x.data); } catch (_) { /* pomijamy */ }
    return { store: x.store, id: x.id, data, updated_at: x.updated_at, deleted: !!x.deleted, server_at: String(x.rev) }; }));
}
async function ids(env, url, me) {
  const b = bandP(url.searchParams.get('b'));
  await need(env, b, me.id);
  const off = Math.min(50000, Math.max(0, parseInt(url.searchParams.get('od') || '0', 10) || 0));
  const r = await env.DB.prepare(`SELECT store, id FROM records WHERE band_id = ? ORDER BY store, id LIMIT 1000 OFFSET ?`).bind(b, off).all();
  return json(r.results);
}

/* ---------- pliki z Mediów (R2): klucz <zespół>/<plik> ---------- */
async function files(env, request, url, me, parts) {
  const PLIKI = schowek(env);   /* R2 (bandezar-app) albo schowek w Durable Object (instalacja zespołu, bez karty) */
  if (!PLIKI) oops(503, 'not_configured');
  const b = bandP(parts[0]), id = parts[1] || '';
  if (!FID.test(id)) oops(400, 'file');
  const key = b + '/' + id;
  if (parts[2] === 'link') {
    if (request.method !== 'POST') oops(405, 'method');
    await need(env, b, me.id, ['lider', 'edycja']);
    const d = await body(request, 1000), secs = Math.min(400 * 86400, Math.max(60, parseInt(d.secs, 10) || 3600)), exp = Math.floor(Date.now() / 1000) + secs;
    if (!(await PLIKI.head(key))) oops(404, 'file');
    const s = await hmac(SECRET, 'plik|' + key + '|' + exp);
    return json({ url: url.origin + '/api/plik/' + key + '?e=' + exp + '&s=' + s });
  }
  if (parts.length !== 2) oops(404, 'not_found');
  if (request.method === 'GET') {
    await need(env, b, me.id);
    const o = await PLIKI.get(key);
    if (!o) oops(404, 'file');
    return new Response(o.body, { headers: { 'content-type': o.httpMetadata && o.httpMetadata.contentType || 'application/octet-stream', 'content-disposition': 'attachment', ...NOSTORE } });
  }
  if (request.method === 'PUT' || request.method === 'POST') {
    await need(env, b, me.id, ['lider', 'edycja']);
    const type = String(request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (!MEDIA_OK.test(type)) oops(415, 'type');
    const len = parseInt(request.headers.get('content-length') || '0', 10);
    if (len > MEDIA_MAX) oops(413, 'too_big');
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MEDIA_MAX || !buf.byteLength) oops(413, 'too_big');
    await PLIKI.put(key, buf, { httpMetadata: { contentType: type } });
    return json({ ok: true });
  }
  if (request.method === 'DELETE') {
    await need(env, b, me.id, ['lider', 'edycja']);
    await PLIKI.delete(key);
    return json({ ok: true });
  }
  oops(405, 'method');
}
/* link do jednego pliku dla osób spoza zespołu (np. PDF oferty dla klubu): podpisany, z datą ważności */
async function publicFile(env, url) {
  await ensure(env);
  const PLIKI = schowek(env);
  if (!PLIKI) return fail(503, 'not_configured');
  const m = /^\/api\/plik\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
  const exp = parseInt(url.searchParams.get('e') || '', 10), s = url.searchParams.get('s') || '';
  if (!m || !UUID.test(m[1]) || !exp || exp < Date.now() / 1000) return fail(404, 'file');
  const key = m[1] + '/' + m[2];
  if (!same(s, await hmac(SECRET, 'plik|' + key + '|' + exp))) return fail(404, 'file');
  const o = await PLIKI.get(key);
  if (!o) return fail(404, 'file');
  const type = o.httpMetadata && o.httpMetadata.contentType || 'application/octet-stream';
  return new Response(o.body, { headers: { 'content-type': MEDIA_OK.test(type) ? type : 'application/octet-stream', 'content-disposition': 'inline', 'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
}

/* ---------- zmiany na żywo: krótki bilet do gniazda (WebSocket nie umie wysłać nagłówka z kluczem) ---------- */
async function ticket(env, request, me) {
  const d = await body(request, 1000), b = bandP(d.band);
  await need(env, b, me.id);
  const exp = Math.floor(Date.now() / 1000) + 60, s = await hmac(SECRET, 'ws|' + b + '|' + me.id + '|' + exp);
  return json({ t: me.id + '.' + exp + '.' + s });
}
async function socket(env, request, url) {
  await ensure(env);
  if (!env.ZESPOL) return fail(503, 'not_configured');
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return fail(426, 'websocket');
  const b = url.searchParams.get('b') || '', p = String(url.searchParams.get('t') || '').split('.');
  if (!UUID.test(b) || p.length !== 3 || !UUID.test(p[0]) || !/^\d{10}$/.test(p[1]) || +p[1] < Date.now() / 1000) return fail(401, 'ticket');
  if (!same(p[2], await hmac(SECRET, 'ws|' + b + '|' + p[0] + '|' + p[1]))) return fail(401, 'ticket');
  if (!(await roleOf(env, b, p[0]))) return fail(403, 'not_member');
  const h = new Headers(request.headers); h.set('x-bz-user', p[0]);
  return env.ZESPOL.get(env.ZESPOL.idFromName(b)).fetch('https://zespol/ws', { headers: h });
}

/* ---------- wiadomości (szyfrowane na urządzeniu; tu tylko szyfr) ---------- */
function msgOut(x) { return { id: x.id, from_user: x.from_user, from_member: x.from_member, to_member: x.to_member, body: x.body, created_at: iso(x.created_at), read_at: iso(x.read_at) }; }
async function myMember(env, b, uid) { return (await env.DB.prepare(`SELECT member_id FROM band_members WHERE band_id = ? AND user_id = ?`).bind(b, uid).first('member_id')) || null; }
async function msgList(env, url, me) {
  const b = bandP(url.searchParams.get('b'));
  await need(env, b, me.id);
  const mm = await myMember(env, b, me.id);
  const r = await env.DB.prepare(`SELECT * FROM band_messages WHERE band_id = ? AND (from_user = ? OR (? IS NOT NULL AND to_member = ?)) ORDER BY created_at DESC LIMIT 300`).bind(b, me.id, mm, mm).all();
  return json(r.results.map(msgOut));
}
async function msgSend(env, request, me, ctx) {
  const d = await body(request, 50000), b = bandP(d.band), to = String(d.to || ''), txt = String(d.body || '');
  await need(env, b, me.id);
  if (!RID.test(to)) oops(400, 'to');
  if (txt.length < 5 || txt.length > 40000 || !txt.startsWith('bz1:')) oops(400, 'body');
  await limit(env, 'msg:' + me.id, 300, 3600000, 0);
  const x = { id: crypto.randomUUID(), band_id: b, from_user: me.id, from_member: await myMember(env, b, me.id), to_member: to, body: txt, created_at: Date.now(), read_at: null };
  await env.DB.prepare(`INSERT INTO band_messages (id, band_id, from_user, from_member, to_member, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(x.id, b, me.id, x.from_member, to, txt, x.created_at).run();
  poke(env, ctx, b, 'wiadomosc');
  return json(msgOut(x));
}
/* nadawca dopisuje szyfr dla adresata, który ustawił PIN po wysłaniu (tylko swoja i nieprzeczytana) */
async function msgReseal(env, request, me) {
  const d = await body(request, 50000), id = String(d.id || ''), txt = String(d.body || '');
  if (!UUID.test(id) || txt.length < 5 || txt.length > 40000 || !txt.startsWith('bz1:')) oops(400, 'body');
  const r = await env.DB.prepare(`UPDATE band_messages SET body = ? WHERE id = ? AND from_user = ? AND read_at IS NULL`).bind(txt, id, me.id).run();
  if (!r.meta || r.meta.changes !== 1) oops(404, 'message');
  return json({ ok: true });
}
async function msgRead(env, request, me) {
  const d = await body(request, 20000), b = bandP(d.band), list = Array.isArray(d.ids) ? d.ids.filter(x => UUID.test(String(x))).slice(0, 300) : [];
  await need(env, b, me.id);
  const mm = await myMember(env, b, me.id);
  if (!mm || !list.length) return json({ ok: true });
  const now = Date.now();
  await env.DB.batch(list.map(id => env.DB.prepare(`UPDATE band_messages SET read_at = ? WHERE id = ? AND band_id = ? AND to_member = ? AND read_at IS NULL`).bind(now, id, b, mm)));
  return json({ ok: true });
}
async function msgDelete(env, request, me) {
  const d = await body(request, 1000), id = String(d.id || '');
  if (!UUID.test(id)) oops(400, 'id');
  const x = await env.DB.prepare(`SELECT band_id, from_user, to_member FROM band_messages WHERE id = ?`).bind(id).first();
  if (!x) oops(404, 'message');
  await need(env, x.band_id, me.id);
  if (x.from_user !== me.id && x.to_member !== (await myMember(env, x.band_id, me.id))) oops(403, 'message');
  await env.DB.prepare(`DELETE FROM band_messages WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
async function keyGet(env, me) {
  const r = await env.DB.prepare(`SELECT pub, priv, salt FROM msg_keys WHERE user_id = ?`).bind(me.id).first();
  return json(r ? [r] : []);
}
async function keyPut(env, request, me) {
  const d = await body(request, 5000), pub = String(d.pub || ''), priv = String(d.priv || ''), salt = String(d.salt || '');
  if (!/^[A-Za-z0-9+/=]{40,200}$/.test(pub) || priv.length < 20 || priv.length > 2000 || salt.length < 16 || salt.length > 64) oops(400, 'key');
  await env.DB.prepare(`INSERT INTO msg_keys (user_id, pub, priv, salt, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET pub = excluded.pub, priv = excluded.priv, salt = excluded.salt, updated_at = excluded.updated_at`)
    .bind(me.id, pub, priv, salt, Date.now()).run();
  return json({ ok: true });
}
async function bandKeys(env, url, me) {
  const b = bandP(url.searchParams.get('b'));
  await need(env, b, me.id);
  const r = await env.DB.prepare(`SELECT m.user_id, m.member_id, k.pub FROM band_members m JOIN msg_keys k ON k.user_id = m.user_id WHERE m.band_id = ?`).bind(b).all();
  return json(r.results);
}

/* ---------- rozdzielnik: /api/baza/... ---------- */
export default async function baza(request, env, ctx) {
  const url = new URL(request.url), p = url.pathname.replace(/^\/api\/baza\/?/, '').split('/').filter(Boolean), M = request.method, k = M + ' ' + p.join('/');
  try {
    await ensure(env);
    /* bez logowania: tylko wysłanie kodu i sprawdzenie kodu */
    if (k === 'POST auth/kod') return await sendCode(env, request, url);
    if (k === 'POST auth/zaloguj') return await verify(env, request);
    if (k === 'GET instalacja') return await setupInfo(env);
    if (k === 'POST instalacja/start') return await setupStart(env, request);
    if (k === 'POST zaproszenie/wejdz') return await inviteEnter(env, request);
    if (k === 'POST urzadzenie/wejdz') return await deviceEnter(env, request);
    if (M !== 'GET' && M !== 'HEAD' && !/^application\/json/i.test(request.headers.get('content-type') || '') && p[0] !== 'pliki') return fail(415, 'json');
    const me = await userFrom(env, request);
    if (!me) return fail(401, 'login');
    switch (k) {
      case 'POST auth/wyloguj': await env.DB.prepare(`DELETE FROM sessions WHERE h = ?`).bind(me.h).run(); return json({ ok: true });
      case 'GET ja': return json({ id: me.id, email: me.email });
      case 'GET zespoly': return await myBands(env, me);
      case 'POST zespoly': return await createBand(env, request, me);
      case 'POST zespoly/dolacz': return await joinBand(env, request, me);
      case 'POST zaproszenia': return await invite(env, request, me);
      case 'GET czlonkowie': return await members(env, url, me);
      case 'POST czlonkowie/rola': return await setRole(env, request, me);
      case 'POST obecnosc': return await ping(env, request, me);
      case 'POST rekordy': return await push(env, request, me, ctx);
      case 'GET rekordy': return await pull(env, url, me);
      case 'GET rekordy/id': return await ids(env, url, me);
      case 'POST na-zywo/bilet': return await ticket(env, request, me);
      case 'GET wiadomosci': return await msgList(env, url, me);
      case 'POST wiadomosci': return await msgSend(env, request, me, ctx);
      case 'POST wiadomosci/szyfr': return await msgReseal(env, request, me);
      case 'POST wiadomosci/przeczytane': return await msgRead(env, request, me);
      case 'POST wiadomosci/usun': return await msgDelete(env, request, me);
      case 'GET klucze/moj': return await keyGet(env, me);
      case 'POST klucze/moj': return await keyPut(env, request, me);
      case 'GET klucze': return await bandKeys(env, url, me);
      case 'POST urzadzenie': return await deviceCode(env, me);
      case 'POST kalendarz': return await calLink(env, request, url, me);
      case 'GET licencja': return await licenseInfo(env);
    }
    if (p[0] === 'pliki') return await files(env, request, url, me, p.slice(1));
    return fail(404, 'not_found');
  } catch (e) {
    if (e instanceof Blad) return fail(e.status, e.code);
    console.error('baza', e && e.stack || e);
    return fail(500, 'server');
  }
}
export { publicFile, socket, icsFeed };
