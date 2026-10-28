// Some mobile networks, such as a French SIM roaming in Egypt, often cannot reach Railway's address
// while they reach Cloudflare easily. This address on Cloudflare passes every request, websockets
// included, straight on to the same server on Railway, so it is the same app at another address.
const SERVER = 'https://nurturing-dedication-production-9379.up.railway.app';

export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, SERVER);
  const headers = new Headers(request.headers);
  // The server only accepts requests from pages at its own address; this page is that address.
  if (headers.get('Origin') === incoming.origin) headers.set('Origin', SERVER);
  headers.set('X-Forwarded-Host', incoming.host);
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });
  // A redirect to the server's own address is sent back to this one, so people stay on Cloudflare.
  const location = response.headers.get('Location');
  if (!location?.startsWith(SERVER) || response.webSocket) return response;
  const redirected = new Response(response.body, response);
  redirected.headers.set('Location', incoming.origin + location.slice(SERVER.length));
  return redirected;
}
