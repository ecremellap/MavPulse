/*
 * UTA Libraries data (official, public)
 * -------------------------------------
 *   - Hours: UTA Libraries' LibCal hours feed (the same feed that powers
 *     libraries.uta.edu/hours-locations). LibCal supports JSONP, so it loads
 *     straight from the phone.
 *   - Central Library headcount: UTA Libraries' live occupancy counter
 *     (libraries.uta.edu/occupancy). That page has no CORS header, so it is
 *     read through the MavPulse relay (relay/worker.js), cached 60 s.
 * Parsing and every rule live in logic.js (libraryToday, libraryCrowd).
 */
(function (root) {
    "use strict";
    const HOURS_URL = "https://uta.libcal.com/widget/hours/grid?format=json&weeks=1&systemTime=0";
    const OCCUPANCY_PAGE = "https://libraries.uta.edu/occupancy/";
    // LibCal location ids for the study spots that are libraries.
    const LIBCAL_IDS = { "central-library": 13818, "science-engineering-library": 17028 };
    const lastQuery = {};

    let seq = 0;
    function jsonp(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            const cb = `__mpLib${Date.now()}_${seq++}`;
            const script = document.createElement("script");
            const cleanup = () => { delete root[cb]; script.remove(); clearTimeout(timer); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("Library hours timed out")); }, timeoutMs || 12000);
            root[cb] = data => { cleanup(); resolve(data); };
            script.onerror = () => { cleanup(); reject(new Error("Library hours unreachable")); };
            script.src = `${url}&callback=${cb}`;
            document.head.appendChild(script);
        });
    }

    const Libraries = {
        LIBCAL_IDS, OCCUPANCY_PAGE, HOURS_URL, lastQuery,
        async hours() {
            try {
                const grid = await jsonp(HOURS_URL);
                lastQuery.hours = { url: HOURS_URL, at: Date.now(), rows: (grid.locations || []).length, ok: true };
                return grid;
            } catch (e) {
                lastQuery.hours = { url: HOURS_URL, at: Date.now(), rows: 0, ok: false };
                throw e;
            }
        },
        async centralOccupancy(relay) {
            if (!relay) throw new Error("No relay configured");
            const url = `${relay}/library/occupancy`;
            try {
                const r = await fetch(url, { cache: "no-store" });
                const j = await r.json();
                if (!r.ok || typeof j.count !== "number") throw new Error(j.error || "Library counter unavailable");
                lastQuery.occupancy = { url, at: Date.now(), ok: true };
                return j;
            } catch (e) {
                lastQuery.occupancy = { url, at: Date.now(), rows: 0, ok: false };
                throw e;
            }
        }
    };
    root.MP_LIB = Libraries;
})(window);
