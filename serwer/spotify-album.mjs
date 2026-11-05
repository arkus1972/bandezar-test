/* Bandezar – lista utworów płyty ze Spotify (dla przycisku ▶ przy piosence).
   GET /api/spotify-album?id=<22 znaki> (worker.js na Cloudflare)  ->  { id, name, tracks: [{ no, title, id }] }
   Czyta publiczną stronę odtwarzacza open.spotify.com/embed/album/<id> (bez klucza API, bez logowania).
   Bezpieczeństwo: przyjmuje tylko id z 22 liter/cyfr, pyta tylko open.spotify.com, zwraca tylko tytuły (tekst) i id (22 znaki). */
const ID = /^[A-Za-z0-9]{22}$/;
const out = (body, status = 200, cache = 'public, max-age=86400') => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': cache, 'x-content-type-options': 'nosniff' } });

export function parseAlbum(html) {
  const tracks = []; let name = '';
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (m) {
    try {
      const d = JSON.parse(m[1]), e = d?.props?.pageProps?.state?.data?.entity || {};
      name = String(e.name || e.title || '').slice(0, 200);
      (e.trackList || []).forEach((t, i) => { const id = String(t.uri || '').split(':').pop(); if (ID.test(id)) tracks.push({ no: i + 1, title: String(t.title || '').slice(0, 200), id }); });
    } catch (_) { /* inny układ strony: niżej zapasowe szukanie */ }
  }
  if (!tracks.length) {
    const seen = new Set(); let k = 0;
    for (const x of html.matchAll(/spotify:track:([A-Za-z0-9]{22})/g)) if (!seen.has(x[1])) { seen.add(x[1]); tracks.push({ no: ++k, title: '', id: x[1] }); }
  }
  return { name, tracks: tracks.slice(0, 100) };
}

export default async (req) => {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!ID.test(id)) return out({ error: 'Zły identyfikator płyty.' }, 400, 'no-store');
  let r;
  try { r = await fetch('https://open.spotify.com/embed/album/' + id, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'accept-language': 'pl,en;q=0.8' }, redirect: 'follow' }); }
  catch (_) { return out({ error: 'Spotify nie odpowiada.' }, 502, 'no-store'); }
  if (!r.ok) return out({ error: 'Spotify: ' + r.status }, 502, 'no-store');
  const a = parseAlbum((await r.text()).slice(0, 3000000));
  if (!a.tracks.length) return out({ error: 'Nie znalazłem utworów tej płyty.' }, 404, 'max-age=300');
  return out({ id, name: a.name, tracks: a.tracks });
};
