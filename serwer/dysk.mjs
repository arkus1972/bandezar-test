/* Bandezar – przeglądanie udostępnionego folderu z Dysku Google (np. nagrania koncertów). Opis: dokumentacja/MEDIA-DYSK.md
   GET /api/dysk?id=<id folderu>[&rk=<resourcekey>]   (Authorization: Bearer <token zalogowanej osoby z Supabase>)
   -> { ok: true, items: [{ id, name, mime, size, time, dur }], more }

   Działa tylko dla folderów udostępnionych „Każdy, kto ma link” (Drive API z kluczem API, bez logowania do Google).
   Klucz tylko jako sekret Workera (GOOGLE_KEY), nigdy w repo ani w przeglądarce.
   Tylko zalogowani w Bandezarze (token Supabase sprawdzany w Supabase), żeby obcy nie zużywali limitu klucza. */

const ID = /^[A-Za-z0-9_-]{10,200}$/;
const RK = /^[A-Za-z0-9_-]{1,100}$/;
const FOLDER = 'application/vnd.google-apps.folder';
export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '600' };
const out = (body, status = 200, cache = 'no-store') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff', ...CORS } });
const fail = (status, error) => out({ ok: false, error }, status);
const line = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const MIME = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,80}$/;

export function clean(f) {
  if (!f || !ID.test(f.id || '')) return null;
  const mime = MIME.test(f.mimeType || '') ? f.mimeType : 'application/octet-stream';
  const o = { id: f.id, name: line(f.name, 200) || f.id, mime };
  const size = Number(f.size); if (Number.isFinite(size) && size > 0) o.size = Math.round(size);
  const time = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(f.modifiedTime || '') ? f.modifiedTime : ''; if (time) o.time = time;
  const dur = Number(f.videoMediaMetadata && f.videoMediaMetadata.durationMillis); if (Number.isFinite(dur) && dur > 0) o.dur = Math.round(dur / 1000);
  return o;
}

export default async function dysk(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return fail(405, 'method');
  if (!env.GOOGLE_KEY || (!env.AUTH && (!env.SB_URL || !env.SB_ANON))) return fail(503, 'not_configured');
  const m = /^Bearer ([A-Za-z0-9._-]{20,4000})$/.exec(request.headers.get('authorization') || '');
  if (!m) return fail(401, 'login');
  const u = new URL(request.url), id = u.searchParams.get('id') || '', rk = u.searchParams.get('rk') || '';
  if (!ID.test(id) || (rk && !RK.test(rk))) return fail(400, 'id');
  /* env.AUTH: wersja na samym Cloudflare (worker-app.js) sprawdza logowanie we własnej bazie */
  if (env.AUTH) { if (!(await env.AUTH.user(request))) return fail(401, 'login'); }
  else {
    const who = await fetch(env.SB_URL + '/auth/v1/user', { headers: { apikey: env.SB_ANON, authorization: 'Bearer ' + m[1] } }).catch(() => null);
    if (!who || !who.ok) return fail(401, 'login');
  }

  const headers = { accept: 'application/json', referer: 'https://bandezar.arkus1972.workers.dev/' };
  if (rk) headers['x-goog-drive-resource-keys'] = id + '/' + rk;
  const items = []; let page = '', pages = 0;
  do {
    const q = new URLSearchParams({ q: "'" + id + "' in parents and trashed = false", fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,videoMediaMetadata(durationMillis))',
      pageSize: '1000', orderBy: 'folder,name', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', key: env.GOOGLE_KEY });
    if (page) q.set('pageToken', page);
    const r = await fetch('https://www.googleapis.com/drive/v3/files?' + q, { headers }).catch(() => null);
    if (!r) return fail(502, 'google');
    if (r.status === 404) return fail(404, 'not_found');
    if (r.status === 403 || r.status === 429) { const d = await r.json().catch(() => ({})); const why = JSON.stringify(d).match(/rateLimit|quota|userRateLimit/i) ? 'limit' : 'forbidden'; return fail(r.status === 429 ? 429 : 403, why); }
    if (r.status === 400) return fail(400, 'id');
    if (!r.ok) return fail(502, 'google');
    const d = await r.json().catch(() => ({}));
    (Array.isArray(d.files) ? d.files : []).forEach(f => { const c = clean(f); if (c) items.push(c); });
    page = typeof d.nextPageToken === 'string' && d.nextPageToken.length < 500 ? d.nextPageToken : '';
  } while (page && ++pages < 5);
  // Drive dla pustego albo prywatnego folderu z kluczem API często zwraca pustą listę zamiast błędu: sprawdzamy sam folder
  if (!items.length) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + id + '?' + new URLSearchParams({ fields: 'id,mimeType', supportsAllDrives: 'true', key: env.GOOGLE_KEY }), { headers }).catch(() => null);
    if (r && (r.status === 404 || r.status === 403)) return fail(404, 'not_found');
    const d = r && r.ok ? await r.json().catch(() => ({})) : {};
    if (d.mimeType && d.mimeType !== FOLDER) return fail(400, 'not_folder');
  }
  return out({ ok: true, items, more: !!page }, 200, 'private, max-age=120');
}
