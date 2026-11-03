/*
 * MavPulse test suite
 * -------------------
 * Dependency-free. Runs two ways:
 *   1. Node:    node tests.js
 *   2. Browser: open tests.html
 * Tests target the pure rules in logic.js, the reference data in data.js,
 * and the on-device ReportStore in store.js (with a fake storage), so every
 * requirement below can be checked without a network, a phone, or a train.
 */
(function () {
    "use strict";
    const inNode = typeof window === "undefined";
    const MP = inNode ? require("./logic.js") : window.MP;
    const D = inNode ? require("./data.js") : window.MP_DATA;
    const STORE = inNode ? require("./store.js") : window.MP_STORE;

    const results = [];
    const pending = [];
    function test(name, fn) {
        try {
            const out = fn();
            if (out && typeof out.then === "function") {
                pending.push(out.then(() => results.push({ name, passed: true }), e => results.push({ name, passed: false, message: e.message })));
            } else results.push({ name, passed: true });
        } catch (e) { results.push({ name, passed: false, message: e.message }); }
    }
    function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }
    function eq(a, b, m) { if (a !== b) throw new Error(`${m || "Values differ"} (expected ${b}, got ${a})`); }

    const T0 = new Date("2026-11-03T08:00:00-06:00").getTime(); // Tue 8:00 AM CT
    const min = m => T0 + m * 60 * 1000;
    const block = (id, who, m) => ({ type: "crossing", targetId: id, status: "blocked", reporterId: who, at: min(m) });
    const clear = (id, who, m) => ({ type: "crossing", targetId: id, status: "clear", reporterId: who, at: min(m) });

    // ===================== UC-01 crossing confirmation =====================
    test("UC-01: two distinct reporters within 5 min confirm", () => {
        eq(MP.shouldConfirmCrossingAlert({ crossingId: "cooper", reporterId: "a", timestamp: min(0) }, { crossingId: "cooper", reporterId: "b", timestamp: min(3) }), true);
    });
    test("UC-01: same reporter twice does not confirm", () => {
        eq(MP.shouldConfirmCrossingAlert({ crossingId: "cooper", reporterId: "a", timestamp: min(0) }, { crossingId: "cooper", reporterId: "a", timestamp: min(1) }), false);
    });
    test("UC-01: reports more than 5 min apart do not confirm", () => {
        eq(MP.shouldConfirmCrossingAlert({ crossingId: "cooper", reporterId: "a", timestamp: min(0) }, { crossingId: "cooper", reporterId: "b", timestamp: min(6) }), false);
    });
    test("UC-01: reports for different crossings do not confirm", () => {
        eq(MP.shouldConfirmCrossingAlert({ crossingId: "cooper", reporterId: "a", timestamp: min(0) }, { crossingId: "davis", reporterId: "b", timestamp: min(1) }), false);
    });
    test("UC-01: missing reports are handled safely", () => {
        eq(MP.shouldConfirmCrossingAlert(null, undefined), false);
    });

    // ===================== crossing live state =====================
    test("Crossing with no reports is clear", () => {
        eq(MP.crossingState([], "cooper", min(0)).state, "clear");
    });
    test("One block report shows as 'reported' (unconfirmed)", () => {
        const s = MP.crossingState([block("cooper", "a", 0)], "cooper", min(1));
        eq(s.state, "reported"); eq(s.reporters, 1);
    });
    test("Two people within 5 min make it 'confirmed'", () => {
        eq(MP.crossingState([block("cooper", "a", 0), block("cooper", "b", 2)], "cooper", min(3)).state, "confirmed");
    });
    test("A 'clear' report after the block clears the crossing", () => {
        eq(MP.crossingState([block("cooper", "a", 0), block("cooper", "b", 1), clear("cooper", "c", 4)], "cooper", min(5)).state, "clear");
    });
    test("A block reported after a clear counts again", () => {
        eq(MP.crossingState([clear("cooper", "c", 0), block("cooper", "a", 2)], "cooper", min(3)).state, "reported");
    });
    test("Block reports expire after 20 minutes", () => {
        eq(MP.crossingState([block("cooper", "a", 0), block("cooper", "b", 1)], "cooper", min(22)).state, "clear");
    });
    test("Reports on another crossing don't affect this one", () => {
        eq(MP.crossingState([block("davis", "a", 0), block("davis", "b", 1)], "cooper", min(2)).state, "clear");
    });
    test("Requirement: alert state is ready the moment the 2nd report arrives (well under 30 s)", () => {
        const t = Date.now();
        const reports = [{ ...block("cooper", "a", 0), at: t - 1000 }, { ...block("cooper", "b", 0), at: t }];
        const start = (typeof performance !== "undefined" ? performance : Date).now();
        const s = MP.crossingState(reports, "cooper", t);
        const ms = (typeof performance !== "undefined" ? performance : Date).now() - start;
        eq(s.state, "confirmed"); assert(ms < 30000, "took too long");
    });

    // ===================== closures =====================
    const place = D.PLACES[0];
    test("Closure from the picker creates a valid report (no typing)", () => {
        const r = MP.createClosureReport(place, "road-closed", "u1", T0);
        assert(r, "should create"); eq(r.type, "closure"); eq(r.label, place.name); eq(r.lat, place.lat);
    });
    test("Closure without a kind is rejected", () => { eq(MP.createClosureReport(place, null, "u1", T0), null); });
    test("Closure without a location is rejected", () => { eq(MP.createClosureReport(null, "flooding", "u1", T0), null); });
    test("Duplicate closure reports merge and count reporters", () => {
        const a = MP.createClosureReport(place, "flooding", "u1", min(0));
        const b = MP.createClosureReport(place, "flooding", "u2", min(5));
        const list = MP.activeClosures([a, b], min(6));
        eq(list.length, 1); eq(list[0].reporterCount, 2);
    });
    test("Closures older than 12 hours drop off", () => {
        const a = MP.createClosureReport(place, "flooding", "u1", min(0));
        eq(MP.activeClosures([a], min(13 * 60)).length, 0);
    });

    // ===================== anti-spam =====================
    test("Same person can't re-report the same target within 2 min", () => {
        eq(MP.canReport([block("cooper", "a", 0)], "a", "crossing", "cooper", min(1)), false);
    });
    test("...but can after the cooldown, and others can anytime", () => {
        eq(MP.canReport([block("cooper", "a", 0)], "a", "crossing", "cooper", min(3)), true);
        eq(MP.canReport([block("cooper", "a", 0)], "b", "crossing", "cooper", min(0)), true);
    });

    // ===================== study spots =====================
    test("Study spot with no report shows no status (nothing invented)", () => { eq(MP.studyStatus(null, T0).source, "none"); });
    test("A fresh 'busy' report is shown as live", () => {
        const s = MP.studyStatus({ status: "busy", at: T0 }, min(10));
        eq(s.source, "live"); eq(s.status, "busy");
    });
    test("A study report older than 60 min is dropped", () => { eq(MP.studyStatus({ status: "busy", at: T0 }, min(61)).source, "none"); });
    test("Study spots carry no made-up occupancy or amenity fields", () => {
        D.STUDY_SPOTS.forEach(s => assert(!("busyness" in s) && !("detail" in s), s.name));
    });

    // ===================== parking =====================
    test("Latest lot report wins within 90 min", () => {
        const r = [{ type: "lot", targetId: "lot-49", status: "spaces", at: min(0), reporterId: "a" }, { type: "lot", targetId: "lot-49", status: "full", at: min(10), reporterId: "b" }];
        eq(MP.latestStatus(r, "lot", "lot-49", min(20), MP.RULES.LOT_TTL_MS).status, "full");
    });
    test("Lot reports expire after 90 min", () => {
        const r = [{ type: "lot", targetId: "lot-49", status: "full", at: min(0), reporterId: "a" }];
        eq(MP.latestStatus(r, "lot", "lot-49", min(91), MP.RULES.LOT_TTL_MS), null);
    });

    // ===================== MavMover schedule =====================
    const orange = D.ROUTES.find(r => r.id === "orange");
    test("Orange route runs at 8 AM on a Tuesday", () => { eq(MP.routeStatus(orange, new Date(2026, 10, 3, 8, 0)).running, true); });
    test("Orange route is not running at 7 AM", () => { eq(MP.routeStatus(orange, new Date(2026, 10, 3, 7, 0)).running, false); });
    test("Orange route is done after 6 PM", () => { eq(MP.routeStatus(orange, new Date(2026, 10, 3, 18, 30)).label, "Done for today"); });
    test("No MavMover service on Saturday", () => { eq(MP.routeStatus(orange, new Date(2026, 10, 7, 12, 0)).running, false); });

    // ===================== NWS alerts =====================
    const feats = [
        { properties: { event: "Heat Advisory", areaDesc: "Tarrant County", severity: "Minor" } },
        { properties: { event: "Tornado Warning", areaDesc: "Dallas County", severity: "Extreme" } },
        { properties: { event: "Flood Watch", areaDesc: "City of Arlington, Tarrant", severity: "Moderate" } }
    ];
    test("Only Tarrant/Arlington alerts are kept", () => { eq(MP.filterCampusAlerts(feats, ["tarrant", "arlington"]).length, 2); });
    test("Alerts sort most severe first", () => { eq(MP.filterCampusAlerts(feats, ["tarrant"])[0].severity, "Moderate"); });
    test("Empty NWS feed is safe", () => { eq(MP.filterCampusAlerts(undefined, ["tarrant"]).length, 0); });

    // ===================== notifications (conflicting viewpoints) =====================
    test("Commuter mode: confirmed crossing notifies", () => { eq(MP.shouldNotify("commuter", { type: "crossing", state: "confirmed" }), true); });
    test("Commuter mode: one unconfirmed tap never notifies", () => { eq(MP.shouldNotify("commuter", { type: "crossing", state: "reported" }), false); });
    test("Quiet mode: crossings and closures stay silent", () => {
        eq(MP.shouldNotify("quiet", { type: "crossing", state: "confirmed" }), false);
        eq(MP.shouldNotify("quiet", { type: "closure" }), false);
    });
    test("Quiet mode: a Severe weather warning still gets through", () => { eq(MP.shouldNotify("quiet", { type: "weather", severity: "Severe" }), true); });
    test("Off means off, even for Extreme weather", () => { eq(MP.shouldNotify("off", { type: "weather", severity: "Extreme" }), false); });

    // ===================== contributor points =====================
    test("10 points per report, +5 when another commuter backs it up", () => {
        const s = MP.contributorStats([block("cooper", "me", 0), block("cooper", "x", 2), { type: "study", targetId: "seir", status: "busy", reporterId: "me", at: min(30) }], "me");
        eq(s.reports, 2); eq(s.confirmed, 1); eq(s.points, 25);
    });
    test("Levels: 0 pts is Newcomer, 50 pts is Regular", () => {
        eq(MP.contributorStats([], "me").level, "Newcomer");
        const five = [0, 10, 20, 30, 40].map(m => ({ type: "study", targetId: "s" + m, status: "busy", reporterId: "me", at: min(m) }));
        eq(MP.contributorStats(five, "me").level, "Regular");
    });

    // ===================== morning brief =====================
    test("Brief is 'bad' when a crossing is blocked", () => {
        const b = MP.buildBrief({ weather: { temp: 60, condition: "Clear", rainChance: 0 }, alerts: [], crossings: [{ name: "Cooper St", state: "confirmed", lastAt: min(0) }], closures: [], routesRunning: 5, now: min(2) });
        eq(b.level, "bad"); assert(b.lines.some(l => l.text.includes("Cooper St")));
    });
    test("Brief is 'good' when nothing is happening", () => {
        eq(MP.buildBrief({ weather: null, alerts: [], crossings: [{ name: "Cooper St", state: "clear" }], closures: [], routesRunning: 0, now: T0 }).level, "good");
    });

    // ===================== location helpers =====================
    test("Nearest crossing to a point on Cooper St is Cooper St", () => {
        eq(MP.nearest({ lat: 32.7370, lng: -97.1144 }, D.CROSSINGS).item.id, "cooper");
    });
    test("Distance between two crossings is realistic (Cooper→Center ≈ 0.7 km)", () => {
        const a = D.CROSSINGS.find(c => c.id === "cooper"), b = D.CROSSINGS.find(c => c.id === "center");
        const d = MP.distanceMeters(a, b); assert(d > 600 && d < 800, `got ${d}`);
    });

    // ===================== reference data sanity =====================
    test("All map coordinates are in the Arlington area", () => {
        const pts = [...D.CROSSINGS, ...D.PARKING, ...D.STUDY_SPOTS, ...D.PLACES, ...D.ROUTES.flatMap(r => r.stops)];
        pts.forEach(p => assert(p.lat > 32.70 && p.lat < 32.76 && p.lng > -97.16 && p.lng < -97.08, `${p.name} out of range`));
    });
    test("Every rail crossing lies on the UP line (lat 32.733–32.739), none on Mitchell St", () => {
        D.CROSSINGS.forEach(c => assert(c.lat > 32.733 && c.lat < 32.739, c.name));
        assert(!D.CROSSINGS.some(c => /mitchell/i.test(c.name)), "Mitchell St has no rail crossing");
    });


    // ===================== official city data =====================
    const DAY = 24 * 3600 * 1000;
    const permit = (o) => ({ attributes: { Permit: "P1", Status: "Issued", Sub: "Traffic Control Plan - Only", ScopeOfWork: "Lane closure", BarricadeInstall: T0 - DAY, BarricadeRemove: T0 + DAY, Segment: "1501 S COOPER ST", ...o }, geometry: { paths: [[[-97.114, 32.72], [-97.114, 32.721]]] } });
    test("City road work: issued permit with barricades up now is active", () => { eq(MP.activeRoadWork([permit({})], T0).length, 1); });
    test("City road work: barricades removed in the past -> not shown", () => { eq(MP.activeRoadWork([permit({ BarricadeRemove: T0 - 1 })], T0).length, 0); });
    test("City road work: barricades not installed yet -> not shown", () => { eq(MP.activeRoadWork([permit({ BarricadeInstall: T0 + DAY })], T0).length, 0); });
    test("City road work: permits 'In Review' are ignored", () => { eq(MP.activeRoadWork([permit({ Status: "In Review" })], T0).length, 0); });
    test("City road work: segments of one permit are grouped", () => {
        const w = MP.activeRoadWork([permit({}), permit({ Segment: "600 W PARK ROW DR" })], T0);
        eq(w.length, 1); eq(w[0].segments.length, 2); eq(w[0].paths.length, 2);
    });
    const crime = (desc, daysAgo, extra) => ({ attributes: { Description: desc, DateOfOccurrence: T0 - daysAgo * DAY, Juvenile: "No", ...extra }, geometry: { x: -97.11, y: 32.73 } });
    test("Crime categories map city codes to plain words", () => {
        eq(MP.crimeCategory("THEFT FROM MOTOR VEHICLE ARTICLES"), "Car break-in");
        eq(MP.crimeCategory("ASSAULT; SIMPLE ASSAULT"), "Assault");
        eq(MP.crimeCategory("MOTOR VEHICLE THEFT"), "Vehicle theft");
    });
    test("Crime summary only counts the requested window", () => { eq(MP.summarizeCrime([crime("ROBBERY", 2), crime("ROBBERY", 40)], T0, 30).total, 1); });
    test("Sex offenses are counted but never pinned on the map", () => {
        const s = MP.summarizeCrime([crime("SEX OFFENSE - FONDLING", 1), crime("ROBBERY", 1)], T0, 30);
        eq(s.total, 2); eq(s.mappable.length, 1); eq(s.mappable[0].category, "Robbery");
    });
    test("Juvenile cases are never pinned on the map", () => { eq(MP.summarizeCrime([crime("THEFT SHOPLIFTING", 1, { Juvenile: "Yes" })], T0, 30).mappable.length, 0); });

    // ===================== GPS hazard warnings =====================
    test("GPS: hazards within 1 km are returned nearest first", () => {
        const me = { lat: 32.7360, lng: -97.1144 };
        const h = MP.nearbyHazards(me, [{ lat: 32.73754, lng: -97.11444, label: "Cooper" }, { lat: 32.73408, lng: -97.14915, label: "Bowen" }], 1000);
        eq(h.length, 1); eq(h[0].label, "Cooper"); assert(h[0].meters < 300);
    });
    test("GPS: no position means no warnings", () => { eq(MP.nearbyHazards(null, [{ lat: 1, lng: 1 }], 1000).length, 0); });
    test("Brief: a relayed UTA MavAlert puts the brief in alert state", () => {
        const b = MP.buildBrief({ alerts: [], crossings: [], closures: [], mavAlerts: [{ title: "Campus closed" }], now: T0 });
        eq(b.level, "bad"); eq(b.lines[0].text, "UTA MavAlert: Campus closed");
    });

    // ===================== ReportStore (on-device) =====================
    function fakeStorage() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; }
    test("LocalReportStore: add then read back through onReports", async () => {
        const s = new STORE.LocalReportStore(fakeStorage());
        await s.init();
        let seen = [];
        s.onReports(list => { seen = list; });
        await s.addReport({ type: "crossing", targetId: "cooper", status: "blocked", reporterId: s.uid, at: Date.now() });
        eq(seen.length, 1); eq(seen[0].targetId, "cooper");
    });
    test("LocalReportStore: remove deletes the report", async () => {
        const s = new STORE.LocalReportStore(fakeStorage());
        await s.init();
        let seen = [];
        s.onReports(list => { seen = list; });
        await s.addReport({ type: "study", targetId: "seir", status: "busy", reporterId: s.uid, at: Date.now() });
        await s.removeReport(seen[0].id);
        eq(seen.length, 0);
    });
    test("LocalReportStore: refuses admin actions without the shared backend", async () => {
        const s = new STORE.LocalReportStore(fakeStorage());
        await s.init();
        let threw = false;
        try { await s.postUpdate({ title: "x", body: "y" }); } catch (e) { threw = true; }
        eq(threw, true);
    });

    // ===================== report =====================
    Promise.all(pending).then(() => {
        const passed = results.filter(r => r.passed).length;
        const total = results.length;
        if (!inNode && document.getElementById("test-output")) {
            document.getElementById("test-output").innerHTML = results.map(r =>
                `<li class="${r.passed ? "pass" : "fail"}">${r.passed ? "✓" : "✗"} ${r.name}${r.passed ? "" : " — " + r.message}</li>`).join("");
            document.getElementById("test-summary").textContent = `${passed} / ${total} tests passed`;
        } else {
            console.log(results.map(r => `${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : "  -> " + r.message}`).join("\n"));
            console.log(`\n${passed} / ${total} tests passed`);
            if (inNode) process.exitCode = passed === total ? 0 : 1;
        }
    });
})();
