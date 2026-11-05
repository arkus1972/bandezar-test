/* Bandezar – ZMIANY NA ŻYWO na Cloudflare: jeden „pokój” (Durable Object) na zespół. Opis: dokumentacja/CLOUDFLARE-BAZA.md.
   Do gniazda wpuszcza tylko serwer/baza.mjs (podpisany bilet + sprawdzenie członkostwa), tutaj przychodzi już id konta (x-bz-user).
   Pokój rozsyła wyłącznie SYGNAŁY, nigdy danych zespołu:
     {"t":"zmiana"}   ktoś zapisał rekordy → aplikacja sama pobiera je zwykłym zapytaniem (z filtrami),
     {"t":"msg"}      przyszła wiadomość → aplikacja pobiera listę wiadomości,
     {"t":"obecni","l":[{"k":"…","m":"id osoby ze składu"}]}   kto ma teraz otwartego Bandezara.
   Od aplikacji przyjmuje tylko {"t":"jestem","m":"id osoby ze składu"} (sam identyfikator, bez imienia i maila).
   Gniazda „śpią” między wiadomościami (Hibernation API), więc pokój nic nie kosztuje, gdy nikt nic nie robi. */
import { DurableObject } from 'cloudflare:workers';

const RID = /^[A-Za-z0-9_:.-]{1,64}$/;

export class Zespol extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /* „ping” od aplikacji co 25 s: odpowiada Cloudflare, bez budzenia pokoju */
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const uid = request.headers.get('x-bz-user') || '';
      if (!uid || (request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('bad', { status: 400 });
      if (this.ctx.getWebSockets().length >= 200) return new Response('full', { status: 429 });
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [uid]);
      server.serializeAttachment({ u: uid, k: crypto.randomUUID().slice(0, 12), m: '' });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/zmiana') { this.send('{"t":"zmiana"}'); return new Response('ok'); }
    if (url.pathname === '/wiadomosc') { this.send('{"t":"msg"}'); return new Response('ok'); }
    return new Response('not found', { status: 404 });
  }
  send(text, skip) { for (const ws of this.ctx.getWebSockets()) { if (ws === skip) continue; try { ws.send(text); } catch (_) { /* zamknięte */ } } }
  present(skip) {
    const l = [];
    for (const ws of this.ctx.getWebSockets()) { if (ws === skip) continue; const a = ws.deserializeAttachment() || {}; if (a.m) l.push({ k: a.k, m: a.m }); }
    this.send(JSON.stringify({ t: 'obecni', l }), skip);
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 500) return;
    let d; try { d = JSON.parse(msg); } catch (_) { return; }
    if (!d || d.t !== 'jestem') return;
    const m = typeof d.m === 'string' && RID.test(d.m) ? d.m : '', a = ws.deserializeAttachment() || {};
    a.m = m; ws.serializeAttachment(a);
    this.present();
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (_) { /* już zamknięte */ } this.present(ws); }
  async webSocketError(ws) { this.present(ws); }
}
