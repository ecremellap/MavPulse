/*
 * MavPulse test suite
 * -------------------
 * A tiny, dependency-free test harness so the project's core logic can be
 * verified with no build step and no npm install. It runs two ways:
 *   1. In the browser: open tests.html and read the pass/fail report.
 *   2. Headless in Node: `node tests.js` (the harness shims window/document).
 *
 * The functions under test are the pure decision/calculation helpers that
 * script.js exposes on window:
 *   - shouldConfirmCrossingAlert  (UC-01 operation contract)
 *   - estimateOccupancy           (study-spot busyness estimate)
 *   - resolveStudyStatus          (crowd report vs estimate)
 *   - filterCampusAlerts          (NWS live-alert filtering)
 *   - createClosureReport         (crowdsourced closure report validation)
 *   - activeReports               (recent-report filtering)
 */

(function () {
    "use strict";

    // ---- minimal assertion harness -------------------------------------
    const results = [];
    function test(name, fn) {
        try {
            fn();
            results.push({ name, passed: true });
        } catch (error) {
            results.push({ name, passed: false, message: error.message });
        }
    }
    function assert(condition, message) {
        if (!condition) throw new Error(message || "Assertion failed");
    }
    function assertEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error((message || "Values differ") + ` (expected ${expected}, got ${actual})`);
        }
    }

    // ---- load the functions under test ---------------------------------
    // In Node we load script.js in a stubbed DOM so its DOMContentLoaded
    // handler runs and attaches the helpers to window. In the browser the
    // real script.js has already run, so window already has them.
    let runningInNode = false;
    let ctx = typeof window !== "undefined" ? window : undefined;
    if (!ctx) {
        runningInNode = true;
        ctx = buildNodeContext();
    }

    // ========================= TEST CASES ===============================

    // --- UC-01: train-crossing alert confirmation -----------------------
    const now = Date.now();
    const minutes = m => new Date(now + m * 60 * 1000).toISOString();

    test("UC-01: two distinct reporters within 5 min confirm the alert", () => {
        const a = { crossingId: "mitchell-center", reporterId: "u1", timestamp: minutes(0) };
        const b = { crossingId: "mitchell-center", reporterId: "u2", timestamp: minutes(3) };
        assertEqual(ctx.shouldConfirmCrossingAlert(a, b), true);
    });

    test("UC-01: the same reporter twice does NOT confirm", () => {
        const a = { crossingId: "mitchell-center", reporterId: "u1", timestamp: minutes(0) };
        const b = { crossingId: "mitchell-center", reporterId: "u1", timestamp: minutes(2) };
        assertEqual(ctx.shouldConfirmCrossingAlert(a, b), false);
    });

    test("UC-01: reports more than 5 min apart do NOT confirm", () => {
        const a = { crossingId: "mitchell-center", reporterId: "u1", timestamp: minutes(0) };
        const b = { crossingId: "mitchell-center", reporterId: "u2", timestamp: minutes(6) };
        assertEqual(ctx.shouldConfirmCrossingAlert(a, b), false);
    });

    test("UC-01: reports for different crossings do NOT confirm", () => {
        const a = { crossingId: "mitchell-center", reporterId: "u1", timestamp: minutes(0) };
        const b = { crossingId: "cooper-underpass", reporterId: "u2", timestamp: minutes(1) };
        assertEqual(ctx.shouldConfirmCrossingAlert(a, b), false);
    });

    test("UC-01: a missing report is handled safely", () => {
        assertEqual(ctx.shouldConfirmCrossingAlert(null, undefined), false);
    });

    // --- Study-spot estimate + crowd-reported live status ---------------
    test("Estimated occupancy is higher at the midday peak than early morning", () => {
        const morning = ctx.estimateOccupancy(0.9, 4);   // 4 AM
        const midday = ctx.estimateOccupancy(0.9, 14);   // 2 PM
        assert(midday > morning, "midday should read busier than 4 AM");
    });

    test("A higher busyness factor reads busier at the same hour", () => {
        assert(ctx.estimateOccupancy(1.0, 14) > ctx.estimateOccupancy(0.6, 14),
            "busier spot should estimate higher");
    });

    test("Estimated occupancy stays within 0..100", () => {
        const pct = ctx.estimateOccupancy(1.0, 14);
        assert(pct >= 0 && pct <= 100, "estimate out of range");
    });

    test("A recent 'busy' report overrides the estimate and is marked live", () => {
        const report = { status: "busy", at: new Date().toISOString() };
        const state = ctx.resolveStudyStatus(30, report, Date.now());
        assertEqual(state.source, "live");
        assert(state.pct >= 85, "a busy report should read busy");
    });

    test("A stale report is ignored and the estimate is used", () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const report = { status: "busy", at: twoHoursAgo };
        const state = ctx.resolveStudyStatus(30, report, Date.now());
        assertEqual(state.source, "estimated");
        assertEqual(state.pct, 30);
    });

    // --- NWS live-alert filtering ---------------------------------------
    const sampleFeatures = [
        { properties: { event: "Heat Advisory", areaDesc: "Tarrant County", severity: "Minor" } },
        { properties: { event: "Tornado Warning", areaDesc: "Dallas County", severity: "Extreme" } },
        { properties: { event: "Flood Watch", areaDesc: "City of Arlington, Tarrant", severity: "Moderate" } },
        { properties: { event: "Winter Storm", areaDesc: "El Paso County", severity: "Severe" } }
    ];

    test("Only campus-area alerts are kept", () => {
        const kept = ctx.filterCampusAlerts(sampleFeatures, ["tarrant", "arlington"]);
        assertEqual(kept.length, 2);
        assert(kept.every(a => /tarrant|arlington/i.test(a.areaDesc)), "non-campus alert leaked through");
    });

    test("Kept alerts are sorted most-severe first", () => {
        const kept = ctx.filterCampusAlerts(sampleFeatures, ["tarrant", "arlington"]);
        assertEqual(kept[0].severity, "Moderate"); // Moderate outranks Minor
    });

    test("An empty feed returns an empty list", () => {
        assertEqual(ctx.filterCampusAlerts([], ["tarrant"]).length, 0);
        assertEqual(ctx.filterCampusAlerts(undefined, ["tarrant"]).length, 0);
    });

    // --- Crowdsourced closure reports -----------------------------------
    test("A report with a real location is created", () => {
        const r = ctx.createClosureReport("W Mitchell St at Center", "train blocking", Date.now());
        assert(r !== null, "valid report should be created");
        assertEqual(r.location, "W Mitchell St at Center");
        assertEqual(r.source, "user");
    });

    test("A report with no real location is rejected", () => {
        assertEqual(ctx.createClosureReport("", "note", Date.now()), null);
        assertEqual(ctx.createClosureReport("  a ", "note", Date.now()), null);
    });

    test("activeReports keeps recent reports and drops stale ones", () => {
        const now = Date.now();
        const fresh = { id: "1", location: "A", at: new Date(now - 60 * 1000).toISOString() };
        const stale = { id: "2", location: "B", at: new Date(now - 13 * 60 * 60 * 1000).toISOString() };
        const kept = ctx.activeReports([stale, fresh], now, 12 * 60 * 60 * 1000);
        assertEqual(kept.length, 1);
        assertEqual(kept[0].id, "1");
    });

    // ========================= REPORT ===================================
    const passed = results.filter(r => r.passed).length;
    const total = results.length;

    if (!runningInNode && typeof document !== "undefined" && document.getElementById("test-output")) {
        const out = document.getElementById("test-output");
        out.innerHTML = results.map(r =>
            `<li class="${r.passed ? "pass" : "fail"}">${r.passed ? "✓" : "✗"} ${r.name}` +
            (r.passed ? "" : ` — ${r.message}`) + `</li>`
        ).join("");
        const summary = document.getElementById("test-summary");
        if (summary) summary.textContent = `${passed} / ${total} tests passed`;
    } else {
        const lines = results.map(r =>
            `${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : "  -> " + r.message}`
        );
        lines.push(`\n${passed} / ${total} tests passed`);
        // Write synchronously to fd 1 so output is not lost to a pending
        // async handle (the startup fetch) at process teardown.
        require("fs").writeSync(1, lines.join("\n") + "\n");
        if (typeof process !== "undefined") process.exitCode = passed === total ? 0 : 1;
    }

    // ---- Node DOM shim: lets us run script.js headlessly ---------------
    function buildNodeContext() {
        const noop = () => {};
        // A permissive fake element: every property access returns something
        // harmless, and it is chainable, so script.js's DOM setup runs to
        // completion in Node without a real DOM. We only care that it attaches
        // the pure helpers to window; the DOM wiring is exercised in-browser.
        const fakeEl = new Proxy(function () {}, {
            get: (_, prop) => {
                if (prop === "classList") return { toggle: noop, add: noop, remove: noop, contains: () => false };
                if (prop === "dataset") return {};
                if (prop === "style") return {};
                if (prop === "addEventListener" || prop === "setAttribute" || prop === "removeAttribute") return noop;
                if (prop === "appendChild" || prop === "append" || prop === "before" || prop === "remove") return noop;
                if (prop === "querySelector" || prop === "closest") return () => fakeEl;
                if (prop === "querySelectorAll") return () => [];
                if (prop === "getAttribute") return () => "false";
                return fakeEl;
            },
            set: () => true,
            apply: () => fakeEl
        });
        const win = {};
        global.window = win;
        const safeSet = (key, value) => {
            try { global[key] = value; }
            catch (e) { Object.defineProperty(global, key, { value, configurable: true }); }
        };
        safeSet("navigator", { geolocation: null });
        safeSet("localStorage", { getItem: () => null, setItem: noop });
        // Resolve fetch to an empty feed so the startup calls in script.js
        // complete quietly; network behavior is exercised in the browser.
        safeSet("fetch", () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ features: [] })
        }));
        let domReadyHandler = null;
        safeSet("document", {
            addEventListener: (evt, handler) => { if (evt === "DOMContentLoaded") domReadyHandler = handler; },
            querySelector: () => fakeEl,
            querySelectorAll: () => [],
            getElementById: () => fakeEl,
            createElement: () => fakeEl
        });
        // Load and run script.js, then fire DOMContentLoaded so it wires up.
        const fs = require("fs");
        const path = require("path");
        const code = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
        // eslint-disable-next-line no-eval
        (0, eval)(code);
        if (domReadyHandler) domReadyHandler();
        return win;
    }
})();
