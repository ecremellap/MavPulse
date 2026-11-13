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
    const AREAS = inNode ? require("./parking-areas.js") : window.MP_PARKING_AREAS;
    const DET = inNode ? require("./detours.js") : window.MP_DETOURS;

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


    // ===================== parking (real UTA areas only) =====================
    test("Parking: every highlighted area is a real outline inside the UTA campus area", () => {
        assert(AREAS.length >= 50, `only ${AREAS.length} areas`);
        AREAS.forEach(a => {
            assert(a.poly.length >= 4, `area ${a.id} has no outline`);
            a.poly.forEach(([la, ln]) => assert(la > 32.720 && la < 32.737 && ln > -97.133 && ln < -97.105, `area ${a.id} outside campus`));
        });
    });
    test("Parking: every named garage matches an outline on the map", () => {
        D.PARKING.forEach(g => assert(AREAS.some(a => a.id === g.osm && a.kind === "garage"), `${g.name} has no outline`));
    });
    test("Parking: no lot numbers are guessed onto outlines", () => {
        AREAS.forEach(a => assert(!/\bLot\s*\d/i.test(a.name), `area ${a.id} has a guessed lot number`));
    });
    test("Parking: the four student zones come from the 2026-27 permit guide", () => {
        eq(D.PARKING_ZONES.length, 4);
        assert(D.PARKING_ZONES.find(z => z.id === "south").places.includes("49"), "Lot 49 is in Commuter South");
        assert(D.PARKING_ZONES.find(z => z.id === "west").places.includes("West Campus Garage"), "West Campus Garage is in Commuter West");
    });


    // ===================== long trains & detours =====================
    const withStates = st => D.CROSSINGS.map(c => ({ ...c, state: st[c.id] || "clear", lastAt: T0 }));
    test("Long train: a confirmed block at Cooper marks crossings within 2 km as likely blocked", () => {
        const out = MP.spreadTrain(withStates({ cooper: "confirmed" }));
        const by = Object.fromEntries(out.map(c => [c.id, c.state]));
        eq(by.cooper, "confirmed"); eq(by.davis, "likely"); eq(by.center, "likely"); eq(by.mesquite, "likely"); eq(by.collins, "likely");
    });
    test("Long train: Bowen Rd (3.3 km from Cooper) stays clear", () => {
        eq(MP.spreadTrain(withStates({ cooper: "confirmed" })).find(c => c.id === "bowen").state, "clear");
    });
    test("Long train: 'likely' is never upgraded to confirmed without reports", () => {
        const out = MP.spreadTrain(withStates({ center: "reported" }));
        assert(out.filter(c => c.state === "confirmed").length === 0, "no confirmations from inference");
    });
    test("Long train: likely crossings name the crossing the train was reported at", () => {
        eq(MP.spreadTrain(withStates({ center: "confirmed" })).find(c => c.id === "mesquite").cause, "Center St");
    });
    test("Detours: every crossing has a street route that passes through its underpass/bridge", () => {
        D.CROSSINGS.forEach(c => {
            const d = DET.DETOURS[c.id];
            assert(d && d.path.length > 10, `${c.name} has no detour`);
            const closest = Math.min(...d.path.map(([la, ln]) => MP.distanceMeters({ lat: la, lng: ln }, d.via)));
            assert(closest < 40, `${c.name} detour misses ${d.via.name} by ${Math.round(closest)} m`);
        });
    });
    test("Detours: crossings near campus use the West St underpass; Bowen uses Fielder Rd", () => {
        ["davis", "cooper", "center", "mesquite", "collins"].forEach(id => eq(DET.DETOURS[id].via.name, "West St underpass"));
        eq(DET.DETOURS.bowen.via.name, "Fielder Rd bridge");
    });

    // ===================== live MavMover (TripShot) =====================
    test("Polyline decoding matches TripShot's own coordinates", () => {
        const p = MP.decodePolyline("}nwfEzqxoQ?bA?|@?TAR");
        eq(p[0][0], 32.72959); eq(p[0][1], -97.1243); eq(p.length, 5);
    });
    const tsSample = { InternalRouteDetails: { route: { routeId: "r1", name: "Red Route", shortName: "Red", color: "#FF0000" }, inexactTimetables: [{
        stops: [{ stopId: "S1", name: "Lot 27", location: { lt: 32.72959, lg: -97.1243 } }, { stopId: "S2", name: "Centennial Court", location: { lt: 32.7255, lg: -97.1180 } }],
        navigations: [{ legs: [{ steps: [{ polyline: "}nwfEzqxoQ?bA?|@?TAR" }] }] }],
        liveRides: [{ vehicle: { capacity: 30 }, vehicleStatus: { vehicleId: "v1", name: "Bus 237", location: { lt: 32.726, lg: -97.1225 }, bearing: 322, apcOccupancy: 4, when: new Date(T0 - 20000).toISOString() },
            ride: { stopStatus: [{ Departed: { stopId: "S1" } }, { Awaiting: { stopId: "s2", expectedArrivalTime: new Date(T0 + 3 * 60000).toISOString(), riderStatus: "Delayed" } }] } }]
    }] } };
    test("TripShot: a live bus is parsed with position, riders, next stop and ETA", () => {
        const r = MP.parseTripShotRoute(tsSample, T0);
        eq(r.name, "Red Route"); eq(r.buses.length, 1);
        const b = r.buses[0];
        eq(b.name, "Bus 237"); eq(b.riders, 4); eq(b.capacity, 30); eq(b.nextStop, "Centennial Court"); eq(b.etaMin, 3); eq(b.delayed, true); eq(b.stale, false);
    });
    test("TripShot: route line and stops are parsed for the map", () => {
        const r = MP.parseTripShotRoute(tsSample, T0);
        eq(r.stops.length, 2); assert(r.path.length >= 5, "route line decoded");
    });
    test("TripShot: a bus not heard from in 3+ minutes is marked stale", () => {
        eq(MP.parseTripShotRoute(tsSample, T0 + 5 * 60000).buses[0].stale, true);
    });
    test("TripShot: an unexpected response is handled safely", () => {
        eq(MP.parseTripShotRoute(null, T0), null); eq(MP.parseTripShotRoute({}, T0), null);
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

    // ===================== Weekly leaderboard + UTA sign-in =====================
    const WEEKDAY = 24 * 60 * 60 * 1000;
    const rep = (uid, target, at, status) => ({ type: "crossing", targetId: target, status: status || "blocked", reporterId: uid, at });
    test("Account email: any normal address is accepted", () => {
        eq(MP.isAccountEmail("me@gmail.com"), true);
        eq(MP.isAccountEmail("abc1234@mavs.uta.edu"), true);
        eq(MP.isAccountEmail("  Friend@Example.com "), true);
        eq(MP.isAccountEmail("not-an-email"), false);
        eq(MP.isAccountEmail("me@"), false);
        eq(MP.isAccountEmail(""), false);
        eq(MP.isAccountEmail("a@b"), false);
    });
    test("Profile group: missing uta flag stays on the UTA board; false is other", () => {
        eq(MP.profileIsUta({ name: "Ana" }), true);
        eq(MP.profileIsUta({ name: "Ana", uta: true }), true);
        eq(MP.profileIsUta({ name: "Sam", uta: false }), false);
        eq(MP.profileIsUta(null), false);
    });
    test("UTA email: mavs.uta.edu and uta.edu accepted, others rejected", () => {
        eq(MP.isUtaEmail("abc1234@mavs.uta.edu"), true); eq(MP.isUtaEmail("Prof@UTA.edu"), true);
        eq(MP.isUtaEmail("me@gmail.com"), false); eq(MP.isUtaEmail("me@uta.edu.evil.com"), false);
        eq(MP.isUtaEmail("me@fakeuta.edu"), false); eq(MP.isUtaEmail(""), false);
    });
    test("Display name: first name only, cleaned, max 20 characters", () => {
        eq(MP.cleanDisplayName("  kanishkar manoj "), "Kanishkar"); eq(MP.cleanDisplayName("enzo!!"), "Enzo"); eq(MP.cleanDisplayName("O'Neil-Ray"), "O'Neil-Ray");
        eq(MP.cleanDisplayName("   "), null); eq(MP.cleanDisplayName("A".repeat(30)).length, 20);
    });
    test("Leaderboard: ranks signed-in reporters by points this week", () => {
        const now = T0 + 10 * WEEKDAY;
        const reports = [rep("a", "cooper", now - WEEKDAY), rep("a", "davis", now - 2 * WEEKDAY), rep("b", "center", now - WEEKDAY)];
        const board = MP.weeklyLeaderboard(reports, { a: { name: "Ana", show: true }, b: { name: "Ben", show: true } }, now);
        eq(board.map(r => r.name).join(","), "Ana,Ben"); eq(board[0].points, 20); eq(board[0].rank, 1); eq(board[1].rank, 2);
    });
    test("Leaderboard: anonymous reporters earn points but are not listed", () => {
        const now = T0 + 10 * WEEKDAY;
        const board = MP.weeklyLeaderboard([rep("anon", "cooper", now - WEEKDAY), rep("a", "davis", now - WEEKDAY)], { a: { name: "Ana", show: true } }, now);
        eq(board.length, 1); eq(board[0].uid, "a");
    });
    test("Leaderboard: people who hide themselves are not listed", () => {
        const now = T0 + 10 * WEEKDAY;
        eq(MP.weeklyLeaderboard([rep("a", "cooper", now - WEEKDAY)], { a: { name: "Ana", show: false } }, now).length, 0);
    });
    test("Leaderboard: reports older than 7 days don't count", () => {
        const now = T0 + 10 * WEEKDAY;
        const board = MP.weeklyLeaderboard([rep("a", "cooper", now - 8 * WEEKDAY), rep("a", "davis", now - WEEKDAY)], { a: { name: "Ana", show: true } }, now);
        eq(board[0].points, 10);
    });
    test("Leaderboard: the +5 backup bonus counts, and ties share a rank", () => {
        const now = T0 + 10 * WEEKDAY;
        const reports = [rep("a", "cooper", now - WEEKDAY), rep("b", "cooper", now - WEEKDAY + 60000), rep("c", "davis", now - 2 * WEEKDAY), rep("c", "center", now - 3 * WEEKDAY)];
        const board = MP.weeklyLeaderboard(reports, { a: { name: "Ana" }, b: { name: "Ben" }, c: { name: "Cy" } }, now);
        eq(board.find(r => r.uid === "a").points, 15); eq(board.find(r => r.uid === "b").points, 15);
        eq(board.find(r => r.uid === "c").points, 20); eq(board.find(r => r.uid === "c").rank, 1);
        eq(board.find(r => r.uid === "a").rank, 2); eq(board.find(r => r.uid === "b").rank, 2);
    });
    test("LocalReportStore: UTA sign-in explains it needs the shared backend", async () => {
        const s = new STORE.LocalReportStore(fakeStorage());
        await s.init();
        let msg = "";
        try { await s.utaSignUp("a@mavs.uta.edu", "secret1"); } catch (e) { msg = e.message; }
        assert(/shared backend/.test(msg), "message mentions the shared backend");
    });

    test("Commute: west approach starts with Bowen, Davis and Cooper", () => {
        const c = MP.defaultCommute("west");
        eq(c.crossings.join(","), "bowen,davis,cooper");
        eq(MP.cleanCommute({ direction: "east", crossings: ["nope", "collins"], arriveBy: "09:20", days: ["tue"] }).crossings.join(","), "collins");
        eq(MP.cleanCommute(null), null);
    });
    test("Crossing pattern: hidden until 20 blocked reports, then names the busiest hour", () => {
        const hour = h => { const d = new Date(T0); d.setHours(h, 15, 0, 0); return d.getTime(); };
        const few = [0, 1, 2].map(i => ({ type: "crossing", targetId: "cooper", status: "blocked", at: hour(8) + i, reporterId: "u" + i }));
        eq(MP.crossingPattern(few, "cooper", hour(12)).enough, false);
        eq(MP.crossingPattern(few, "cooper", hour(12)).total, 3);
        const many = [];
        for (let i = 0; i < 20; i++) many.push({ type: "crossing", targetId: "cooper", status: "blocked", at: hour(8) + i, reporterId: "u" + i });
        const pat = MP.crossingPattern(many, "cooper", hour(12));
        eq(pat.enough, true);
        assert(pat.window.indexOf("8") !== -1, pat.window);
    });
    test("Alert before arrival only inside the 45 minutes on a saved day", () => {
        const commute = { crossings: ["cooper"], arriveBy: "09:00", days: [], alertBefore: true };
        const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
        eq(MP.shouldAlertBefore(commute, { id: "cooper", state: "confirmed" }, at(8, 30)), true);
        eq(MP.shouldAlertBefore(commute, { id: "cooper", state: "confirmed" }, at(7, 0)), false);
        eq(MP.shouldAlertBefore(commute, { id: "davis", state: "confirmed" }, at(8, 30)), false);
        eq(MP.shouldAlertBefore({ ...commute, alertBefore: false }, { id: "cooper", state: "confirmed" }, at(8, 30)), false);
    });
    test("Commuter bar: blocked names the open path, clear stays quiet and green", () => {
        const blocked = MP.commuterBar({ mode: "commuter", crossings: [{ id: "cooper", name: "Cooper St", state: "confirmed" }, { id: "center", name: "Center St", state: "likely" }], closures: [] });
        eq(blocked.level, "bad");
        eq(blocked.title, "Cooper St blocked");
        assert(blocked.sub.indexOf("West St underpass") !== -1, blocked.sub);
        const clear = MP.commuterBar({ mode: "commuter", crossings: [{ id: "cooper", name: "Cooper St", state: "clear" }], closures: [], alerts: [] });
        eq(clear.level, "good");
        eq(clear.title, "Path is clear");
        eq(MP.commuterBar({ mode: "off", crossings: [{ id: "cooper", name: "Cooper St", state: "confirmed" }] }), null);
        eq(MP.commuterBar({ mode: "quiet", crossings: [{ id: "cooper", name: "Cooper St", state: "confirmed" }] }), null);
    });
    test("Detour handoff: Davis route is about 1.8 mi and opens in three maps", () => {
        const h = MP.detourHandoff(DET.DETOURS.davis);
        eq(h.miles, 1.8);
        eq(h.minutes, 5);
        eq(h.via, "West St underpass");
        assert(h.apple.indexOf("maps.apple.com") !== -1, "apple");
        assert(h.google.indexOf("google.com/maps") !== -1, "google");
        assert(h.waze.indexOf("waze.com") !== -1, "waze");
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
