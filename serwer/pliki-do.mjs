/* Bandezar – PLIKI Z MEDIÓW BEZ R2 (instalacja zespołu). Opis: dokumentacja/INSTALACJA-ZESPOLU.md.
   R2 na nowym koncie Cloudflare wymaga podania karty płatniczej, Durable Objects nie. Dlatego w instalacji zespołu
   pliki leżą w bazie SQLite jednego Durable Objectu na zespół („schowek”), pocięte na kawałki po 1 MB
   (pojedyncza wartość w tej bazie może mieć najwyżej 2 MB). Darmowy plan: ok. 5 GB na całe konto.
   Do schowka ma dostęp tylko serwer/baza.mjs (po sprawdzeniu roli); z zewnątrz nie da się go wywołać. */
import { DurableObject } from 'cloudflare:workers';

const PART = 1024 * 1024;
const KEY = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,80}$/;

export class Pliki extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (k TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, parts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS parts (k TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (k, n))`);
  }
  async fetch(request) {
    const url = new URL(request.url), k = url.searchParams.get('k') || '';
    if (!KEY.test(k)) return new Response('bad key', { status: 400 });
    if (request.method === 'PUT') {
      const type = request.headers.get('x-bz-type') || 'application/octet-stream', buf = new Uint8Array(await request.arrayBuffer());
      const n = Math.ceil(buf.byteLength / PART);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM parts WHERE k = ?`, k);
        for (let i = 0; i < n; i++) this.sql.exec(`INSERT INTO parts (k, n, data) VALUES (?, ?, ?)`, k, i, buf.slice(i * PART, (i + 1) * PART).buffer);
        this.sql.exec(`INSERT INTO files (k, type, size, parts) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET type = excluded.type, size = excluded.size, parts = excluded.parts`, k, type, buf.byteLength, n);
      });
      return new Response('ok');
    }
    const f = this.sql.exec(`SELECT type, size, parts FROM files WHERE k = ?`, k).toArray()[0];
    if (request.method === 'DELETE') {
      this.ctx.storage.transactionSync(() => { this.sql.exec(`DELETE FROM parts WHERE k = ?`, k); this.sql.exec(`DELETE FROM files WHERE k = ?`, k); });
      return new Response('ok');
    }
    if (!f) return new Response('not found', { status: 404 });
    if (request.method === 'HEAD') return new Response(null, { headers: { 'x-bz-type': f.type, 'x-bz-size': String(f.size) } });
    const sql = this.sql, parts = f.parts;
    let i = 0;
    const body = new ReadableStream({ pull(c) {
      if (i >= parts) { c.close(); return; }
      const r = sql.exec(`SELECT data FROM parts WHERE k = ? AND n = ?`, k, i++).toArray()[0];
      if (!r) { c.error(new Error('missing part')); return; }
      c.enqueue(new Uint8Array(r.data));
    } });
    return new Response(body, { headers: { 'x-bz-type': f.type, 'content-length': String(f.size) } });
  }
}

/* ten sam kształt co R2 (put/get/head/delete), żeby baza.mjs nie musiała wiedzieć, gdzie leżą pliki */
export function schowek(env) {
  if (env.PLIKI) return env.PLIKI;
  if (!env.SCHOWEK) return null;
  const stub = k => env.SCHOWEK.get(env.SCHOWEK.idFromName('pliki:' + k.split('/')[0]));
  const u = k => 'https://schowek/?k=' + encodeURIComponent(k);
  return {
    async put(k, buf, o) { const r = await stub(k).fetch(u(k), { method: 'PUT', body: buf, headers: { 'x-bz-type': o && o.httpMetadata && o.httpMetadata.contentType || 'application/octet-stream' } }); if (!r.ok) throw new Error('schowek put ' + r.status); },
    async head(k) { const r = await stub(k).fetch(u(k), { method: 'HEAD' }); return r.ok ? { size: +r.headers.get('x-bz-size') } : null; },
    async get(k) { const r = await stub(k).fetch(u(k)); return r.ok ? { body: r.body, httpMetadata: { contentType: r.headers.get('x-bz-type') } } : null; },
    async delete(k) { await stub(k).fetch(u(k), { method: 'DELETE' }); }
  };
}
