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
 * Since Iteration 4 it also serves /library/occupancy: UTA Libraries' public
 * Central Library headcount (libraries.uta.edu/occupancy), which has the same
 * no-CORS limit. Cached for 60 seconds, so UTA's server sees at most one
 * request a minute no matter how many people use MavPulse.
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
        if (request.method === "GET" && url.pathname === "/library/occupancy") {
            return libraryOccupancy(ctx, cors);
        }
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

// Central Library live headcount. UTA's page adds gauge.php (door counter)
// and bump_read.php (staff correction, usually empty) and shows the sum.
async function libraryOccupancy(ctx, cors) {
    const cache = caches.default;
    const key = new Request("https://mavpulse-relay.cache/library/occupancy");
    let res = await cache.match(key);
    if (!res) {
        const get = path => fetch("https://libraries.uta.edu/occupancy/" + path, {
            headers: { "User-Agent": "MavPulse relay (UTA CSE 3311 student project)" }
        }).then(r => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))));
        let body, status = 200;
        try {
            const [gauge, bump] = await Promise.all([get("gauge.php"), get("bump_read.php").catch(() => "0")]);
            const count = Number(String(gauge).trim()) + (Number(String(bump).trim()) || 0);
            if (!Number.isFinite(count)) throw new Error("Unexpected answer");
            body = JSON.stringify({ count, at: Date.now(), source: "https://libraries.uta.edu/occupancy/" });
        } catch (e) {
            status = 502;
            body = JSON.stringify({ error: "Library counter unavailable" });
        }
        res = new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } });
        if (status === 200) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
}
