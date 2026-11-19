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
 * Deploy: Cloudflare dashboard -> Workers & Pages -> the existing relay
 * -> Edit code -> paste this file -> Deploy.
 * Closed-app alerts also need, on that same worker:
 *   - A KV namespace bound as PUSH_KV
 *   - Secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK, VAPID_SUBJECT
 *     (the private key is not in this repo)
 *   - A cron trigger, every 5 minutes
 * The public key that matches those secrets is MAVPULSE_VAPID_PUBLIC in
 * firebase-config.js.
 */
const ALLOW_ORIGINS = ["https://ecremellap.github.io", "http://localhost:8000", "http://localhost:8765"];
const ALLOWED_PATHS = [/^\/v1\/p\/shared\/route$/, /^\/v3\/p\/shared\/route\/[0-9A-Fa-f-]{36}$/];

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "";
        const cors = {
            "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin"
        };
        if (request.method === "OPTIONS") return new Response(null, { headers: cors });
        if (request.method === "GET" && url.pathname === "/library/occupancy") {
            return libraryOccupancy(ctx, cors);
        }
        if (url.pathname === "/push/subscribe" && request.method === "POST") return pushSubscribe(request, env, cors);
        if (url.pathname === "/push/unsubscribe" && request.method === "POST") return pushUnsubscribe(request, env, cors);
        if (url.pathname === "/push/check" && request.method === "POST") {
            ctx.waitUntil(runPushCheck(env));
            return json({ ok: true }, cors);
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
    },
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runPushCheck(env));
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

const CROSSING_NAMES = {
    bowen: "Bowen Rd", davis: "Davis Dr", cooper: "Cooper St",
    center: "Center St", mesquite: "Mesquite St", collins: "Collins St"
};
const PUSH_HOST = /(^|\.)fcm\.googleapis\.com$|(^|\.)push\.services\.mozilla\.com$|(^|\.)push\.apple\.com$|(^|\.)notify\.windows\.com$|(^|\.)windows\.com$/;
const FIREBASE_KEY = "AIzaSyAXRL6ZKUbTqYrXMKKtZE8TbnuAED7tK3I";

function json(obj, cors, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({ "Content-Type": "application/json" }, cors || {})
    });
}
function b64urlToBytes(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
function bytesToB64url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    parts.forEach(p => { out.set(p, o); o += p.length; });
    return out;
}
async function hkdfBits(ikm, salt, info, bits) {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}
// aes128gcm body a push service can decrypt (RFC 8291).
export async function encryptForPush(payloadText, p256dh, authSecret) {
    const userPublic = b64urlToBytes(p256dh);
    const auth = b64urlToBytes(authSecret);
    const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
    const remote = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, local.privateKey, 256));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const info = concatBytes([new TextEncoder().encode("WebPush: info\0"), userPublic, localPublic]);
    const ikm = await hkdfBits(shared, auth, info, 256);
    const cek = await hkdfBits(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 128);
    const nonce = await hkdfBits(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 96);
    const plain = concatBytes([new TextEncoder().encode(payloadText), new Uint8Array([2])]);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
    const header = new Uint8Array(21 + localPublic.length);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, 4096);
    header[20] = localPublic.length;
    header.set(localPublic, 21);
    return concatBytes([header, cipher]);
}
async function vapidJwt(endpoint, env) {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const body = bytesToB64url(new TextEncoder().encode(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT || "https://ecremellap.github.io/MavPulse/"
    })));
    const data = `${header}.${body}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(data)));
    return `${data}.${bytesToB64url(sig)}`;
}
async function sendOnePush(sub, payload, env) {
    const body = await encryptForPush(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
    const jwt = await vapidJwt(sub.endpoint, env);
    const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
            TTL: "3600",
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
        },
        body
    });
    return res.status;
}
function validSubscription(body) {
    if (!body || typeof body.endpoint !== "string" || !body.keys) return false;
    if (body.mode !== "commuter" && body.mode !== "quiet") return false;
    if (typeof body.keys.p256dh !== "string" || typeof body.keys.auth !== "string") return false;
    try {
        const u = new URL(body.endpoint);
        return u.protocol === "https:" && PUSH_HOST.test(u.hostname);
    } catch (e) { return false; }
}
async function subKey(endpoint) {
    const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
    return "sub:" + bytesToB64url(dig).slice(0, 32);
}
async function pushSubscribe(request, env, cors) {
    if (!env.PUSH_KV) return json({ error: "Push storage is not connected yet." }, cors, 503);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad subscription." }, cors, 400); }
    if (!validSubscription(body)) return json({ error: "That push service is not accepted." }, cors, 400);
    await env.PUSH_KV.put(await subKey(body.endpoint), JSON.stringify({
        endpoint: body.endpoint, keys: body.keys, mode: body.mode, at: Date.now()
    }));
    return json({ ok: true }, cors);
}
async function pushUnsubscribe(request, env, cors) {
    if (!env.PUSH_KV) return json({ ok: true }, cors);
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    if (body.endpoint) await env.PUSH_KV.delete(await subKey(body.endpoint));
    return json({ ok: true }, cors);
}
function field(f) {
    if (!f) return null;
    if (f.stringValue != null) return f.stringValue;
    if (f.integerValue != null) return Number(f.integerValue);
    if (f.doubleValue != null) return Number(f.doubleValue);
    if (f.booleanValue != null) return f.booleanValue;
    return null;
}
function confirmedIds(reports, now) {
    const ids = [];
    reports.forEach(r => { if (r.type === "crossing" && ids.indexOf(r.targetId) === -1) ids.push(r.targetId); });
    const hits = [];
    ids.forEach(id => {
        const mine = reports.filter(r => r.type === "crossing" && r.targetId === id).sort((a, b) => a.at - b.at);
        const lastClear = mine.filter(r => r.status === "clear").pop();
        const blocks = mine.filter(r => r.status === "blocked" && (!lastClear || r.at > lastClear.at) && now - r.at <= 20 * 60 * 1000);
        let confirmed = false, since = null;
        for (let i = 0; i < blocks.length && !confirmed; i++) {
            for (let j = i + 1; j < blocks.length; j++) {
                if (blocks[i].reporterId !== blocks[j].reporterId && Math.abs(blocks[i].at - blocks[j].at) <= 5 * 60 * 1000) {
                    confirmed = true; since = blocks[0].at; break;
                }
            }
        }
        if (confirmed) hits.push({ id, since, name: CROSSING_NAMES[id] || id });
    });
    return hits;
}
async function loadReports() {
    const out = [];
    let token = "";
    for (let page = 0; page < 4; page++) {
        const url = "https://firestore.googleapis.com/v1/projects/mavpulse-2d2fc/databases/(default)/documents/reports?pageSize=200&key="
            + FIREBASE_KEY + (token ? "&pageToken=" + encodeURIComponent(token) : "");
        const res = await fetch(url);
        if (!res.ok) break;
        const data = await res.json();
        (data.documents || []).forEach(doc => {
            const f = doc.fields || {};
            out.push({
                type: field(f.type), targetId: field(f.targetId), status: field(f.status),
                kind: field(f.kind), label: field(f.label), reporterId: field(f.reporterId), at: field(f.at)
            });
        });
        token = data.nextPageToken || "";
        if (!token) break;
    }
    return out;
}
async function loadSevereWeather() {
    const res = await fetch("https://api.weather.gov/alerts/active?area=TX", {
        headers: { Accept: "application/geo+json", "User-Agent": "MavPulse (UTA CSE 3311 student project)" }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map(f => f.properties || {}).filter(p => {
        const area = (p.areaDesc || "").toLowerCase();
        return (area.includes("tarrant") || area.includes("arlington")) && (p.severity === "Severe" || p.severity === "Extreme");
    }).map(p => ({ id: p.id, event: p.event, severity: p.severity }));
}
function eventsFrom(reports, alerts, now) {
    const events = [];
    confirmedIds(reports, now).forEach(c => events.push({
        key: `x-${c.id}-${c.since}`, modes: ["commuter"],
        title: `Train blocking ${c.name}`, body: "Confirmed by two commuters.", url: `./?detour=${c.id}`
    }));
    const seen = {};
    reports.filter(r => r.type === "closure" && r.status === "active" && now - r.at < 12 * 60 * 60 * 1000).forEach(c => {
        const key = `c-${c.targetId}-${c.kind}-${Math.floor(c.at / (30 * 60 * 1000))}`;
        if (seen[key]) return;
        seen[key] = true;
        events.push({ key, modes: ["commuter"], title: `Closure: ${c.label || "campus"}`, body: "Reported by a commuter on MavPulse.", url: "./" });
    });
    alerts.forEach(a => events.push({
        key: "wx-" + (a.id || a.event), modes: ["commuter", "quiet"],
        title: a.event || "Severe weather", body: "National Weather Service alert near campus.", url: "./"
    }));
    return events;
}
async function listSubs(kv) {
    const subs = [];
    let cursor;
    do {
        const page = await kv.list({ prefix: "sub:", cursor });
        const rows = await Promise.all(page.keys.map(k => kv.get(k.name, "json")));
        rows.forEach(row => { if (row && row.endpoint) subs.push(row); });
        cursor = page.list_complete ? "" : page.cursor;
    } while (cursor);
    return subs;
}
async function runPushCheck(env) {
    if (!env.PUSH_KV || !env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return;
    const lock = await env.PUSH_KV.get("push-lock");
    if (lock) return;
    await env.PUSH_KV.put("push-lock", "1", { expirationTtl: 45 });
    try {
        const now = Date.now();
        const [reports, alerts] = await Promise.all([loadReports(), loadSevereWeather().catch(() => [])]);
        const events = eventsFrom(reports, alerts, now);
        const subs = await listSubs(env.PUSH_KV);
        for (const event of events) {
            if (await env.PUSH_KV.get("sent:" + event.key)) continue;
            const targets = subs.filter(s => event.modes.indexOf(s.mode) !== -1);
            await Promise.all(targets.map(async s => {
                try {
                    const status = await sendOnePush(s, { title: event.title, body: event.body, url: event.url, tag: event.key }, env);
                    if (status === 404 || status === 410) await env.PUSH_KV.delete(await subKey(s.endpoint));
                } catch (e) { /* one bad phone should not stop the rest */ }
            }));
            await env.PUSH_KV.put("sent:" + event.key, "1", { expirationTtl: 6 * 60 * 60 });
        }
    } finally {
        await env.PUSH_KV.delete("push-lock");
    }
}
