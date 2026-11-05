/*
 * MavPulse UI
 * -----------
 * Wires the screens to three things:
 *   - MP_DATA   real reference data (data.js)
 *   - MP        pure rules (logic.js), all unit-tested
 *   - store     a ReportStore (store.js): shared Firebase backend, or
 *               on-device fallback, behind the same interface
 * Live public sources: Open-Meteo (weather), National Weather Service
 * (alerts + alert areas), OpenStreetMap (map tiles).
 */
document.addEventListener("DOMContentLoaded", async () => {
    "use strict";
    const D = window.MP_DATA;
    const MP = window.MP;
    const $ = id => document.getElementById(id);
    const MIN = 60 * 1000;

    // ---------------- app state ----------------
    const state = {
        reports: [],          // from the store
        weekReports: null,    // last 7 days (shared mode), for points + leaderboard
        profiles: {},         // leaderboard names (verified UTA accounts)
        simReports: [],       // test-mode only, never leave this device
        updates: [],
        weather: null,
        nwsAlerts: [],
        uid: null,
        mode: "local",
        pickedClosureKind: null,
        pickedPlace: null,
        notifyMode: loadPref("mavpulse-notify-mode", "commuter"),
        notified: new Set(loadJSON("mavpulse-notified", []))
    };
    // Placeholder until the real ReportStore connects (see bottom of file).
    let store = { isAdmin: false, addReport: async () => { throw new Error("Still connecting"); }, removeReport: async () => {} };
    const allReports = () => state.reports.concat(state.simReports);
    const now = () => Date.now();

    function loadPref(k, dflt) { try { return localStorage.getItem(k) || dflt; } catch (e) { return dflt; } }
    function savePref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    function loadJSON(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) || dflt; } catch (e) { return dflt; } }
    const svg = (name, cls) => `<svg class="${cls || "i"}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

    // Motion helpers. Everything respects the OS "reduce motion" setting.
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { /* unsupported */ } }

    let toastTimer = null;
    function toast(msg, kind) {
        const t = $("toast");
        $("toast-text").textContent = msg;
        $("toast-icon").innerHTML = svg(kind === "ok" ? "check" : kind === "warn" ? "alert" : "bell");
        t.dataset.kind = kind || "info";
        t.hidden = false;
        t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => { t.hidden = true; }, 250); }, 3200);
    }

    // Remember what was just tapped so a successful report can celebrate
    // right on that button (check mark + floating "+10").
    let lastTap = null;
    document.addEventListener("pointerdown", e => { lastTap = e.target.closest("button, a"); }, true);
    function celebrate(target, points) {
        if (!target || !document.body.contains(target)) return;
        buzz(18);
        target.classList.remove("did-it"); void target.offsetWidth; target.classList.add("did-it");
        if (reduceMotion || !points) return;
        const r = target.getBoundingClientRect();
        const host = document.querySelector(".phone-screen").getBoundingClientRect();
        const f = el("span", "float-points", `+${points}`);
        f.style.left = `${r.left - host.left + r.width / 2}px`;
        f.style.top = `${r.top - host.top}px`;
        document.querySelector(".phone-screen").appendChild(f);
        setTimeout(() => f.remove(), 1000);
    }

    // ---------------- navigation ----------------
    const views = document.querySelectorAll(".app-view");
    const tabs = document.querySelectorAll(".tab-item");
    const ORDER = ["home", "map", "report", "study", "transit"];
    let currentView = "home";
    function moveGlider(id) {
        const tab = document.querySelector(`.tab-item[data-view="${id}"]`);
        const g = $("tab-glider");
        if (!tab || !g) return;
        g.style.width = `${tab.offsetWidth - 24}px`;
        g.style.transform = `translateX(${tab.offsetLeft + 12}px)`;
        g.classList.toggle("report", id === "report");
    }
    function switchView(id) {
        if (id === currentView) { document.querySelector(".main-content").scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }); return; }
        const dir = ORDER.indexOf(id) > ORDER.indexOf(currentView) ? "fwd" : "back";
        currentView = id;
        views.forEach(v => {
            const on = v.id === `view-${id}`;
            v.classList.toggle("active", on);
            v.classList.remove("enter-fwd", "enter-back");
            if (on && !reduceMotion) { void v.offsetWidth; v.classList.add(`enter-${dir}`); }
        });
        tabs.forEach(t => {
            const on = t.dataset.view === id;
            t.classList.toggle("active", on);
            if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
        });
        moveGlider(id);
        buzz(6);
        document.querySelector(".main-content").scrollTop = 0;
        if (id === "map" && map) setTimeout(() => map.invalidateSize(), 120);
        if (id === "transit" && typeof loadLive === "function") loadLive();
    }
    window.addEventListener("resize", () => moveGlider(currentView));
    tabs.forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
    $("home-date").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

    // ======================================================================
    //  MAP
    // ======================================================================
    let map = null;
    const layers = {};
    if (window.L && $("leaflet-map")) {
        map = L.map("leaflet-map", { zoomControl: true }).setView([32.7330, -97.1160], 15);
        // Standard OpenStreetMap tiles, muted with a CSS filter (see style.css
        // .leaflet-tile-pane) so our crossings, closures and road work stand out.
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        ["crossings", "closures", "alerts", "roadwork", "safety", "parking", "shuttles", "study", "rail", "me"].forEach(k => { layers[k] = L.layerGroup(); });
        layers.rail.addTo(map);
        layers.me.addTo(map);
        document.querySelectorAll(".filter-chip[data-layer]").forEach(btn => {
            const key = btn.dataset.layer;
            if (btn.getAttribute("aria-pressed") === "true") layers[key].addTo(map);
            btn.addEventListener("click", () => {
                const on = btn.getAttribute("aria-pressed") !== "true";
                btn.setAttribute("aria-pressed", String(on));
                btn.classList.toggle("active", on);
                if (on) layers[key].addTo(map); else map.removeLayer(layers[key]);
                if (key === "safety") { $("safety-card").hidden = !on; if (on) loadSafety(); }
                if (key === "parking") $("parking-panel").hidden = !on;
                updateMapFooter();
            });
        });
        map.on("click", e => {
            if (!pickingOnMap) return;
            pickingOnMap = false;
            document.body.classList.remove("picking");
            setPickedPlace({ id: "map-pick", name: `Pinned spot near ${nearestPlaceName(e.latlng.lat, e.latlng.lng)}`, lat: e.latlng.lat, lng: e.latlng.lng });
            switchView("report");
        });
    }
    function dot(cls, label) {
        return L.divIcon({ className: "mp-marker", html: `<span class="mk ${cls}">${label || ""}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    }
    function updateMapFooter() {
        if (!map) return;
        let n = 0;
        Object.keys(layers).forEach(k => { if (k !== "me" && k !== "rail" && map.hasLayer(layers[k])) n += layers[k].getLayers().length; });
        $("map-footer-text").textContent = `${n} item${n === 1 ? "" : "s"} on the map. Tap any marker for detail.`;
    }
    function popupHTML(title, lines, extra) {
        const div = el("div", "pop");
        div.appendChild(el("strong", null, title));
        (lines || []).forEach(l => div.appendChild(el("div", null, l)));
        if (extra) div.appendChild(extra);
        return div;
    }

    // Static layers: parking, shuttles, study markers
    // Every UTA parking area as a shaded outline; garages also get a label.
    let parkingBounds = null;
    const parkingShapes = {};
    function drawParkingLayer() {
        if (!map || layers.parking.getLayers().length) return; // static: draw once
        const areas = window.MP_PARKING_AREAS || [];
        areas.forEach(a => {
            const garage = D.PARKING.find(g => g.osm === a.id);
            const shape = L.polygon(a.poly, {
                color: garage ? "#00407c" : "#0057a8", weight: garage ? 2.5 : 1.5,
                fillColor: garage ? "#0057a8" : "#3b82f6", fillOpacity: garage ? 0.55 : 0.32
            });
            const lines = garage ? [garage.kind, garage.who] : [a.name && a.name !== "UTA Parking" ? a.name : "UTA parking lot", "Check the posted sign for which permits may park here."];
            const link = el("a", "pop-link", "Live counts in UTA Parking Finder"); link.href = D.LINKS.parkingFinder; link.target = "_blank"; link.rel = "noopener";
            shape.bindPopup(popupHTML(garage ? garage.name : "UTA parking", lines, link));
            if (garage) shape.bindTooltip(garage.name.replace(/ \(.*\)/, ""), { permanent: true, direction: "center", className: `garage-tip${garage.id.startsWith("cp-") ? " cp" : ""}${garage.id === "cp-central" ? " cp-main" : ""}` });
            shape.addTo(layers.parking);
            if (garage) parkingShapes[garage.id] = shape;
            parkingBounds = parkingBounds ? parkingBounds.extend(shape.getBounds()) : shape.getBounds();
        });
    }
    // The three College Park garages sit side by side: zoomed out they share
    // one label, zoomed in each gets its own.
    function updateGarageLabels() {
        if (!map) return;
        const close = map.getZoom() >= 17;
        map.getContainer().classList.toggle("garages-far", !close);
        const central = parkingShapes["cp-central"];
        if (central && central.getTooltip()) central.setTooltipContent(close ? "College Park Central" : "College Park garages");
    }
    if (map) map.on("zoomend", updateGarageLabels);
    function renderParkingPanel() {
        const n = (window.MP_PARKING_AREAS || []).length;
        $("parking-count").textContent = `${n} UTA parking areas are shaded blue on the map. Darker blue with a label means a garage. Tap any area for details.`;
        const list = $("garage-list");
        list.innerHTML = "";
        D.PARKING.forEach(g => {
            const b = el("button", "garage-row"); b.type = "button";
            const ic = el("span", "garage-icon"); ic.innerHTML = svg("parking");
            const txt = el("span", "garage-text");
            txt.append(el("strong", null, g.name), el("span", null, g.who));
            b.append(ic, txt);
            b.addEventListener("click", () => {
                if (!map) return;
                if (!map.hasLayer(layers.parking)) document.querySelector('.filter-chip[data-layer="parking"]').click();
                document.querySelector(".main-content").scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
                const shape = parkingShapes[g.id];
                if (shape) { map.flyToBounds(shape.getBounds(), { maxZoom: 18, duration: reduceMotion ? 0 : 0.8 }); setTimeout(() => shape.openPopup(), reduceMotion ? 0 : 850); }
            });
            list.appendChild(b);
        });
        const zones = $("zone-list");
        zones.innerHTML = "";
        D.PARKING_ZONES.forEach(z => {
            const row = el("div", `zone-row zone-${z.id}`);
            row.append(el("strong", null, z.name), el("span", null, z.places));
            zones.appendChild(row);
        });
        $("parking-finder").href = D.LINKS.parkingFinder;
        $("parking-fit").addEventListener("click", () => {
            if (!map || !parkingBounds) return;
            if (!map.hasLayer(layers.parking)) document.querySelector('.filter-chip[data-layer="parking"]').click();
            document.querySelector(".main-content").scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
            map.flyToBounds(parkingBounds, { padding: [12, 12], duration: reduceMotion ? 0 : 0.8 });
        });
    }
    // Shuttle layer: live TripShot route lines + moving buses when the
    // relay is configured; otherwise the stops from UTA's schedule.
    const busMarkers = new Map();
    function busIcon(color, bearing, stale) {
        return L.divIcon({
            className: "mp-marker",
            html: `<span class="bus-mk${stale ? " stale" : ""}" style="--route:${color}"><span class="bus-arrow" style="transform:rotate(${bearing}deg)"></span>${svg("bus", "mi")}</span>`,
            iconSize: [30, 30], iconAnchor: [15, 15]
        });
    }
    function tweenMarker(m, to) {
        const from = m.getLatLng();
        if (reduceMotion || from.distanceTo(to) > 1500) { m.setLatLng(to); return; }
        const t0 = performance.now(), dur = 1200;
        const step = t => {
            const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
            m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
            if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }
    let shuttleBase = null;
    function drawShuttleLayer() {
        if (!map) return;
        const live = state.live && state.live.ok ? Object.values(state.live.routes) : null;
        if (!live) {
            if (shuttleBase === "static") return;
            layers.shuttles.clearLayers(); busMarkers.clear(); shuttleBase = "static";
            const seen = new Map();
            D.ROUTES.forEach(r => r.stops.forEach(st => {
                if (!seen.has(st.name)) seen.set(st.name, { ...st, routes: [] });
                seen.get(st.name).routes.push(r.name);
            }));
            seen.forEach(st => {
                L.marker([st.lat, st.lng], { icon: dot("shuttles", "") })
                    .bindPopup(popupHTML(st.name, [`MavMover: ${st.routes.join(", ")}`, "Shown at the named building; exact stop may differ."])).addTo(layers.shuttles);
            });
            return;
        }
        if (shuttleBase !== "live") {
            layers.shuttles.clearLayers(); busMarkers.clear(); shuttleBase = "live";
            live.forEach(r => {
                if (r.path.length > 1) L.polyline(r.path, { color: r.color, weight: 4, opacity: 0.55, interactive: false }).addTo(layers.shuttles);
                r.stops.forEach(st => L.circleMarker([st.lat, st.lng], { radius: 4, color: r.color, weight: 2, fillColor: "#fff", fillOpacity: 1 })
                    .bindPopup(popupHTML(st.name, [`MavMover ${r.name}`])).addTo(layers.shuttles));
            });
        }
        const seenIds = new Set();
        live.forEach(r => r.buses.forEach(bus => {
            seenIds.add(bus.id);
            const lines = [
                bus.nextStop ? (bus.etaMin === 0 ? `${bus.nextStop}` : `Next: ${bus.nextStop}${bus.etaMin !== null ? ` in ${bus.etaMin} min` : ""}`) : "In service",
                bus.riders !== null ? `${bus.riders}${bus.capacity ? ` of ${bus.capacity}` : ""} riders on board` : "",
                bus.delayed ? "Running behind schedule" : "", bus.stale ? "Position may be out of date" : ""
            ].filter(Boolean);
            const pop = popupHTML(`${r.name} · ${bus.name}`, lines);
            let m = busMarkers.get(bus.id);
            if (!m) {
                m = L.marker([bus.lat, bus.lng], { icon: busIcon(r.color, bus.bearing, bus.stale), zIndexOffset: 1500 }).bindPopup(pop).addTo(layers.shuttles);
                busMarkers.set(bus.id, m);
            } else {
                m.setIcon(busIcon(r.color, bus.bearing, bus.stale));
                m.setPopupContent(pop);
                tweenMarker(m, [bus.lat, bus.lng]);
            }
        }));
        busMarkers.forEach((m, id) => { if (!seenIds.has(id)) { layers.shuttles.removeLayer(m); busMarkers.delete(id); } });
        updateMapFooter();
    }

    // Live MavMover data through the MavPulse relay (relay/worker.js).
    const RELAY = (window.MAVPULSE_SHUTTLE_RELAY || "").replace(/\/$/, "");
    state.live = { ok: false, routes: {}, at: 0 };
    const liveKey = name => { const k = String(name || "").toLowerCase().split(/\s+/)[0]; return k === "shopping" ? "green" : k; };
    let liveBusy = false;
    async function loadLive() {
        if (!RELAY || liveBusy || document.visibilityState === "hidden") return;
        liveBusy = true;
        try {
            const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
            const list = await (await fetch(`${RELAY}/v1/p/shared/route?includePreviousDayRidesSpanningMidnight=true&startDay=${day}&endDay=${day}&regionId=${D.LINKS.tripshotRegion}`)).json();
            const ids = (list.routes || []).map(r => (r.InternalRoute || r).routeId).filter(Boolean);
            const details = await Promise.all(ids.map(id => fetch(`${RELAY}/v3/p/shared/route/${id}?day=${day}&breakupExactLoops=true&includePreviousDayRidesSpanningMidnight=true`).then(r => r.ok ? r.json() : null).catch(() => null)));
            const routes = {};
            details.forEach(dj => { const r = MP.parseTripShotRoute(dj, Date.now()); if (r) routes[liveKey(r.name)] = r; });
            if (!Object.keys(routes).length) throw new Error("No routes returned");
            state.live = { ok: true, routes, at: Date.now() };
        } catch (e) {
            console.warn("Live MavMover data unavailable", e);
            state.live = { ...state.live, ok: Object.keys(state.live.routes).length > 0 && Date.now() - state.live.at < 120000 };
        } finally { liveBusy = false; }
        drawShuttleLayer();
        renderRoutes();
    }
    // Poll fast only while someone is looking at buses.
    function scheduleLive() {
        if (!RELAY) return;
        const watching = currentView === "transit" || (map && map.hasLayer(layers.shuttles));
        setTimeout(async () => { await loadLive(); scheduleLive(); }, watching ? 15000 : 60000);
    }
    function drawStudyLayer() {
        if (!map) return;
        layers.study.clearLayers();
        D.STUDY_SPOTS.forEach(s => {
            const st = studyState(s);
            L.marker([s.lat, s.lng], { icon: dot("study", "") })
                .bindPopup(popupHTML(s.name, [studyLabel(s, st)])).addTo(layers.study);
        });
    }
    let detourBounds = null;
    function drawCrossingLayer() {
        if (!map) return;
        layers.crossings.clearLayers();
        detourBounds = null;
        const cs = crossingStates();
        const hit = cs.filter(c => c.state !== "clear");
        // The train itself: a red band along the track between the outermost
        // affected crossings (the line runs nearly straight east–west here).
        if (hit.length) {
            const ordered = cs.slice().sort((x, y) => x.lng - y.lng);
            const iA = ordered.findIndex(c => c.state !== "clear");
            const iB = ordered.length - 1 - ordered.slice().reverse().findIndex(c => c.state !== "clear");
            const seg = ordered.slice(iA, iB + 1).map(c => [c.lat, c.lng]);
            if (seg.length === 1) seg.push([seg[0][0] + 0.00005, seg[0][1] + 0.0012]), seg.unshift([seg[0][0] - 0.00005, seg[0][1] - 0.0012]);
            L.polyline(seg, { color: "#fff", weight: 13, opacity: 0.9, interactive: false }).addTo(layers.crossings);
            L.polyline(seg, { color: "#d62f0d", weight: 8, opacity: 0.95, dashArray: "16 6", className: "train-band" })
                .bindPopup(popupHTML("Train on the tracks", [`Reported at ${hit.filter(c => c.state !== "likely").map(c => c.name).join(", ")}`, "Union Pacific freight trains can be over 2 km long, so nearby crossings are likely blocked too."]))
                .addTo(layers.crossings);
        }
        // Detour for each crossing someone actually reported (not "likely").
        const seenVia = new Set();
        hit.filter(c => c.state !== "likely").forEach(c => {
            const d = window.MP_DETOURS && window.MP_DETOURS.DETOURS[c.id];
            if (!d) return;
            L.polyline(d.path, { color: "#fff", weight: 10, opacity: 0.95, interactive: false }).addTo(layers.crossings);
            const line = L.polyline(d.path, { color: "#1e8e5a", weight: 6, opacity: 1, className: "detour-line" })
                .bindPopup(popupHTML(`Detour around ${c.name}`, [`Through the ${d.via.name}, which a train can't block`, `About ${(d.meters / 1609).toFixed(1)} mi`]))
                .addTo(layers.crossings);
            detourBounds = detourBounds ? detourBounds.extend(line.getBounds()) : line.getBounds();
            detourBounds.extend([d.via.lat - 0.0012, d.via.lng]); // room for the underpass label
            if (!seenVia.has(d.via.name)) {
                seenVia.add(d.via.name);
                L.marker([d.via.lat, d.via.lng], { icon: dot("underpass", svg("check", "mi")), zIndexOffset: 1200 })
                    .bindTooltip(`Open: ${d.via.name}`, { permanent: true, direction: "bottom", className: "underpass-tip", offset: [0, 12] })
                    .bindPopup(popupHTML(d.via.name, ["Goes under/over the tracks, so trains never block it."]))
                    .addTo(layers.crossings);
            }
        });
        cs.forEach(c => {
            const cls = c.state === "clear" ? "crossing-clear" : c.state === "likely" ? "crossing-likely" : "crossing-blocked";
            const lines = [c.state === "clear" ? "No train reported"
                : c.state === "likely" ? `Likely blocked: train reported at ${c.cause}, ${(c.distanceM / 1000).toFixed(1)} km away`
                : `${c.state === "confirmed" ? "Blocked, confirmed" : "Reported blocked"} · ${MP.minutesAgo(c.lastAt, now())}`];
            if (c.state !== "clear") lines.push(c.detour);
            const m = L.marker([c.lat, c.lng], { icon: dot(cls, svg("train", "mi")), zIndexOffset: c.state === "clear" ? 0 : 1000 })
                .bindPopup(popupHTML(`${c.name} rail crossing`, lines)).addTo(layers.crossings);
            if (c.state !== "clear") m.bindTooltip(c.state === "confirmed" ? "BLOCKED" : c.state === "likely" ? "LIKELY" : "REPORTED", { permanent: true, direction: "top", className: `blocked-tip ${c.state}`, offset: [0, -10] });
        });
    }
    function showDetour() {
        switchView("map");
        if (!map.hasLayer(layers.crossings)) document.querySelector('.filter-chip[data-layer="crossings"]').click();
        setTimeout(() => { if (detourBounds) map.flyToBounds(detourBounds, { padding: [16, 16], duration: reduceMotion ? 0 : 0.8 }); }, 150);
    }
    function drawClosureLayer(closures) {
        if (!map) return;
        layers.closures.clearLayers();
        closures.forEach(c => {
            const kind = (D.CLOSURE_KINDS.find(k => k.id === c.kind) || {}).label || "Closure";
            L.marker([c.lat, c.lng], { icon: dot("closures", "!") })
                .bindPopup(popupHTML(kind, [c.label, `${MP.minutesAgo(c.at, now())} · ${c.reporterCount} reporter${c.reporterCount === 1 ? "" : "s"}`]))
                .addTo(layers.closures);
        });
    }

    // ======================================================================
    //  CROSSINGS (Home list + Report buttons + alerts)
    // ======================================================================
    const prevCrossing = {};
    // Reports per crossing, then the long-train rule spreads "likely blocked"
    // to neighbours within a train's length (logic.spreadTrain).
    function crossingStates() {
        return MP.spreadTrain(D.CROSSINGS.map(c => ({ ...c, ...MP.crossingState(allReports(), c.id, now()) })));
    }
    function renderCrossings() {
        const list = $("crossing-list");
        list.innerHTML = "";
        crossingStates().forEach(c => {
            const changed = prevCrossing[c.id] !== undefined && prevCrossing[c.id] !== c.state;
            prevCrossing[c.id] = c.state;
            const row = el("div", `signal-row ${c.state}${changed && !reduceMotion ? " changed" : ""}`);
            const lamp = el("span", "lamp"); lamp.setAttribute("aria-hidden", "true");
            const left = el("div", "crossing-left");
            left.appendChild(el("div", "crossing-name", c.name));
            const sub = c.state === "clear" ? "Clear"
                : c.state === "likely" ? `Likely blocked · same train as ${c.cause}`
                : c.state === "confirmed" ? `Blocked, confirmed by ${c.reporters} · ${MP.minutesAgo(c.lastAt, now())}`
                : `1 report · ${MP.minutesAgo(c.lastAt, now())} · needs one more`;
            left.appendChild(el("div", "crossing-sub", sub));
            const reportable = c.state === "clear" || c.state === "likely";
            const btn = el("button", "row-btn " + (reportable ? "" : "ok"), reportable ? (c.state === "likely" ? "Confirm" : "Train here") : "It's clear");
            btn.type = "button";
            btn.setAttribute("aria-label", `${reportable ? "Report a train at" : "Mark clear:"} ${c.name}`);
            btn.addEventListener("click", () => reportCrossing(c.id, reportable ? "blocked" : "clear"));
            row.append(lamp, left, btn);
            list.appendChild(row);
        });

        // Big alert cards for blocked crossings (replaces the old hardcoded card)
        const alerts = $("crossing-alerts");
        alerts.innerHTML = "";
        const allCs = crossingStates();
        const likelyNames = allCs.filter(c => c.state === "likely").map(c => c.name);
        allCs.filter(c => c.state === "reported" || c.state === "confirmed").forEach(c => {
            const card = el("div", "orange-card" + (c.state === "reported" ? " unconfirmed" : ""));
            const badge = el("div", "card-badge");
            badge.innerHTML = '<span class="pulse-dot"></span>';
            badge.append(c.state === "confirmed" ? " Crossing blocked now" : " Unconfirmed report");
            card.appendChild(badge);
            card.appendChild(el("h3", null, `${c.name} rail crossing`));
            const sim = state.simReports.some(r => r.targetId === c.id) ? " (simulated)" : "";
            card.appendChild(el("p", null, `${c.state === "confirmed" ? `Confirmed by ${c.reporters} commuters` : "One commuter reported a train"} · ${MP.minutesAgo(c.lastAt, now())}${sim}.${likelyNames.length ? ` Long train: ${likelyNames.join(", ")} likely blocked too.` : ""} ${c.detour}.`));
            const actions = el("div", "card-actions");
            const show = el("button", "btn-dark", "Show detour"); show.type = "button";
            show.addEventListener("click", showDetour);
            const same = el("button", "btn-outline", c.state === "confirmed" ? "It's clear now" : "I see it too"); same.type = "button";
            same.addEventListener("click", () => reportCrossing(c.id, c.state === "confirmed" ? "clear" : "blocked"));
            actions.append(show, same);
            card.appendChild(actions);
            alerts.appendChild(card);
        });

        // Report tab: one big button per crossing
        const grid = $("report-crossing-grid");
        grid.innerHTML = "";
        crossingStates().forEach(c => {
            const b = el("button", "big-btn " + (c.state === "clear" ? "" : c.state === "likely" ? "is-likely" : "is-blocked"));
            b.type = "button";
            b.appendChild(el("span", "big-btn-title", c.name));
            const reportable = c.state === "clear" || c.state === "likely";
            b.appendChild(el("span", "big-btn-sub", c.state === "likely" ? "Likely blocked · tap to confirm" : reportable ? "Tap: train here" : "Tap: it's clear"));
            b.addEventListener("click", () => reportCrossing(c.id, reportable ? "blocked" : "clear"));
            grid.appendChild(b);
        });
    }

    async function submit(report, okMsg) {
        if (!MP.canReport(allReports(), state.uid, report.type, report.targetId, now())) {
            toast("You already reported this. You can report it again in 2 minutes.", "warn");
            return false;
        }
        try {
            const tapped = lastTap;
            await store.addReport({ ...report, reporterId: state.uid, at: now() });
            celebrate(tapped, MP.RULES.POINTS_PER_REPORT);
            toast(okMsg, "ok");
            return true;
        } catch (e) {
            console.error(e);
            toast("Report not sent. Check your connection and tap again.", "warn");
            return false;
        }
    }
    function reportCrossing(id, status) {
        const c = D.CROSSINGS.find(x => x.id === id);
        submit({ type: "crossing", targetId: id, status, label: c.name, lat: c.lat, lng: c.lng },
            status === "blocked" ? `Thanks! ${c.name} reported blocked.` : `Thanks! ${c.name} marked clear.`);
    }

    // GPS helpers
    function withLocation(cb) {
        if (!navigator.geolocation) { toast("Location isn't available in this browser."); return; }
        toast("Finding your location…");
        navigator.geolocation.getCurrentPosition(
            pos => cb({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => toast("Couldn't get your location. Pick from the list instead."),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    }
    $("report-crossing-near").addEventListener("click", () => withLocation(p => {
        const n = MP.nearest(p, D.CROSSINGS);
        if (!n || n.meters > 3000) { toast("You're not near a campus rail crossing."); return; }
        if (confirm(`Report a train at the ${n.item.name} crossing (${n.meters} m away)?`)) reportCrossing(n.item.id, "blocked");
    }));

    // ======================================================================
    //  CLOSURES (picker, zero typing)
    // ======================================================================
    const kindGrid = $("closure-kind-grid");
    D.CLOSURE_KINDS.forEach(k => {
        const b = el("button", "chip", k.label); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
        b.addEventListener("click", () => {
            state.pickedClosureKind = k.id;
            kindGrid.querySelectorAll(".chip").forEach(x => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-checked", String(on)); });
        });
        kindGrid.appendChild(b);
    });
    const placeSel = $("closure-place");
    D.PLACES.forEach(p => { const o = el("option", null, p.name); o.value = p.id; placeSel.appendChild(o); });
    function setPickedPlace(p) {
        state.pickedPlace = p;
        let opt = placeSel.querySelector('option[value="__picked"]');
        if (p && !D.PLACES.some(x => x.id === p.id)) {
            if (!opt) { opt = el("option"); opt.value = "__picked"; placeSel.insertBefore(opt, placeSel.children[1]); }
            opt.textContent = p.name; placeSel.value = "__picked";
        } else if (p) placeSel.value = p.id;
    }
    function nearestPlaceName(lat, lng) { const n = MP.nearest({ lat, lng }, D.PLACES); return n ? n.item.name : "campus"; }
    placeSel.addEventListener("change", () => {
        if (placeSel.value === "__picked") return;
        state.pickedPlace = D.PLACES.find(p => p.id === placeSel.value) || null;
    });
    $("closure-use-gps").addEventListener("click", () => withLocation(p => {
        setPickedPlace({ id: "gps", name: `Near ${nearestPlaceName(p.lat, p.lng)} (my location)`, lat: p.lat, lng: p.lng });
        toast("Location set.");
    }));
    let pickingOnMap = false;
    $("closure-pick-map").addEventListener("click", () => {
        pickingOnMap = true;
        document.body.classList.add("picking");
        switchView("map");
        toast("Tap the map where the closure is.");
    });
    $("closure-submit").addEventListener("click", async () => {
        const msg = $("closure-msg");
        const r = MP.createClosureReport(state.pickedPlace, state.pickedClosureKind, state.uid, now());
        if (!state.pickedClosureKind) { msg.textContent = "Pick what kind of issue it is."; return; }
        if (!r) { msg.textContent = "Pick a location (list, GPS, or map)."; return; }
        msg.textContent = "";
        if (await submit(r, "Closure posted for everyone.")) {
            state.pickedClosureKind = null; state.pickedPlace = null; placeSel.value = "";
            kindGrid.querySelectorAll(".chip").forEach(x => { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); });
        }
    });

    function emptyState(icon, text, actionLabel, onAction) {
        const box = el("div", "empty-state");
        const ic = el("span", "empty-icon"); ic.innerHTML = svg(icon);
        box.append(ic, el("p", null, text));
        if (actionLabel) {
            const b = el("button", "pill-btn", actionLabel); b.type = "button";
            b.addEventListener("click", onAction);
            box.appendChild(b);
        }
        return box;
    }
    function renderClosures() {
        const list = $("closure-list");
        const closures = MP.activeClosures(allReports(), now());
        drawClosureLayer(closures);
        list.innerHTML = "";
        if (!closures.length) { list.appendChild(emptyState("check", "No closures reported in the last 12 hours.", "Report a closure", () => switchView("report"))); return; }
        closures.forEach(c => {
            const card = el("article", "report-card");
            const kind = (D.CLOSURE_KINDS.find(k => k.id === c.kind) || {}).label || "Closure";
            const meta = el("div", "weather-meta");
            meta.append(el("span", null, kind), el("span", null, MP.minutesAgo(c.at, now())));
            card.append(meta, el("h4", null, c.label), el("p", null, `${c.reporterCount} commuter${c.reporterCount === 1 ? "" : "s"} reported this`));
            const row = el("div", "row-btns");
            const same = el("button", "pill-btn ok", "Still there"); same.type = "button";
            same.addEventListener("click", () => submit({ ...MP.createClosureReport({ id: c.targetId, name: c.label, lat: c.lat, lng: c.lng }, c.kind, state.uid, now()) }, "Thanks for confirming."));
            const mapBtn = el("button", "pill-btn", "Map"); mapBtn.type = "button";
            mapBtn.addEventListener("click", () => { switchView("map"); if (map) map.setView([c.lat, c.lng], 17); });
            row.append(same, mapBtn);
            if (store.isAdmin || c.reporterId === state.uid) {
                const rm = el("button", "pill-btn danger", store.isAdmin ? "Remove (admin)" : "Remove mine"); rm.type = "button";
                rm.addEventListener("click", () => {
                    const ids = allReports().filter(x => x.type === "closure" && x.targetId === c.targetId && x.kind === c.kind && (store.isAdmin || x.reporterId === state.uid)).map(x => x.id);
                    Promise.all(ids.map(id => store.removeReport(id))).then(() => toast("Removed.")).catch(() => toast("Couldn't remove it."));
                });
                row.appendChild(rm);
            }
            card.appendChild(row);
            list.appendChild(card);
        });
    }

    // ======================================================================
    //  STUDY SPOTS
    // ======================================================================
    function studyState(s) {
        const rep = MP.latestStatus(allReports(), "study", s.id, now(), MP.RULES.STUDY_TTL_MS);
        return MP.studyStatus(rep, now());
    }
    function studyLabel(s, st) {
        return st.source === "live"
            ? `${st.status === "busy" ? "Busy" : "Open"} · reported ${MP.minutesAgo(st.at, now())}`
            : "No report in the last hour";
    }
    let studyOnlyOpen = false;
    document.querySelectorAll("[data-study-filter]").forEach(btn => btn.addEventListener("click", () => {
        studyOnlyOpen = btn.dataset.studyFilter === "open";
        document.querySelectorAll("[data-study-filter]").forEach(b => {
            const on = b === btn; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
        });
        renderStudy();
    }));
    function renderStudy() {
        const list = $("study-list");
        list.innerHTML = "";
        let shown = 0;
        D.STUDY_SPOTS.forEach(s => {
            const st = studyState(s);
            if (studyOnlyOpen && !(st.source === "live" && st.status === "open")) return;
            shown += 1;
            const card = el("div", "study-card" + (st.source === "live" ? " has-live-report" : ""));
            card.appendChild(el("div", "card-title-main", s.name));
            const label = el("div", "study-status " + (st.source === "live" ? st.status : "none"), studyLabel(s, st));
            card.appendChild(label);
            const row = el("div", "study-report-row");
            row.appendChild(el("span", "study-report-prompt", "Here now?"));
            [["busy", "It's busy"], ["open", "It's open"]].forEach(([status, text]) => {
                const b = el("button", "study-report-btn", text); b.type = "button";
                b.addEventListener("click", () => submit({ type: "study", targetId: s.id, status, label: s.name, lat: s.lat, lng: s.lng }, `Thanks! ${s.name} marked ${status}.`));
                row.appendChild(b);
            });
            card.appendChild(row);
            list.appendChild(card);
        });
        if (!shown) list.appendChild(el("p", "study-empty-state", "Nobody has reported an open spot in the last hour. Be the first: tap \"It's open\" where you are."));
    }

    // ======================================================================
    //  SHUTTLES (real MavMover schedule + TripShot link)
    // ======================================================================
    $("tripshot-link").href = D.LINKS.tripshot;
    function renderRoutes() {
        const list = $("route-list");
        const openIds = new Set([...list.querySelectorAll("details[open]")].map(x => x.dataset.route));
        list.innerHTML = "";
        const d = new Date();
        let running = 0, liveBuses = 0;
        D.ROUTES.forEach(r => {
            const st = MP.routeStatus(r, d);
            const live = state.live.ok ? state.live.routes[r.id] : null;
            const buses = live ? live.buses : [];
            liveBuses += buses.length;
            if (st.running || buses.length) running += 1;
            const card = el("details", "route-card" + (st.running || buses.length ? " running" : ""));
            card.dataset.route = r.id;
            if (openIds.has(r.id)) card.open = true;
            const sum = el("summary");
            const badge = el("span", "route-badge"); badge.style.background = (live && live.color) || r.color;
            const status = buses.length ? `${buses.length} bus${buses.length === 1 ? "" : "es"} live` : st.label;
            const statusEl = el("span", "route-status" + (buses.length ? " live" : ""), status);
            sum.append(badge, el("span", "route-name", r.name), statusEl);
            card.appendChild(sum);
            buses.forEach(bus => {
                const row = el("div", "bus-row");
                const ic = el("span", "bus-chip"); ic.style.setProperty("--route", (live && live.color) || r.color); ic.innerHTML = svg("bus", "mi");
                const txt = el("div", "bus-text");
                txt.appendChild(el("strong", null, bus.nextStop ? (bus.etaMin === 0 ? bus.nextStop : `${bus.nextStop}${bus.etaMin !== null ? ` · ${bus.etaMin === 0 ? "now" : bus.etaMin + " min"}` : ""}`) : bus.name));
                txt.appendChild(el("span", null, [bus.name, bus.riders !== null ? `${bus.riders}${bus.capacity ? "/" + bus.capacity : ""} riders` : "", bus.delayed ? "running late" : ""].filter(Boolean).join(" · ")));
                const go = el("button", "pill-btn", "Map"); go.type = "button";
                go.addEventListener("click", () => {
                    if (!map.hasLayer(layers.shuttles)) document.querySelector('.filter-chip[data-layer="shuttles"]').click();
                    switchView("map"); setTimeout(() => { map.flyTo([bus.lat, bus.lng], 17, { duration: reduceMotion ? 0 : 0.8 }); const m = busMarkers.get(bus.id); if (m) setTimeout(() => m.openPopup(), reduceMotion ? 0 : 850); }, 150);
                });
                row.append(ic, txt, go);
                card.appendChild(row);
            });
            const stops = live && live.stops.length ? live.stops : r.stops;
            if (stops.length) {
                const line = el("ol", "route-line");
                line.style.setProperty("--route", (live && live.color) || r.color);
                stops.forEach(stop => line.appendChild(el("li", null, stop.name)));
                card.appendChild(line);
            } else {
                card.appendChild(el("div", "route-stops", "Evening route. Stops are listed in TripShot."));
            }
            list.appendChild(card);
        });
        const when = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        $("transit-updated").textContent = state.live.ok
            ? `Live · ${liveBuses} bus${liveBuses === 1 ? "" : "es"} on the road · updated ${new Date(state.live.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
            : `${running} of ${D.ROUTES.length} routes in service now · ${when}`;
        $("transit-updated").classList.toggle("live", state.live.ok);
        return running;
    }

    // ======================================================================
    //  WEATHER (Open-Meteo, campus by default) + NWS ALERTS (with map areas)
    // ======================================================================
    function weatherIcon(code) {
        if (code === 0 || code === 1) return "sun";
        if (code === 2) return "partly";
        if (code === 3) return "cloud";
        if (code === 45 || code === 48) return "fog";
        if (code >= 71 && code <= 77) return "snow";
        if (code >= 95) return "storm";
        if (code >= 51) return "rain";
        return "partly";
    }
    const WX = {
        0: ["Clear", "☀️"], 1: ["Mainly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
        45: ["Fog", "🌫️"], 48: ["Fog", "🌫️"], 51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Drizzle", "🌧️"],
        61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"], 71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"],
        75: ["Heavy snow", "❄️"], 80: ["Showers", "🌦️"], 81: ["Showers", "🌧️"], 82: ["Heavy showers", "⛈️"],
        95: ["Thunderstorms", "⛈️"], 96: ["Thunderstorms, hail", "⛈️"], 99: ["Thunderstorms, hail", "⛈️"]
    };
    async function loadWeather(fromButton) {
        const btn = $("weather-refresh");
        if (btn.classList.contains("loading")) return;
        btn.classList.add("loading"); btn.disabled = true; btn.setAttribute("aria-busy", "true");
        const started = Date.now();
        const [lat, lng] = D.CAMPUS_CENTER;
        const p = new URLSearchParams({
            latitude: lat, longitude: lng, current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
            daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            temperature_unit: "fahrenheit", wind_speed_unit: "mph", forecast_days: "1", timezone: "America/Chicago"
        });
        try {
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
            if (!res.ok) throw new Error(res.status);
            const d = await res.json();
            const [cond, icon] = WX[d.current.weather_code] || ["Current conditions", ""];
            state.weather = { temp: d.current.temperature_2m, condition: cond, rainChance: d.daily.precipitation_probability_max[0] };
            $("current-weather-icon").innerHTML = svg(weatherIcon(d.current.weather_code));
            $("current-weather-icon").dataset.kind = weatherIcon(d.current.weather_code);
            $("current-temperature").textContent = Math.round(d.current.temperature_2m);
            $("current-condition").textContent = cond;
            $("weather-sub").textContent = `Feels ${Math.round(d.current.apparent_temperature)}° · H ${Math.round(d.daily.temperature_2m_max[0])}° L ${Math.round(d.daily.temperature_2m_min[0])}° · Wind ${Math.round(d.current.wind_speed_10m)} mph · Rain ${d.daily.precipitation_probability_max[0]}%`;
            $("weather-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
            if (fromButton === true) {
                const strip = $("weather-strip");
                strip.classList.remove("refreshed"); void strip.offsetWidth; strip.classList.add("refreshed");
                toast("Weather updated", "ok");
            }
        } catch (e) {
            console.error("Weather unavailable", e);
            $("current-condition").textContent = "Weather unavailable right now";
            if (fromButton === true) toast("Couldn't reach the weather service. Try again in a moment.", "warn");
        } finally {
            // keep the spinner up long enough to read as "it worked"
            setTimeout(() => { btn.classList.remove("loading"); btn.disabled = false; btn.removeAttribute("aria-busy"); }, Math.max(0, 600 - (Date.now() - started)));
        }
        renderBrief();
    }
    $("weather-refresh").addEventListener("click", () => loadWeather(true));

    const NWS = "https://api.weather.gov";
    async function loadNws() {
        try {
            const res = await fetch(`${NWS}/alerts/active?area=TX`, { headers: { Accept: "application/geo+json" } });
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            const features = (data.features || []).filter(f => MP.filterCampusAlerts([f], ["tarrant", "arlington"]).length);
            state.nwsAlerts = MP.filterCampusAlerts(features, ["tarrant", "arlington"]);
            renderNws();
            drawAlertAreas(features);
            features.forEach(f => maybeNotify({ type: "weather", severity: f.properties.severity, key: "wx-" + f.properties.id, title: f.properties.event, body: f.properties.headline || "" }));
        } catch (e) {
            console.error("NWS unavailable", e);
            $("nws-alert-status").textContent = "Live weather alerts are temporarily unavailable.";
        }
        renderBrief();
    }
    function renderNws() {
        const list = $("nws-alert-list");
        list.innerHTML = "";
        const a = state.nwsAlerts;
        $("nws-alert-status").textContent = a.length ? `${a.length} active alert${a.length === 1 ? "" : "s"} for Tarrant County` : "No active NWS alerts for Tarrant County right now.";
        a.forEach(al => {
            const card = el("div", "weather-card nws-alert-card");
            const meta = el("div", "weather-meta");
            meta.append(el("span", null, `${al.severity || "Advisory"} · NWS`), el("span", null, al.event || ""));
            const ends = al.ends || al.expires;
            card.append(meta, el("h4", null, al.headline || al.event), el("p", null, (al.instruction || al.description || "").slice(0, 200) + (ends ? ` Until ${new Date(ends).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.` : "")));
            const mapBtn = el("button", "pill-btn", "See area on map"); mapBtn.type = "button";
            mapBtn.addEventListener("click", () => { switchView("map"); if (map && alertBounds) map.fitBounds(alertBounds, { maxZoom: 11 }); });
            card.appendChild(mapBtn);
            list.appendChild(card);
        });
    }
    let alertBounds = null;
    async function drawAlertAreas(features) {
        if (!map) return;
        layers.alerts.clearLayers();
        alertBounds = null;
        const style = { color: "#d95325", weight: 2, fillOpacity: 0.15 };
        let needCounty = false;
        features.forEach(f => {
            if (f.geometry) {
                const g = L.geoJSON(f.geometry, { style }).bindPopup(popupHTML(f.properties.event, [f.properties.areaDesc]));
                g.addTo(layers.alerts);
                alertBounds = alertBounds ? alertBounds.extend(g.getBounds()) : g.getBounds();
            } else needCounty = true;
        });
        if (needCounty) {
            // Zone-based alerts have no polygon; draw Tarrant County's NWS zone.
            try {
                const z = await (await fetch(`${NWS}/zones/county/TXC439`, { headers: { Accept: "application/geo+json" } })).json();
                const events = features.filter(f => !f.geometry).map(f => f.properties.event).join(", ");
                const g = L.geoJSON(z.geometry, { style }).bindPopup(popupHTML(events, ["Tarrant County (NWS county zone)"]));
                g.addTo(layers.alerts);
                alertBounds = alertBounds ? alertBounds.extend(g.getBounds()) : g.getBounds();
            } catch (e) { console.error("Zone outline unavailable", e); }
        }
        updateMapFooter();
    }

    // ======================================================================
    //  MORNING BRIEF
    // ======================================================================
    function renderBrief() {
        const running = D.ROUTES.filter(r => MP.routeStatus(r, new Date()).running).length;
        const brief = MP.buildBrief({
            weather: state.weather, alerts: state.nwsAlerts,
            crossings: crossingStates().map(c => state.simReports.some(r => r.targetId === c.id) ? { ...c, name: `${c.name} (simulated)` } : c),
            closures: MP.activeClosures(allReports(), now()), routesRunning: running,
            roadWork: state.roadWork ? state.roadWork.length : undefined,
            mavAlerts: state.updates.filter(u => u.kind === "mavalert" && now() - u.at < 24 * 60 * MIN), now: now()
        });
        const card = $("brief-card");
        card.dataset.level = brief.level;
        $("brief-headline").textContent = brief.headline;
        const ul = $("brief-lines");
        ul.innerHTML = "";
        brief.lines.forEach(l => { const li = el("li"); const ic = el("span", "brief-icon"); ic.innerHTML = svg(l.icon); li.append(ic, el("span", null, l.text)); ul.appendChild(li); });
    }

    // ======================================================================
    //  CAMPUS UPDATES (admin-posted)
    // ======================================================================
    function renderUpdates() {
        const mav = $("mavalert-list");
        mav.innerHTML = "";
        state.updates.filter(u => u.kind === "mavalert" && now() - u.at < 24 * 60 * MIN).forEach(u => {
            const card = el("div", "orange-card mavalert-card");
            const badge = el("div", "card-badge"); badge.innerHTML = '<span class="pulse-dot"></span>'; badge.append(" UTA MavAlert · relayed by a verified admin");
            card.append(badge, el("h3", null, u.title), el("p", null, `${u.body} · ${MP.minutesAgo(u.at, now())}`));
            mav.appendChild(card);
        });
        const list = $("update-list");
        list.innerHTML = "";
        if (!state.updates.length) {
            list.appendChild(emptyState("bell", state.mode === "shared" ? "No campus updates right now." : "Campus updates appear when the shared backend is connected."));
            return;
        }
        state.updates.forEach(u => {
            const card = el("article", "report-card admin-update");
            const meta = el("div", "weather-meta");
            meta.append(el("span", null, u.kind === "mavalert" ? "UTA MavAlert (relayed)" : "Verified admin"), el("span", null, MP.minutesAgo(u.at, now())));
            card.append(meta, el("h4", null, u.title), el("p", null, u.body));
            if (store.isAdmin) {
                const rm = el("button", "pill-btn danger", "Remove"); rm.type = "button";
                rm.addEventListener("click", () => store.removeUpdate(u.id).catch(() => toast("Couldn't remove.")));
                card.appendChild(rm);
            }
            list.appendChild(card);
        });
    }

    // ======================================================================
    //  POINTS / MOTIVATION
    // ======================================================================
    function renderPoints() {
        const s = MP.contributorStats(state.weekReports || state.reports, state.uid);
        const board = MP.weeklyLeaderboard(state.weekReports || [], state.profiles, now());
        const mine = board.find(r => r.uid === state.uid);
        const today = MP.activeReports(state.reports, now(), 24 * 60 * MIN);
        const people = new Set(today.map(r => r.reporterId)).size;
        const html = card => {
            card.innerHTML = "";
            const top = el("div", "points-top");
            top.append(el("div", "points-num", String(s.points)), el("div", "points-level", `${s.level}${s.nextLevel ? ` · ${s.toNext} pts to ${s.nextLevel}` : ""}`));
            card.appendChild(top);
            const LEVEL_MIN = { Newcomer: 0, Regular: 50, "Campus Scout": 150, "Pulse Legend": 400 };
            const lo = LEVEL_MIN[s.level] || 0, hi = s.nextLevel ? LEVEL_MIN[s.nextLevel] : s.points || 1;
            const bar = el("div", "points-bar"); const fillEl = el("span");
            fillEl.style.width = `${Math.min(100, Math.round(((s.points - lo) / Math.max(1, hi - lo)) * 100))}%`;
            bar.appendChild(fillEl); card.appendChild(bar);
            card.appendChild(el("div", "points-sub", `${s.reports} report${s.reports === 1 ? "" : "s"} · ${s.confirmed} backed up by another commuter (+5 each)`));
            card.appendChild(el("div", "points-sub", `Community today: ${today.length} report${today.length === 1 ? "" : "s"} from ${people} commuter${people === 1 ? "" : "s"}`));
            if (mine) card.appendChild(el("div", "points-sub rank", `#${mine.rank} on this week's leaderboard`));
            else if (state.mode === "shared" && !(store && store.account)) card.appendChild(el("div", "points-sub rank", "Sign in with your UTA email under Profile to join the weekly leaderboard"));
        };
        html($("points-card"));
        html($("profile-points"));
        renderLeaderboard(board);
    }

    // ======================================================================
    //  WEEKLY LEADERBOARD + OPTIONAL UTA SIGN-IN
    // ======================================================================
    function renderLeaderboard(board) {
        const list = $("leaderboard");
        if (!list) return;
        list.innerHTML = "";
        if (state.mode !== "shared") {
            list.appendChild(el("li", "lb-empty", "The leaderboard appears when the shared backend is connected."));
            return;
        }
        if (!board.length) {
            list.appendChild(el("li", "lb-empty", "Nobody on the board yet this week. Report something and sign in with your UTA email to be first."));
            return;
        }
        const row = r => {
            const li = el("li", `top${r.rank}${r.uid === state.uid ? " me" : ""}`);
            const name = el("div", "lb-name", r.uid === state.uid ? `${r.name} (you)` : r.name);
            name.appendChild(el("small", null, `${r.level} · ${r.reports} report${r.reports === 1 ? "" : "s"}`));
            li.append(el("span", "lb-rank", String(r.rank)), name, el("span", "lb-pts", `${r.points} pts`));
            return li;
        };
        board.slice(0, 10).forEach(r => list.appendChild(row(r)));
        const meIdx = board.findIndex(r => r.uid === state.uid);
        if (meIdx >= 10) { list.appendChild(el("li", "gap", "· · ·")); list.appendChild(row(board[meIdx])); }
    }

    const PENDING_NAME = "mavpulse-pending-name";
    function pendingName(v) {
        try { if (v === undefined) return localStorage.getItem(PENDING_NAME); if (v === null) localStorage.removeItem(PENDING_NAME); else localStorage.setItem(PENDING_NAME, v); }
        catch (e) { return null; }
    }
    function renderAccount() {
        const acct = store && store.account;
        const shared = state.mode === "shared";
        $("account-card").hidden = !shared;
        $("acct-anon").hidden = !!acct;
        $("acct-verify").hidden = !(acct && !acct.verified);
        $("acct-done").hidden = !(acct && acct.verified);
        $("acct-signout").hidden = !acct;
        if (acct && !acct.verified) $("acct-verify-email").textContent = acct.email;
        if (acct && acct.verified) {
            const p = state.profiles[state.uid];
            $("acct-who").textContent = (p && p.name ? p.name + " · " : "") + acct.email;
            if (document.activeElement !== $("profile-name")) $("profile-name").value = (p && p.name) || pendingName() || "";
            $("profile-show").checked = !p || p.show !== false;
        }
    }
    async function afterVerified() {
        const name = pendingName();
        if (name && !state.profiles[state.uid]) {
            try { await store.saveProfile({ name, show: true }); pendingName(null); } catch (e) { /* user can save by hand */ }
        }
    }
    let acctAction = "signup";
    document.querySelectorAll("#acct-form [data-act]").forEach(b => b.addEventListener("click", () => { acctAction = b.dataset.act; }));
    $("acct-form").addEventListener("submit", async e => {
        e.preventDefault();
        const email = $("acct-email").value.trim(), pass = $("acct-pass").value;
        const name = MP.cleanDisplayName($("acct-name").value);
        if (!MP.isUtaEmail(email)) { $("acct-msg").textContent = "Use your @mavs.uta.edu or @uta.edu email."; return; }
        if (acctAction === "signup" && !name) { $("acct-msg").textContent = "Add your first name for the leaderboard."; return; }
        $("acct-msg").textContent = acctAction === "signup" ? "Creating your account…" : "Signing in…";
        try {
            if (acctAction === "signup") {
                pendingName(name);
                await store.utaSignUp(email, pass);
                $("acct-msg").textContent = "Almost there: check your UTA inbox for the link.";
            } else {
                await store.utaSignIn(email, pass);
                if (name) pendingName(name);
                if (store.account && store.account.verified) await afterVerified();
                $("acct-msg").textContent = store.account && store.account.verified ? "Signed in. Your points follow you." : "Signed in. Verify your email to join the board.";
            }
            $("acct-pass").value = "";
            state.uid = store.uid;
        } catch (err) { $("acct-msg").textContent = err.message || "Sign-in failed."; }
        renderAccount(); renderAdmin(); renderAll();
    });
    $("acct-check").addEventListener("click", async () => {
        $("acct-msg").textContent = "Checking…";
        try {
            const ok = await store.checkVerified();
            if (ok) { await afterVerified(); $("acct-msg").textContent = "Verified. You're on the weekly leaderboard."; toast("You're on the leaderboard", "ok"); }
            else $("acct-msg").textContent = "Not verified yet. Tap the link in the email, then try again.";
        } catch (err) { $("acct-msg").textContent = err.message || "Couldn't check right now."; }
        renderAccount(); renderAll();
    });
    $("acct-resend").addEventListener("click", async () => {
        try { await store.resendVerification(); $("acct-msg").textContent = "Sent again. Check Junk too."; }
        catch (err) { $("acct-msg").textContent = err.message; }
    });
    $("profile-form").addEventListener("submit", async e => {
        e.preventDefault();
        try {
            const n = await store.saveProfile({ name: $("profile-name").value, show: $("profile-show").checked });
            pendingName(null);
            $("acct-msg").textContent = $("profile-show").checked ? `Saved. You're on the board as ${n}.` : "Saved. You're hidden from the board.";
        } catch (err) { $("acct-msg").textContent = err.message; }
    });
    $("profile-show").addEventListener("change", () => $("profile-form").requestSubmit());
    $("acct-signout").addEventListener("click", async () => {
        await store.utaSignOut(); state.uid = store.uid;
        $("acct-msg").textContent = "Signed out. You can still report anonymously.";
        renderAccount(); renderAdmin(); renderAll();
    });

    // ======================================================================
    //  NOTIFICATIONS (commuter / quiet / off)
    // ======================================================================
    const MODE_HELP = {
        commuter: "Confirmed train blocks, new closures, and all NWS weather alerts. Never fires on a single unconfirmed tap.",
        quiet: "Only Severe or Extreme NWS weather warnings. Good if you live on campus.",
        off: "No notifications. You can still see everything in the app."
    };
    function renderNotifyMode() {
        document.querySelectorAll("#notify-mode button").forEach(b => {
            const on = b.dataset.mode === state.notifyMode;
            b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); b.setAttribute("role", "radio");
        });
        $("notify-help").textContent = MODE_HELP[state.notifyMode];
    }
    document.querySelectorAll("#notify-mode button").forEach(b => b.addEventListener("click", async () => {
        state.notifyMode = b.dataset.mode;
        savePref("mavpulse-notify-mode", state.notifyMode);
        renderNotifyMode();
        if (state.notifyMode !== "off" && "Notification" in window && Notification.permission === "default") {
            try { await Notification.requestPermission(); } catch (e) { /* older Safari */ }
        }
    }));
    async function maybeNotify(event) {
        if (state.notified.has(event.key)) return;
        if (!MP.shouldNotify(state.notifyMode, event)) return;
        state.notified.add(event.key);
        savePref("mavpulse-notified", JSON.stringify([...state.notified].slice(-200)));
        toast(event.title);
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        try {
            const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
            if (reg) reg.showNotification(event.title, { body: event.body, icon: "icons/icon-192.png", tag: event.key });
            else new Notification(event.title, { body: event.body, icon: "icons/icon-192.png" });
        } catch (e) { console.warn("Notification failed", e); }
    }
    function notifyFromReports() {
        crossingStates().filter(c => c.state === "confirmed").forEach(c => maybeNotify({
            type: "crossing", state: "confirmed", key: `x-${c.id}-${c.since}`,
            title: `Train blocking ${c.name}`, body: `Confirmed by ${c.reporters} commuters. ${c.detour}.`
        }));
        MP.activeClosures(state.reports, now()).filter(c => c.reporterId !== state.uid).forEach(c => maybeNotify({
            type: "closure", key: `c-${c.targetId}-${c.kind}-${Math.floor(c.at / (30 * MIN))}`,
            title: `${(D.CLOSURE_KINDS.find(k => k.id === c.kind) || {}).label || "Closure"}: ${c.label}`, body: "Reported by a commuter on MavPulse."
        }));
    }

    // ======================================================================
    //  TEST MODE: simulate a train (two fake reporters, local only)
    // ======================================================================
    const simSel = $("sim-crossing");
    D.CROSSINGS.forEach(c => { const o = el("option", null, c.name); o.value = c.id; simSel.appendChild(o); });
    simSel.value = "cooper";
    $("sim-train").addEventListener("click", () => {
        const c = D.CROSSINGS.find(x => x.id === simSel.value);
        const t0 = now();
        state.simReports = state.simReports.filter(r => r.targetId !== c.id);
        state.simReports.push({ id: "sim-a-" + t0, type: "crossing", targetId: c.id, status: "blocked", reporterId: "sim-reporter-1", at: t0, label: c.name, lat: c.lat, lng: c.lng });
        $("sim-msg").textContent = "Reporter 1 tapped. Reporter 2 taps in 3 seconds…";
        renderAll();
        setTimeout(() => {
            const t1 = now();
            state.simReports.push({ id: "sim-b-" + t1, type: "crossing", targetId: c.id, status: "blocked", reporterId: "sim-reporter-2", at: t1, label: c.name, lat: c.lat, lng: c.lng });
            renderAll();
            const shownMs = now() - t1;
            $("sim-msg").textContent = `Confirmed. Alert appeared ${shownMs} ms after the second report (requirement: under 30 s). Auto-clears in 60 s.`;
            setTimeout(() => { state.simReports = state.simReports.filter(r => r.targetId !== c.id); renderAll(); $("sim-msg").textContent = "Simulated train cleared."; }, 60 * 1000);
        }, 3000);
        closeSheet();
        switchView("home");
    });

    // ======================================================================
    //  PROFILE SHEET + ADMIN
    // ======================================================================
    function openSheet() {
        const sh = $("profile-sheet"), bd = $("sheet-backdrop");
        sh.hidden = false; bd.hidden = false; renderPoints();
        requestAnimationFrame(() => { sh.classList.add("open"); bd.classList.add("open"); });
    }
    function closeSheet() {
        const sh = $("profile-sheet"), bd = $("sheet-backdrop");
        sh.classList.remove("open"); bd.classList.remove("open");
        setTimeout(() => { sh.hidden = true; bd.hidden = true; }, reduceMotion ? 0 : 260);
    }
    // Swipe the sheet down to close it.
    (() => {
        const sh = $("profile-sheet"); let y0 = null;
        sh.addEventListener("touchstart", e => { if (sh.querySelector(".sheet-body").scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
        sh.addEventListener("touchmove", e => { if (y0 === null) return; const dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
        sh.addEventListener("touchend", e => {
            if (y0 === null) return;
            const dy = e.changedTouches[0].clientY - y0; y0 = null; sh.style.transform = "";
            if (dy > 90) closeSheet();
        });
    })();
    $("open-profile").addEventListener("click", openSheet);
    $("close-profile").addEventListener("click", closeSheet);
    $("sheet-backdrop").addEventListener("click", closeSheet);
    $("admin-volunteer").href = D.LINKS.teamEmail;

    function renderAdmin() {
        $("admin-area").hidden = !!store.isAdmin;
        $("admin-panel").hidden = !store.isAdmin;
        if (store.isAdmin) $("admin-who").textContent = store.adminEmail || "admin";
        if (state.mode !== "shared") $("admin-msg").textContent = "Admin features need the shared backend (currently on-device mode).";
    }
    $("admin-form").addEventListener("submit", async e => {
        e.preventDefault();
        $("admin-msg").textContent = "Signing in…";
        try {
            await store.adminSignIn($("admin-email").value.trim(), $("admin-pass").value);
            state.uid = store.uid; renderAccount();
            $("admin-msg").textContent = "Welcome, admin.";
            $("admin-pass").value = "";
        } catch (err) { $("admin-msg").textContent = err.message || "Sign-in failed."; }
        renderAdmin(); renderAll();
    });
    $("admin-signout").addEventListener("click", async () => {
        await store.adminSignOut(); state.uid = store.uid; $("admin-msg").textContent = "Signed out."; renderAccount(); renderAdmin(); renderAll();
    });
    $("update-form").addEventListener("submit", async e => {
        e.preventDefault();
        try {
            await store.postUpdate({ title: $("update-title").value.trim(), body: $("update-body").value.trim(), kind: $("update-mavalert").checked ? "mavalert" : "update" });
            $("update-form").reset(); $("admin-msg").textContent = "Update posted for everyone.";
        } catch (err) { $("admin-msg").textContent = err.message; }
    });

    // PWA install prompt (Android/desktop Chrome)
    let deferredInstall = null;
    window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; $("install-btn").hidden = false; });
    $("install-btn").addEventListener("click", async () => { if (!deferredInstall) return; deferredInstall.prompt(); deferredInstall = null; $("install-btn").hidden = true; });
    if ("serviceWorker" in navigator && location.protocol === "https:") {
        navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW registration failed", e));
    }


    // ======================================================================
    //  OFFICIAL CITY DATA: road work, UP rail line, police calls, crime
    // ======================================================================
    $("link-mavalert").href = D.LINKS.mavalertSignup;
    $("link-emergency").href = D.LINKS.utaEmergency;
    $("link-hotline").href = D.LINKS.utaEmergencyLine;
    state.roadWork = null;
    async function loadRoadWork() {
        const list = $("roadwork-list");
        try {
            state.roadWork = MP.activeRoadWork(await window.MP_CITY.roadWork(), now());
            if (map) {
                layers.roadwork.clearLayers();
                state.roadWork.forEach(w => w.paths.forEach(path => {
                    L.polyline(path.map(([x, y]) => [y, x]), { color: "#c2410c", weight: 6, opacity: 0.85, dashArray: "8 6" })
                        .bindPopup(popupHTML(`City road work · ${w.kind}`, [w.segments.slice(0, 3).join(", "), `Barricades until ${new Date(w.until).toLocaleDateString([], { month: "short", day: "numeric" })}`, `Permit ${w.permit}`]))
                        .addTo(layers.roadwork);
                }));
            }
            list.innerHTML = "";
            if (!state.roadWork.length) list.appendChild(emptyState("check", "No barricaded city road work near campus right now."));
            state.roadWork.slice(0, 6).forEach(w => {
                const card = el("article", "report-card roadwork-card");
                const meta = el("div", "weather-meta");
                meta.append(el("span", null, `City permit · ${w.kind}`), el("span", null, `until ${new Date(w.until).toLocaleDateString([], { month: "short", day: "numeric" })}`));
                card.append(meta, el("h4", null, [...new Set(w.segments)].slice(0, 2).join(" · ")), el("p", null, w.scope.slice(0, 140)));
                const b = el("button", "pill-btn", "Map"); b.type = "button";
                b.addEventListener("click", () => { switchView("map"); if (map && w.paths[0]) map.setView([w.paths[0][0][1], w.paths[0][0][0]], 17); });
                card.appendChild(b);
                list.appendChild(card);
            });
            if (state.roadWork.length > 6) list.appendChild(el("p", "section-hint", `+${state.roadWork.length - 6} more on the map.`));
        } catch (e) {
            console.error("City road work unavailable", e);
            list.innerHTML = ""; list.appendChild(el("p", "empty-alerts", "City road-work data is temporarily unavailable."));
        }
        renderBrief(); updateMapFooter();
    }
    async function loadRail() {
        if (!map) return;
        try {
            (await window.MP_CITY.railroads()).forEach(f => (f.geometry && f.geometry.paths || []).forEach(path => {
                L.polyline(path.map(([x, y]) => [y, x]), { color: "#374151", weight: 3, opacity: 0.7, dashArray: "2 6", interactive: false }).addTo(layers.rail);
            }));
        } catch (e) { console.warn("Rail line unavailable", e); }
    }
    let safetyLoaded = false;
    const CRIME_COLORS = { Assault: "#b91c1c", Robbery: "#7f1d1d", "Car break-in": "#c2410c", "Vehicle theft": "#ea580c", Burglary: "#a16207", Theft: "#ca8a04", Vandalism: "#6b7280", Drugs: "#7c3aed", Weapons: "#111827", Fraud: "#0e7490", Other: "#64748b" };
    async function loadSafety() {
        if (safetyLoaded) return;
        safetyLoaded = true;
        const card = $("safety-card");
        card.textContent = "Loading Arlington Police Department data…";
        try {
            const [crime, calls] = await Promise.all([window.MP_CITY.crime(30), window.MP_CITY.policeCalls()]);
            const sum = MP.summarizeCrime(crime, now(), 30);
            layers.safety.clearLayers();
            sum.mappable.forEach(c => L.circleMarker([c.lat, c.lng], { radius: 6, color: "#fff", weight: 1, fillColor: CRIME_COLORS[c.category] || "#64748b", fillOpacity: 0.75 })
                .bindPopup(popupHTML(c.category, [new Date(c.at).toLocaleDateString([], { month: "short", day: "numeric" }), "Arlington PD reported offense"])).addTo(layers.safety));
            calls.forEach(f => {
                if (!f.geometry) return;
                const a = f.attributes;
                L.marker([f.geometry.y, f.geometry.x], { icon: dot("police", svg("police", "mi")) })
                    .bindPopup(popupHTML(`Active police call: ${(a.CallTypeDescription || "").toLowerCase()}`, [`${a.Location ? a.Location.trim() + " (block)" : ""}`, `Status: ${a.Status || "n/a"} · ${a.CallDate ? MP.minutesAgo(a.CallDate, now()) : ""}`]))
                    .addTo(layers.safety);
            });
            card.innerHTML = "";
            card.appendChild(el("div", "safety-title", `${sum.total} offenses reported near campus in the last 30 days · ${calls.length} active police call${calls.length === 1 ? "" : "s"} now`));
            const chips = el("div", "safety-chips");
            sum.byCategory.forEach(([name, n]) => { const c = el("span", "safety-chip", `${name} ${n}`); c.style.borderColor = CRIME_COLORS[name] || "#64748b"; chips.appendChild(c); });
            card.appendChild(chips);
            card.appendChild(el("p", "source-note", "Source: City of Arlington Police Department public data (crime updated nightly, calls every 15 min). Incidents handled by UTA Police on campus are not included. Sex offenses and juvenile cases are counted but never pinned on the map, to protect victims. For an emergency call 911."));
            const a = el("a", "text-btn", "Search Arlington crime reports"); a.href = D.LINKS.cityCrimeSearch; a.target = "_blank"; a.rel = "noopener";
            card.appendChild(a);
            updateMapFooter();
        } catch (e) {
            console.error("Safety data unavailable", e);
            safetyLoaded = false;
            card.textContent = "Arlington PD data is temporarily unavailable. Try again in a minute.";
        }
    }

    // ======================================================================
    //  LIVE GPS: blue dot + warnings for hazards near you
    // ======================================================================
    let watchId = null, meMarker = null, meCircle = null, followMe = true, lastHazardKey = "";
    function hazardList() {
        const h = [];
        crossingStates().filter(c => c.state !== "clear").forEach(c => h.push({ lat: c.lat, lng: c.lng, label: `${c.name} rail crossing ${c.state === "confirmed" ? "blocked" : c.state === "likely" ? "likely blocked" : "reported blocked"}`, tip: c.detour }));
        MP.activeClosures(allReports(), now()).forEach(c => h.push({ lat: c.lat, lng: c.lng, label: `${(D.CLOSURE_KINDS.find(k => k.id === c.kind) || {}).label || "Closure"} at ${c.label}` }));
        (state.roadWork || []).forEach(w => { const p = w.paths[0] && w.paths[0][0]; if (p) h.push({ lat: p[1], lng: p[0], label: `City road work: ${w.segments[0] || w.kind}` }); });
        return h;
    }
    function updateHazardBanner(pos) {
        const near = MP.nearbyHazards(pos, hazardList(), 1000);
        const banner = $("hazard-banner");
        if (!near.length) { banner.hidden = true; return; }
        banner.hidden = false;
        banner.innerHTML = "";
        banner.appendChild(el("strong", null, `${near[0].meters} m from you: ${near[0].label}`));
        if (near[0].tip) banner.appendChild(el("div", null, near[0].tip + "."));
        if (near.length > 1) banner.appendChild(el("div", null, `+${near.length - 1} more within 1 km`));
        const key = near[0].label;
        if (key !== lastHazardKey) { lastHazardKey = key; toast(`${near[0].label}, ${near[0].meters} m away`); }
    }
    function onPosition(p) {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        state.myPos = pos;
        if (!meMarker) {
            meMarker = L.marker([pos.lat, pos.lng], { icon: L.divIcon({ className: "mp-marker", html: '<span class="me-dot"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 2000 }).addTo(layers.me);
            meCircle = L.circle([pos.lat, pos.lng], { radius: p.coords.accuracy, color: "#2563eb", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(layers.me);
            map.setView([pos.lat, pos.lng], 16);
        } else {
            meMarker.setLatLng([pos.lat, pos.lng]); meCircle.setLatLng([pos.lat, pos.lng]).setRadius(p.coords.accuracy);
            if (followMe) map.panTo([pos.lat, pos.lng]);
        }
        updateHazardBanner(pos);
    }
    $("locate-btn").addEventListener("click", () => {
        const btn = $("locate-btn");
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId); watchId = null;
            layers.me.clearLayers(); meMarker = meCircle = null; state.myPos = null;
            btn.setAttribute("aria-pressed", "false"); btn.innerHTML = svg("locate") + "<span>Locate me</span>"; $("hazard-banner").hidden = true;
            return;
        }
        if (!navigator.geolocation) { toast("Location isn't available in this browser."); return; }
        btn.setAttribute("aria-pressed", "true"); btn.innerHTML = svg("locate") + "<span>Following you</span>";
        followMe = true;
        watchId = navigator.geolocation.watchPosition(onPosition, err => {
            toast(err.code === 1 ? "Location permission denied. Enable it in your browser settings." : "Couldn't get your location.");
            navigator.geolocation.clearWatch(watchId); watchId = null;
            btn.setAttribute("aria-pressed", "false"); btn.innerHTML = svg("locate") + "<span>Locate me</span>";
        }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    });
    if (map) map.on("dragstart", () => { followMe = false; });

    // ======================================================================
    //  RENDER LOOP
    // ======================================================================
    function renderAll() {
        renderCrossings();
        renderClosures();
        renderStudy();
        renderBrief();
        renderUpdates();
        renderPoints();
        drawCrossingLayer();
        drawParkingLayer();
        drawStudyLayer();
        updateMapFooter();
        if (state.myPos) updateHazardBanner(state.myPos);
    }

    // Launch moment: the crossing lights flash, then the app settles in once.
    const splash = $("splash");
    setTimeout(() => {
        splash.classList.add("done");
        document.body.classList.add("launched");
        moveGlider("home");
        setTimeout(() => document.body.classList.add("settled"), 1200);
        setTimeout(() => splash.remove(), 500);
    }, reduceMotion ? 0 : 1100);

    // Static/first paint before the store connects.
    drawShuttleLayer();
    drawParkingLayer();
    updateGarageLabels();
    renderParkingPanel();
    renderRoutes();
    renderNotifyMode();
    renderAll();
    loadWeather();
    loadNws();
    loadRoadWork();
    loadRail();
    loadLive().then(scheduleLive);

    // Connect the store (shared backend if configured, else on-device).
    const { store: s, info } = await window.MP_STORE.createReportStore(window.MAVPULSE_FIREBASE_CONFIG);
    store = s;
    window.MP_APP = { get store() { return store; }, state };
    state.uid = info.uid;
    state.mode = info.mode;
    const pill = $("sync-pill");
    pill.textContent = info.mode === "shared" ? "● Live · shared" : "● On-device";
    pill.classList.toggle("shared", info.mode === "shared");
    $("about-note").textContent = info.mode === "shared"
        ? "Reports sync live to every MavPulse user through the shared backend."
        : "On-device mode: reports are saved in this browser only (shared backend not configured or unreachable).";
    store.onReports(list => { state.reports = list; renderAll(); notifyFromReports(); });
    if (info.mode === "shared") {
        store.onWeekReports(list => { state.weekReports = list; renderPoints(); });
        store.onProfiles(map => { state.profiles = map; renderPoints(); renderAccount(); });
        // Came back from the verification link? Pick it up automatically.
        if (store.account && !store.account.verified) store.checkVerified().then(ok => { if (ok) afterVerified(); renderAccount(); renderAll(); }).catch(() => {});
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && store.account && !store.account.verified) store.checkVerified().then(ok => { if (ok) { afterVerified(); toast("Email verified", "ok"); } renderAccount(); renderAll(); }).catch(() => {});
        });
    }
    renderAccount();
    store.onUpdates(list => {
        state.updates = list; renderUpdates(); renderBrief();
        list.filter(u => u.kind === "mavalert" && now() - u.at < 60 * MIN).forEach(u => maybeNotify({ type: "weather", severity: "Extreme", key: "mav-" + u.id, title: `UTA MavAlert: ${u.title}`, body: u.body }));
    });
    renderAdmin();

    // Keep "x min ago" labels, schedules and expiries fresh.
    setInterval(() => { renderAll(); renderRoutes(); }, 30 * 1000);
    setInterval(loadNws, 5 * 60 * 1000);
    setInterval(loadRoadWork, 30 * 60 * 1000);
    setInterval(() => { if (safetyLoaded && map && map.hasLayer(layers.safety)) { safetyLoaded = false; loadSafety(); } }, 15 * 60 * 1000);
    setInterval(loadWeather, 15 * 60 * 1000);
});
