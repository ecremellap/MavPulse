/*
 * MavPulse core logic
 * -------------------
 * Every rule the app decides with lives here as a pure function: no DOM,
 * no network, no clock reads (callers pass `now`). That keeps each rule
 * directly testable in Node (`node tests.js`) and in the browser
 * (tests.html), and keeps the UI code in script.js thin.
 */
(function (root) {
    "use strict";

    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;

    // ---------------------------------------------------------------
    //  Tunable rules (one place, so the requirements doc can cite them)
    // ---------------------------------------------------------------
    const RULES = {
        CONFIRMATION_WINDOW_MS: 5 * MINUTE,   // UC-01: two reporters within 5 min
        CROSSING_BLOCK_TTL_MS: 20 * MINUTE,   // a block report expires after 20 min
        CLOSURE_TTL_MS: 12 * HOUR,            // closures shown for 12 h
        LOT_TTL_MS: 90 * MINUTE,              // "lot full" counts for 90 min
        STUDY_TTL_MS: 60 * MINUTE,            // study report counts for 60 min
        REPORT_COOLDOWN_MS: 2 * MINUTE,       // one report per target per 2 min
        POINTS_PER_REPORT: 10,
        POINTS_CONFIRMED_BONUS: 5
    };

    // =================================================================
    //  UC-01  Train-crossing confirmation
    // =================================================================

    // Two reports confirm a block when they are for the same crossing,
    // from two different people, within the confirmation window.
    function shouldConfirmCrossingAlert(reportA, reportB) {
        if (!reportA || !reportB) return false;
        if (reportA.crossingId !== reportB.crossingId) return false;
        if (reportA.reporterId === reportB.reporterId) return false;
        const gap = Math.abs(new Date(reportA.timestamp) - new Date(reportB.timestamp));
        return gap <= RULES.CONFIRMATION_WINDOW_MS;
    }

    // Live state of one crossing from all recent reports about it.
    // Returns { state: "clear" | "reported" | "confirmed", lastAt, reporters }.
    //   - A "clear" report newer than every "blocked" report clears it.
    //   - Blocks expire CROSSING_BLOCK_TTL_MS after the latest block report.
    //   - One reporter  -> "reported" (shown, marked unconfirmed).
    //   - Two distinct reporters within the window -> "confirmed" (alerts fire).
    function crossingState(reports, crossingId, now) {
        const mine = (reports || [])
            .filter(r => r && r.type === "crossing" && r.targetId === crossingId)
            .sort((a, b) => a.at - b.at);
        const lastClear = mine.filter(r => r.status === "clear").pop();
        const blocks = mine.filter(r => r.status === "blocked"
            && (!lastClear || r.at > lastClear.at)
            && now - r.at <= RULES.CROSSING_BLOCK_TTL_MS);
        if (!blocks.length) return { state: "clear", lastAt: lastClear ? lastClear.at : null, reporters: 0 };

        const reporters = new Set(blocks.map(r => r.reporterId));
        let confirmed = false;
        let confirmedAt = null;
        for (let i = 0; i < blocks.length && !confirmed; i++) {
            for (let j = i + 1; j < blocks.length; j++) {
                const a = { crossingId, reporterId: blocks[i].reporterId, timestamp: blocks[i].at };
                const b = { crossingId, reporterId: blocks[j].reporterId, timestamp: blocks[j].at };
                if (shouldConfirmCrossingAlert(a, b)) { confirmed = true; confirmedAt = blocks[j].at; break; }
            }
        }
        return {
            state: confirmed ? "confirmed" : "reported",
            since: blocks[0].at,
            lastAt: blocks[blocks.length - 1].at,
            confirmedAt,
            reporters: reporters.size
        };
    }

    // =================================================================
    //  Closures, parking, study spots (crowd reports)
    // =================================================================

    // Validated closure report from picker choices (no free typing).
    function createClosureReport(place, kindId, reporterId, now) {
        if (!place || typeof place.lat !== "number" || typeof place.lng !== "number") return null;
        if (!kindId) return null;
        const label = String(place.name || "").trim().slice(0, 80);
        if (label.length < 3) return null;
        return {
            type: "closure", targetId: place.id || "custom", status: "active", kind: kindId,
            label, lat: place.lat, lng: place.lng, reporterId: reporterId || "anon", at: now
        };
    }

    // Recent reports of a type, newest first, within its time-to-live.
    function activeReports(reports, now, maxAgeMs, type) {
        return (reports || [])
            .filter(r => r && typeof r.at === "number" && now - r.at <= maxAgeMs && (!type || r.type === type))
            .sort((a, b) => b.at - a.at);
    }

    // Closure reports, de-duplicated by place + kind (newest wins) and
    // carrying how many distinct people reported the same thing.
    function activeClosures(reports, now) {
        const groups = new Map();
        activeReports(reports, now, RULES.CLOSURE_TTL_MS, "closure").forEach(r => {
            const key = `${r.targetId}|${r.kind}`;
            if (!groups.has(key)) groups.set(key, { ...r, reporters: new Set() });
            groups.get(key).reporters.add(r.reporterId);
        });
        return [...groups.values()].map(g => ({ ...g, reporterCount: g.reporters.size, reporters: undefined }));
    }

    // Latest crowd status for one target (lot or study spot) within TTL.
    function latestStatus(reports, type, targetId, now, ttlMs) {
        const hit = activeReports(reports, now, ttlMs, type).find(r => r.targetId === targetId);
        return hit || null;
    }

    // Anti-spam: the same person can't re-report the same target too fast.
    function canReport(reports, reporterId, type, targetId, now) {
        return !(reports || []).some(r => r.reporterId === reporterId && r.type === type
            && r.targetId === targetId && now - r.at < RULES.REPORT_COOLDOWN_MS);
    }

    // ---- study spots: crowd reports only, no invented estimate ----
    // Returns { source: "live", status, at } for a report inside the TTL,
    // otherwise { source: "none" } so the UI says "No recent report".
    function studyStatus(latestReport, now) {
        if (!latestReport) return { source: "none" };
        const at = typeof latestReport.at === "number" ? latestReport.at : new Date(latestReport.at).getTime();
        if (now - at > RULES.STUDY_TTL_MS) return { source: "none" };
        return { source: "live", status: latestReport.status, at };
    }

    // =================================================================
    //  MavMover shuttle schedule
    // =================================================================

    // Is a route in service at `date`? School-year routes run Mon–Fri.
    function routeStatus(route, date) {
        const day = date.getDay();
        const mins = date.getHours() * 60 + date.getMinutes();
        const fmt = m => {
            const h = Math.floor(m / 60), mm = m % 60;
            const ampm = h >= 12 ? "PM" : "AM";
            return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ampm}`;
        };
        if (day === 0 || day === 6) return { running: false, label: "No weekend service" };
        if (mins < route.start) return { running: false, label: `Starts ${fmt(route.start)}` };
        if (mins >= route.end) return { running: false, label: "Done for today" };
        return { running: true, label: `Running until ${fmt(route.end)}` };
    }

    // =================================================================
    //  NWS weather alerts
    // =================================================================

    function filterCampusAlerts(features, keywords) {
        const severityRank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
        return (features || [])
            .map(feature => feature.properties || {})
            .filter(p => keywords.some(k => (p.areaDesc || "").toLowerCase().includes(k)))
            .sort((a, b) => (severityRank[a.severity] ?? 5) - (severityRank[b.severity] ?? 5));
    }

    // =================================================================
    //  Notifications: the "conflicting viewpoints" rule, in code.
    //  Commuters want every crossing alert; on-campus students and staff
    //  want almost none. Each user picks a mode; this decides.
    // =================================================================
    function shouldNotify(mode, event) {
        if (!event || mode === "off") return false;
        if (event.type === "weather") {
            // Severe/Extreme weather always gets through unless notifications are off.
            if (event.severity === "Extreme" || event.severity === "Severe") return true;
            return mode === "commuter";
        }
        if (mode === "quiet") return false;
        if (mode === "commuter") {
            if (event.type === "crossing") return event.state === "confirmed"; // never on one unconfirmed tap
            return event.type === "closure";
        }
        return false;
    }

    // =================================================================
    //  Contributor points (motivation to tap "busy"/"open"/"blocked")
    // =================================================================
    const LEVELS = [
        { min: 0, name: "Newcomer" }, { min: 50, name: "Regular" },
        { min: 150, name: "Campus Scout" }, { min: 400, name: "Pulse Legend" }
    ];

    // A report is "confirmed" when someone else reported the same target
    // with the same status within the confirmation window.
    function contributorStats(reports, reporterId) {
        const all = reports || [];
        const mine = all.filter(r => r.reporterId === reporterId);
        let confirmed = 0;
        mine.forEach(r => {
            const backedUp = all.some(o => o.reporterId !== reporterId && o.type === r.type
                && o.targetId === r.targetId && o.status === r.status
                && Math.abs(o.at - r.at) <= RULES.CONFIRMATION_WINDOW_MS);
            if (backedUp) confirmed += 1;
        });
        const points = mine.length * RULES.POINTS_PER_REPORT + confirmed * RULES.POINTS_CONFIRMED_BONUS;
        let level = LEVELS[0];
        LEVELS.forEach(l => { if (points >= l.min) level = l; });
        const next = LEVELS.find(l => l.min > points) || null;
        return { reports: mine.length, confirmed, points, level: level.name, nextLevel: next ? next.name : null, toNext: next ? next.min - points : 0 };
    }

    // =================================================================
    //  Morning brief: one card that answers "can I leave now?"
    // =================================================================
    function buildBrief(input) {
        const lines = [];
        const { weather, alerts, crossings, closures, routesRunning, roadWork, mavAlerts, now } = input;
        let level = "good";
        if (weather) {
            lines.push({ icon: "temp", text: `${Math.round(weather.temp)}°F, ${weather.condition.toLowerCase()} · ${weather.rainChance}% chance of rain` });
        }
        if (mavAlerts && mavAlerts.length) {
            lines.unshift({ icon: "siren", text: `UTA MavAlert: ${mavAlerts[0].title}` });
            level = "bad";
        }
        if (alerts && alerts.length) {
            lines.push({ icon: "alert", text: `${alerts[0].event}${alerts.length > 1 ? ` (+${alerts.length - 1} more)` : ""}` });
            if (level !== "bad") level = "warn";
        }
        const blocked = (crossings || []).filter(c => c.state === "reported" || c.state === "confirmed");
        const likely = (crossings || []).filter(c => c.state === "likely");
        if (blocked.length) {
            blocked.forEach(c => lines.push({
                icon: "train",
                text: `${c.name} crossing ${c.state === "confirmed" ? "blocked (confirmed)" : "reported blocked"} · ${minutesAgo(c.lastAt, now)}`
            }));
            if (likely.length) lines.push({ icon: "train", text: `Long train: ${likely.map(c => c.name).join(", ")} likely blocked too` });
            lines.push({ icon: "check", text: blocked.some(c => c.id === "bowen") && blocked.length === 1 ? "Detour: Fielder Rd bridge goes over the tracks" : "Detour: West St underpass goes under the tracks" });
            level = "bad";
        } else {
            lines.push({ icon: "train", text: "No blocked rail crossings reported" });
        }
        const n = (closures || []).length;
        lines.push({ icon: "cone", text: n ? `${n} closure${n === 1 ? "" : "s"} reported near campus` : "No closures reported" });
        if (n && level === "good") level = "warn";
        if (typeof roadWork === "number" && roadWork > 0) {
            lines.push({ icon: "cone", text: `${roadWork} active city road-work site${roadWork === 1 ? "" : "s"} near campus (official)` });
        }
        if (typeof routesRunning === "number") {
            lines.push({ icon: "bus", text: routesRunning ? `${routesRunning} MavMover route${routesRunning === 1 ? "" : "s"} running now` : "MavMover not running right now" });
        }
        const headline = level === "bad" ? "Heads up before you leave" : level === "warn" ? "Mostly clear, check the details" : "All clear for your commute";
        if (input.route && input.route.length) {
            const mine = (crossings || []).filter(c => input.route.indexOf(c.id) !== -1);
            const hit = mine.filter(c => c.state && c.state !== "clear");
            lines.unshift({
                icon: "car",
                text: hit.length
                    ? `On your route: ${hit.map(c => `${c.name} ${c.state === "likely" ? "likely blocked" : "blocked"}`).join("; ")}`
                    : `Your crossings are clear${mine.length ? ` (${mine.map(c => c.name).join(", ")})` : ""}`
            });
        }
        return { level, headline, lines };
    }

    function minutesAgo(at, now) {
        const mins = Math.round((now - at) / MINUTE);
        if (mins <= 0) return "just now";
        if (mins < 60) return `${mins} min ago`;
        const h = Math.round(mins / 60);
        return `${h} hour${h === 1 ? "" : "s"} ago`;
    }

    // Distance in meters (haversine), for "closest place to my GPS".
    function distanceMeters(a, b) {
        const R = 6371000, toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function nearest(point, items) {
        let best = null, bestD = Infinity;
        (items || []).forEach(it => { const d = distanceMeters(point, it); if (d < bestD) { bestD = d; best = it; } });
        return best ? { item: best, meters: Math.round(bestD) } : null;
    }


    // =================================================================
    //  City of Arlington open data (official sources)
    // =================================================================

    // Right-of-way permits -> road work active right now.
    // Active = permit Issued, barricades installed, and the barricade
    // removal date (or project end) has not passed. Groups segments by permit.
    function activeRoadWork(features, now) {
        const byPermit = new Map();
        (features || []).forEach(f => {
            const a = f.attributes || {};
            if (a.Status !== "Issued" || !a.BarricadeInstall || a.BarricadeInstall > now) return;
            const end = a.BarricadeRemove || a.ProjectEnd;
            if (!end || end < now) return;
            if (!byPermit.has(a.Permit)) {
                byPermit.set(a.Permit, {
                    permit: a.Permit, kind: (a.Sub || "Road work").trim(),
                    scope: String(a.ScopeOfWork || "").replace(/\s+/g, " ").trim(),
                    from: a.BarricadeInstall, until: end, segments: [], paths: []
                });
            }
            const w = byPermit.get(a.Permit);
            if (a.Segment) w.segments.push(a.Segment.trim());
            if (f.geometry && f.geometry.paths) w.paths.push(...f.geometry.paths);
        });
        return [...byPermit.values()].sort((x, y) => x.until - y.until);
    }

    // Sensitive offense types: counted in the summary, never pinned on the
    // map (protects victims' privacy). Juvenile cases are never pinned.
    const SENSITIVE_CRIME = /SEX OFFENSE|RAPE|SODOMY|FONDLING|HUMAN TRAFFICKING|INCEST/i;

    function crimeCategory(desc) {
        const d = String(desc || "").toUpperCase();
        if (/ROBBERY/.test(d)) return "Robbery";
        if (/ASSAULT|INTIMIDATION/.test(d)) return "Assault";
        if (/MOTOR VEHICLE THEFT/.test(d)) return "Vehicle theft";
        if (/THEFT FROM MOTOR VEHICLE/.test(d)) return "Car break-in";
        if (/BURGLARY/.test(d)) return "Burglary";
        if (/THEFT|LARCENY|SHOPLIFT|STOLEN/.test(d)) return "Theft";
        if (/VANDAL|DESTRUCTION|DAMAGE/.test(d)) return "Vandalism";
        if (/DRUG|NARCOTIC/.test(d)) return "Drugs";
        if (/WEAPON/.test(d)) return "Weapons";
        if (/FRAUD|FORGERY|COUNTERFEIT|EMBEZZ/.test(d)) return "Fraud";
        if (SENSITIVE_CRIME.test(d)) return "Sex offense";
        return "Other";
    }

    // Summarise crime features from the last `days` days.
    // Returns { total, byCategory: [[name, n]...], mappable: [...] }.
    function summarizeCrime(features, now, days) {
        const since = now - days * 24 * HOUR;
        const recent = (features || []).map(f => ({ ...(f.attributes || {}), geometry: f.geometry }))
            .filter(a => a.DateOfOccurrence && a.DateOfOccurrence >= since && a.DateOfOccurrence <= now);
        const counts = {};
        recent.forEach(a => { const c = crimeCategory(a.Description); counts[c] = (counts[c] || 0) + 1; });
        const mappable = recent.filter(a => a.geometry && a.Juvenile !== "Yes" && !SENSITIVE_CRIME.test(a.Description || ""))
            .map(a => ({ lat: a.geometry.y, lng: a.geometry.x, category: crimeCategory(a.Description), at: a.DateOfOccurrence }));
        return { total: recent.length, byCategory: Object.entries(counts).sort((x, y) => y[1] - x[1]), mappable };
    }

    // Hazards within `radiusM` of a GPS position, nearest first.
    function nearbyHazards(pos, hazards, radiusM) {
        if (!pos) return [];
        return (hazards || []).map(h => ({ ...h, meters: Math.round(distanceMeters(pos, h)) }))
            .filter(h => h.meters <= radiusM).sort((a, b) => a.meters - b.meters);
    }


    // =================================================================
    //  Long trains: one train blocks several crossings
    //  Union Pacific freight trains on this line are often 1.5–2.5 km
    //  long, so a train stopped at one crossing usually blocks the
    //  neighbours too. Crossings within TRAIN_REACH_M of a reported one
    //  become "likely" blocked (never "confirmed" without reports).
    // =================================================================
    const TRAIN_REACH_M = 2000;
    function spreadTrain(crossings) {
        const list = (crossings || []).map(c => ({ ...c }));
        const sources = list.filter(c => c.state === "reported" || c.state === "confirmed");
        list.forEach(c => {
            if (c.state !== "clear") return;
            let best = null;
            sources.forEach(src => {
                const d = distanceMeters(c, src);
                if (d <= TRAIN_REACH_M && (!best || d < best.d)) best = { d, src };
            });
            if (best) Object.assign(c, { state: "likely", cause: best.src.name, causeId: best.src.id, lastAt: best.src.lastAt, distanceM: Math.round(best.d) });
        });
        return list;
    }

    // =================================================================
    //  MavMover live buses (TripShot public rider feed)
    // =================================================================

    // Google encoded polyline -> [[lat, lng], ...]
    function decodePolyline(str) {
        const pts = []; let i = 0, lat = 0, lng = 0;
        while (i < (str || "").length) {
            for (const which of [0, 1]) {
                let shift = 0, result = 0, b;
                do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length + 1);
                const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
                if (which === 0) lat += delta; else lng += delta;
            }
            pts.push([lat / 1e5, lng / 1e5]);
        }
        return pts;
    }

    // One TripShot route-detail response -> what the app shows.
    function parseTripShotRoute(json, now) {
        const d = json && json.InternalRouteDetails;
        if (!d || !d.route) return null;
        const t = (d.inexactTimetables && d.inexactTimetables[0]) || (d.exactTimetables && d.exactTimetables[0]) || {};
        const stops = (t.stops || []).map(s => ({ id: String(s.stopId).toLowerCase(), name: s.name, lat: s.location && s.location.lt, lng: s.location && s.location.lg }))
            .filter(s => typeof s.lat === "number");
        const stopName = id => { const s = stops.find(x => x.id === String(id).toLowerCase()); return s ? s.name : "next stop"; };
        const path = [];
        ((t.navigations && t.navigations[0] && t.navigations[0].legs) || []).forEach(leg => (leg.steps || []).forEach(step => path.push(...decodePolyline(step.polyline))));
        const buses = (t.liveRides || []).map(lr => {
            const v = lr.vehicleStatus || {};
            if (!v.location || typeof v.location.lt !== "number") return null;
            const next = ((lr.ride && lr.ride.stopStatus) || []).map(x => { const k = Object.keys(x)[0]; return { kind: k, ...x[k] }; })
                .find(x => x.kind === "Awaiting" || x.kind === "Present");
            const eta = next && next.expectedArrivalTime ? Math.max(0, Math.round((new Date(next.expectedArrivalTime).getTime() - now) / 60000)) : null;
            const seenSec = v.when ? Math.round((now - new Date(v.when).getTime()) / 1000) : null;
            return {
                id: v.vehicleId, name: v.name || "Bus", lat: v.location.lt, lng: v.location.lg,
                bearing: typeof v.bearing === "number" ? v.bearing : 0,
                riders: typeof v.apcOccupancy === "number" ? v.apcOccupancy : null,
                capacity: lr.vehicle && lr.vehicle.capacity || null,
                nextStop: next ? (next.kind === "Present" ? `At ${stopName(next.stopId)}` : stopName(next.stopId)) : null,
                etaMin: next && next.kind === "Awaiting" ? eta : next ? 0 : null,
                delayed: !!(next && next.riderStatus === "Delayed"),
                stale: seenSec !== null && seenSec > 180
            };
        }).filter(Boolean);
        return { id: d.route.routeId, name: d.route.name, short: d.route.shortName, color: d.route.color || "#0057a8", stops, path, buses };
    }


    // =================================================================
    //  Weekly leaderboard (asked for by commuter students).
    //  Anyone who verifies an email and chooses to be shown appears.
    //  Everyone else still earns points anonymously.
    // =================================================================
    const LEADERBOARD_WINDOW_MS = 7 * 24 * 60 * MINUTE;

    function isUtaEmail(email) {
        return typeof email === "string" && /^[^@\s]+@(mavs\.)?uta\.edu$/i.test(email.trim());
    }

    // Any normal email can create an account. UTA addresses still count via isUtaEmail.
    function isAccountEmail(email) {
        if (typeof email !== "string") return false;
        const v = email.trim();
        return v.length >= 6 && v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    }

    // Profiles saved before the split have no `uta` field; those accounts were UTA-only.
    function profileIsUta(profile) {
        return !!(profile && profile.uta !== false);
    }

    // First name only, letters plus ' and -, at most 20 characters.
    function cleanDisplayName(name) {
        if (typeof name !== "string") return null;
        const first = name.trim().split(/\s+/)[0] || "";
        const clean = first.replace(/[^\p{L}'-]/gu, "").slice(0, 20);
        if (!clean) return null;
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    }

    function weeklyLeaderboard(reports, profiles, now) {
        const since = now - LEADERBOARD_WINDOW_MS;
        const week = (reports || []).filter(r => r && r.at >= since && r.at <= now + MINUTE);
        const ids = new Set(week.map(r => r.reporterId));
        const rows = [];
        ids.forEach(uid => {
            const p = profiles && profiles[uid];
            if (!p || p.show === false) return;
            const name = cleanDisplayName(p.name);
            if (!name) return;
            const s = contributorStats(week, uid);
            if (s.points > 0) rows.push({ uid, name, points: s.points, reports: s.reports, level: s.level });
        });
        rows.sort((a, b) => b.points - a.points || b.reports - a.reports || a.name.localeCompare(b.name));
        let rank = 0, prev = null;
        rows.forEach((r, i) => { if (r.points !== prev) { rank = i + 1; prev = r.points; } r.rank = rank; });
        return rows;
    }

    // Saved commute. Direction only picks a starting set of crossings;
    // the commuter can turn each crossing on or off after that.
    const COMMUTE_APPROACH = {
        west: ["bowen", "davis", "cooper"],
        east: ["collins", "mesquite", "center"],
        south: ["cooper", "center"]
    };
    const CROSSING_IDS = ["bowen", "davis", "cooper", "center", "mesquite", "collins"];
    function defaultCommute(direction) {
        const d = COMMUTE_APPROACH[direction] ? direction : "west";
        return { direction: d, crossings: COMMUTE_APPROACH[d].slice(), lot: "", arriveBy: "", days: ["tue", "thu"], alertBefore: false };
    }
    function cleanCommute(raw) {
        if (!raw || typeof raw !== "object") return null;
        const direction = COMMUTE_APPROACH[raw.direction] ? raw.direction : "west";
        const crossings = Array.isArray(raw.crossings) ? raw.crossings.filter(id => CROSSING_IDS.indexOf(id) !== -1) : COMMUTE_APPROACH[direction].slice();
        const dayOk = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1 };
        const days = Array.isArray(raw.days) ? raw.days.filter(d => dayOk[d]) : ["tue", "thu"];
        const arriveBy = typeof raw.arriveBy === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.arriveBy) ? raw.arriveBy : "";
        return { direction, crossings, lot: typeof raw.lot === "string" ? raw.lot.slice(0, 40) : "", arriveBy, days, alertBefore: !!raw.alertBefore };
    }

    // A pattern is a count of real blocked reports by hour. Under 20, say so.
    const PATTERN_MIN_REPORTS = 20;
    function hourLabel(mins) {
        const h = Math.floor(mins / 60);
        const hr = h % 12 || 12;
        return `${hr}${h < 12 ? "a" : "p"}`;
    }
    function clockLabel(mins) {
        const h = Math.floor(mins / 60), min = mins % 60;
        const hr = h % 12 || 12;
        const am = h < 12 ? "AM" : "PM";
        return min ? `${hr}:${String(min).padStart(2, "0")} ${am}` : `${hr} ${am}`;
    }
    function crossingPattern(reports, crossingId, now) {
        const rows = (reports || []).filter(r => r && r.type === "crossing" && r.targetId === crossingId && r.status === "blocked" && r.at <= now);
        if (rows.length < PATTERN_MIN_REPORTS) return { enough: false, total: rows.length, need: PATTERN_MIN_REPORTS, buckets: [] };
        const buckets = [];
        for (let h = 6; h <= 20; h++) buckets.push({ start: h * 60, count: 0 });
        rows.forEach(r => {
            const d = new Date(r.at);
            const mins = d.getHours() * 60 + d.getMinutes();
            const b = buckets.find(x => mins >= x.start && mins < x.start + 60);
            if (b) b.count += 1;
        });
        let peak = buckets[0];
        buckets.forEach(b => { if (b.count > peak.count) peak = b; });
        return {
            enough: true, total: rows.length, need: PATTERN_MIN_REPORTS,
            window: peak.count ? `${clockLabel(peak.start)}–${clockLabel(peak.start + 60)}` : "No peak yet",
            peakCount: peak.count,
            buckets: buckets.map(b => ({ start: b.start, label: hourLabel(b.start), count: b.count }))
        };
    }
    function typicalBlockMinutes(reports, crossingId) {
        const rows = (reports || []).filter(r => r && r.type === "crossing" && r.targetId === crossingId).slice().sort((a, b) => a.at - b.at);
        const gaps = [];
        rows.forEach((r, i) => {
            if (r.status !== "blocked") return;
            const clear = rows.slice(i + 1).find(x => x.status === "clear");
            if (!clear) return;
            const mins = (clear.at - r.at) / MINUTE;
            if (mins > 0 && mins <= 40) gaps.push(mins);
        });
        if (gaps.length < 3) return null;
        gaps.sort((a, b) => a - b);
        return Math.round(gaps[Math.floor(gaps.length / 2)]);
    }

    // Notify in the 45 minutes before a saved arrival, on a saved day, for a crossing on the route.
    function shouldAlertBefore(commute, crossing, now) {
        if (!commute || !commute.alertBefore || !commute.arriveBy || !crossing) return false;
        if (!commute.crossings || commute.crossings.indexOf(crossing.id) === -1) return false;
        if (crossing.state !== "confirmed") return false;
        const parts = commute.arriveBy.split(":");
        const hh = Number(parts[0]), mm = Number(parts[1]);
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
        const d = new Date(now);
        const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        if (commute.days && commute.days.length && commute.days.indexOf(keys[d.getDay()]) === -1) return false;
        const arrive = new Date(d);
        arrive.setHours(hh, mm, 0, 0);
        const lead = arrive.getTime() - now;
        return lead >= 0 && lead <= 45 * MINUTE;
    }

    // Hand the mapped detour to a maps app. Miles and minutes come from the
    // route length at about 20 mph, not from live traffic.
    function detourHandoff(detour) {
        if (!detour || !detour.path || detour.path.length < 2 || !detour.via) return null;
        const start = detour.path[0], end = detour.path[detour.path.length - 1];
        const s = `${start[0]},${start[1]}`, e = `${end[0]},${end[1]}`, v = `${detour.via.lat},${detour.via.lng}`;
        const miles = Math.round((detour.meters / 1609.344) * 10) / 10;
        const minutes = Math.max(1, Math.round(detour.meters / (20 * 1609.344 / 60)));
        return {
            via: detour.via.name, miles, minutes,
            note: "About, from the length of this route at 20 mph. Not live traffic. MavPulse does not give turn-by-turn directions.",
            apple: `https://maps.apple.com/?saddr=${s}&daddr=${v}&daddr=${e}&dirflg=d`,
            google: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(s)}&destination=${encodeURIComponent(e)}&waypoints=${encodeURIComponent(v)}&travelmode=driving`,
            waze: `https://www.waze.com/ul?from=${encodeURIComponent(s)}&to=${encodeURIComponent(e)}&navigate=yes`
        };
    }

    const LOGIC = {
        RULES, shouldConfirmCrossingAlert, crossingState, createClosureReport, activeReports,
        activeClosures, latestStatus, canReport, studyStatus, routeStatus, filterCampusAlerts, shouldNotify, contributorStats,
        buildBrief, minutesAgo, distanceMeters, nearest,
        activeRoadWork, crimeCategory, summarizeCrime, nearbyHazards,
        TRAIN_REACH_M, spreadTrain, decodePolyline, parseTripShotRoute,
        LEADERBOARD_WINDOW_MS, isUtaEmail, isAccountEmail, profileIsUta, cleanDisplayName, weeklyLeaderboard,
        defaultCommute, cleanCommute, crossingPattern, typicalBlockMinutes, shouldAlertBefore, detourHandoff, PATTERN_MIN_REPORTS
    };
    root.MP = LOGIC;
    // Back-compat names used by the Iteration 2 tests.
    Object.assign(root, { shouldConfirmCrossingAlert, filterCampusAlerts });
    if (typeof module !== "undefined" && module.exports) module.exports = LOGIC;
})(typeof window !== "undefined" ? window : globalThis);
