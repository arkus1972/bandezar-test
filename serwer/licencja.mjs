/* Bandezar – KOD LICENCJI (opis: dokumentacja/INSTALACJA-ZESPOLU.md).
   Kod: BZ1-<dane>.<podpis>, dane = JSON {v:1, n: dla kogo, i: numer, d: data} (base64url), podpis Ed25519.
   Tutaj jest tylko klucz PUBLICZNY (sprawdza podpis). Wpisuje go tu akcja „Klucze licencji” (.github/workflows/licencja-klucze.yml),
   która tworzy parę kluczy; prywatny (tworzy kody) ma wyłącznie Arek jako sekret LICENCJA_KLUCZ w repo na GitHubie.
   Pusty klucz = żaden kod licencji nie przechodzi. Do testów: zmienna LICENCJA_PUBLICZNY (wrangler dev --var). */
export const LICENCJA_PUBLICZNY = 'D3PhyVBcpJZS0T0QLtOqfeQhijk2oCwh5-qJCUi8axE';

function unb64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const r = atob(s), a = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }

/* zwraca dane licencji albo null (zły kod, zły podpis) */
export async function sprawdzLicencje(kod, publiczny) {
  const m = /^BZ1-([A-Za-z0-9_-]{10,400})\.([A-Za-z0-9_-]{80,90})$/.exec(String(kod || '').replace(/\s+/g, ''));
  if (!m) return null;
  try {
    const key = await crypto.subtle.importKey('raw', unb64url(publiczny || LICENCJA_PUBLICZNY), { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64url(m[2]), new TextEncoder().encode(m[1])))) return null;
    const d = JSON.parse(new TextDecoder().decode(unb64url(m[1])));
    if (!d || d.v !== 1 || typeof d.n !== 'string' || typeof d.i !== 'string') return null;
    return { n: d.n.slice(0, 120), i: d.i.slice(0, 40), d: String(d.d || '').slice(0, 10) };
  } catch (_) { return null; }
}
