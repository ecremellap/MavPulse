/*
 * MavPulse shuttle relay (Cloudflare Worker, free tier)
 * -----------------------------------------------------
 * UTA's MavMover tracker (TripShot) publishes live bus positions on public,
 * no-login "rider" endpoints, but does not allow other websites to read
 * them from a browser (no CORS). This tiny relay fetches ONLY those two
 * public endpoints and adds the CORS header so MavPulse can show the buses.
 *   - It refuses every other path.
 *   - It only answers MavPulse's own site.
 *   - It caches each answer for 10 seconds, so many users = few requests.
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> "Hello World"
 * worker -> Edit code -> paste this file -> Deploy. Put the worker URL in
 * firebase-config.js as MAVPULSE_SHUTTLE_RELAY.
 */
const ALLOW_ORIGINS = ["https://ecremellap.github.io", "http://localhost:8000", "http://localhost:8765"];
const ALLOWED_PATHS = [/^\/v1\/p\/shared\/route$/, /^\/v3\/p\/shared\/route\/[0-9A-Fa-f-]{36}$/];

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "";
        const cors = {
            "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Vary": "Origin"
        };
        if (request.method === "OPTIONS") return new Response(null, { headers: cors });
        if (request.method !== "GET" || !ALLOWED_PATHS.some(re => re.test(url.pathname))) {
            return new Response("Not allowed", { status: 403, headers: cors });
        }
        const upstream = "https://uta.tripshot.com" + url.pathname + url.search;
        const cache = caches.default;
        const key = new Request(upstream);
        let res = await cache.match(key);
        if (!res) {
            const r = await fetch(upstream, { headers: { "Accept": "application/json", "User-Agent": "MavPulse relay (UTA CSE 3311 student project)" } });
            res = new Response(r.body, r);
            res.headers.set("Cache-Control", "max-age=10");
            if (r.ok) ctx.waitUntil(cache.put(key, res.clone()));
        }
        const out = new Response(res.body, res);
        Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
        return out;
    }
};
