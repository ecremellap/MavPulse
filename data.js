/*
 * MavPulse reference data
 * -----------------------
 * Fixed, real-world facts the app is built on. Every coordinate here was
 * checked against OpenStreetMap (Nov 2026):
 *   - Rail crossings: OSM nodes tagged railway=level_crossing on the
 *     "UP Dallas Subdivision" (operator: Union Pacific Railroad).
 *   - Buildings / garages: OSM building and amenity=parking features.
 *   - Numbered student lots: UTA PATS "Parking Lot Addresses" page,
 *     geocoded with OSM Nominatim.
 * MavMover routes, stops and hours come from UTA PATS:
 *   https://www.uta.edu/pats/transportation/mav-mover-shuttles.php
 * Live bus locations are provided by TripShot (uta.tripshot.com); we link
 * to it rather than duplicate it, since TripShot has no public API.
 */
(function (root) {
    "use strict";

    const CAMPUS_CENTER = [32.7310, -97.1135];

    // Union Pacific at-grade crossings closest to campus, west to east.
    const CROSSINGS = [
        { id: "bowen",    name: "Bowen Rd",      lat: 32.73408, lng: -97.14915, detour: "Use the Fielder Rd or Davis Dr crossing" },
        { id: "davis",    name: "Davis Dr",      lat: 32.73788, lng: -97.12325, detour: "Use the Cooper St crossing" },
        { id: "cooper",   name: "Cooper St",     lat: 32.73754, lng: -97.11444, detour: "Use the Davis Dr or Center St crossing" },
        { id: "center",   name: "Center St",     lat: 32.73727, lng: -97.10702, detour: "Use the Cooper St crossing" },
        { id: "mesquite", name: "Mesquite St",   lat: 32.73723, lng: -97.10578, detour: "Use the Cooper St crossing" },
        { id: "collins",  name: "Collins St",    lat: 32.73692, lng: -97.09733, detour: "Use the Cooper St crossing" }
    ];

    // Parking: garages (OSM) + main commuter lots (PATS addresses).
    const PARKING = [
        { id: "maverick-garage",  name: "Maverick Parking Garage", kind: "Garage · visitor & permit", lat: 32.72945, lng: -97.11172 },
        { id: "west-garage",      name: "West Campus Garage",      kind: "Garage · student & visitor", lat: 32.73350, lng: -97.11691 },
        { id: "cp-north",         name: "College Park North Garage", kind: "Garage · student", lat: 32.73315, lng: -97.10769 },
        { id: "cp-central",       name: "College Park Central Garage", kind: "Garage · student & resident", lat: 32.73267, lng: -97.10783 },
        { id: "cp-south",         name: "College Park South Garage", kind: "Garage · student & resident", lat: 32.73172, lng: -97.10781 },
        { id: "lot-26",           name: "Lot 26 (Maverick Stadium)", kind: "Surface lot · student", lat: 32.72617, lng: -97.12569 },
        { id: "lot-27",           name: "Lot 27 (Studio Arts)",    kind: "Surface lot · student", lat: 32.72923, lng: -97.12375 },
        { id: "lot-49",           name: "Lot 49",                  kind: "Surface lot · student", lat: 32.72635, lng: -97.11454 },
        { id: "lot-50",           name: "Lot 50",                  kind: "Surface lot · student", lat: 32.72497, lng: -97.11123 },
        { id: "lot-52",           name: "Lot 52",                  kind: "Surface lot · student", lat: 32.72605, lng: -97.11103 },
        { id: "lot-53",           name: "Lot 53",                  kind: "Surface lot · student", lat: 32.72620, lng: -97.10920 }
    ];

    // Study spaces: positions of the OSM building/library features.
    // MavPulse shows NO occupancy number for these unless a person has
    // reported it in the last hour; there is no public seat-count feed.
    const STUDY_SPOTS = [
        { id: "central-library", name: "UTA Central Library", lat: 32.72970, lng: -97.11295 },
        { id: "science-engineering-library", name: "Science & Engineering Library", lat: 32.73227, lng: -97.11366 },
        { id: "seir", name: "SEIR Building", lat: 32.72808, lng: -97.11385 },
        { id: "nedderman-hall", name: "Nedderman Hall", lat: 32.73226, lng: -97.11392 },
        { id: "university-center", name: "E.H. Hereford University Center", lat: 32.73166, lng: -97.11036 },
        { id: "life-science", name: "Life Science Building", lat: 32.72879, lng: -97.11288 }
    ];

    // Places offered in the closure picker so nobody has to type a street
    // name. Intersections near campus commuters ask about most.
    const PLACES = [
        { id: "cooper-mitchell",   name: "Cooper St at Mitchell St",      lat: 32.72534, lng: -97.11468 },
        { id: "cooper-uta",        name: "Cooper St at UTA Blvd",         lat: 32.73372, lng: -97.11461 },
        { id: "cooper-border",     name: "Cooper St at Border St",        lat: 32.73079, lng: -97.11458 },
        { id: "cooper-abram",      name: "Cooper St at Abram St",         lat: 32.73580, lng: -97.11449 },
        { id: "mitchell-davis",    name: "Mitchell St at Davis Dr",       lat: 32.72540, lng: -97.12348 },
        { id: "mitchell-center",   name: "Mitchell St at Center St",      lat: 32.72530, lng: -97.10700 },
        { id: "uta-blvd-west",     name: "UTA Blvd at West St",           lat: 32.73380, lng: -97.11690 },
        { id: "uta-blvd-center",   name: "UTA Blvd at Center St",         lat: 32.73365, lng: -97.10703 },
        { id: "nedderman-dr",      name: "Nedderman Dr (campus)",         lat: 32.72950, lng: -97.11450 },
        { id: "west-st",           name: "West St at Greek Row Dr",       lat: 32.73050, lng: -97.11695 },
        { id: "abram-center",      name: "Abram St at Center St",         lat: 32.73580, lng: -97.10703 },
        { id: "division-cooper",   name: "Division St at Cooper St",      lat: 32.73960, lng: -97.11438 }
    ];

    const CLOSURE_KINDS = [
        { id: "road-closed",  label: "Road closed" },
        { id: "lane-closed",  label: "Lane closed" },
        { id: "flooding",     label: "Flooding" },
        { id: "accident",     label: "Accident" },
        { id: "construction", label: "Construction" },
        { id: "event",        label: "Event traffic" }
    ];

    // MavMover school-year routes (Mon–Fri). Times are minutes after midnight.
    // Stop markers sit on the OSM building each stop is named after; the
    // exact curb location may differ, and the app says so in the popup.
    const STOP = {
        lot27:   [32.72923, -97.12375], arbor: [32.73044, -97.12056], greek: [32.73019, -97.11718],
        uc:      [32.73166, -97.11036], mac: [32.73195, -97.11735], pe: [32.73099, -97.11782],
        lot26:   [32.72617, -97.12569], mavPlace: [32.72580, -97.12150], m848: [32.72536, -97.11893],
        pickard: [32.72887, -97.11157], business: [32.72967, -97.11051], smart: [32.72774, -97.11165],
        meadow:  [32.73103, -97.12095], swift: [32.73384, -97.12105], timber: [32.73381, -97.11984],
        lot53:   [32.72620, -97.10920], lot52: [32.72605, -97.11103], lot50: [32.72497, -97.11123],
        liv:     [32.72741, -97.10557], arlHall: [32.73109, -97.10937]
    };
    const stop = (name, key) => ({ name, lat: STOP[key][0], lng: STOP[key][1] });

    const ROUTES = [
        { id: "express", name: "Express", color: "#6b7280", start: 450, end: 1080,
          stops: [stop("Lot 27 / Studio Arts", "lot27"), stop("Arbor Oaks", "arbor"), stop("Greek Row", "greek"), stop("University Center", "uc"), stop("MAC", "mac"), stop("P.E. Building", "pe")] },
        { id: "orange", name: "Orange", color: "#ea580c", start: 450, end: 1080,
          stops: [stop("Lot 27 / Studio Arts", "lot27"), stop("Lot 26 / Maverick Stadium", "lot26"), stop("Maverick Place", "mavPlace"), stop("848 Mitchell", "m848"), stop("Pickard Hall", "pickard"), stop("College of Business", "business"), stop("Smart Hospital", "smart")] },
        { id: "blue", name: "Blue", color: "#2563eb", start: 450, end: 1080,
          stops: [stop("University Center", "uc"), stop("MAC", "mac"), stop("Greek Row", "greek"), stop("Meadow Run", "meadow"), stop("Swift Center", "swift"), stop("Timber Brook", "timber")] },
        { id: "black", name: "Black", color: "#111827", start: 450, end: 1080,
          stops: [stop("Lot 53", "lot53"), stop("Lot 52", "lot52"), stop("Lot 50", "lot50"), stop("College of Business", "business")] },
        { id: "yellow", name: "Yellow", color: "#ca8a04", start: 450, end: 1080,
          stops: [stop("Liv+", "liv"), stop("University Center", "uc"), stop("Arlington Hall", "arlHall"), stop("College of Business", "business")] },
        { id: "red", name: "Red (evening)", color: "#dc2626", start: 1080, end: 1260, stops: [] },
        { id: "green", name: "Green (evening)", color: "#16a34a", start: 1110, end: 1350, stops: [] }
    ];

    const LINKS = {
        tripshot: "https://uta.tripshot.com",
        mavmover: "https://www.uta.edu/pats/transportation/mav-mover-shuttles.php",
        parkingFinder: "https://go.uta.edu/park",
        teamEmail: "mailto:krm3798@mavs.uta.edu?subject=MavPulse%20admin%20volunteer",
        mavalertSignup: "https://www.uta.edu/mavalert",
        utaEmergency: "https://www.uta.edu/emergency",
        utaEmergencyLine: "tel:+18662584913",
        utaPoliceNonEmergency: "tel:+18172723381",
        cityCrimeSearch: "https://crimesearch.arlingtontx.gov/"
    };

    const DATA = { CAMPUS_CENTER, CROSSINGS, PARKING, STUDY_SPOTS, PLACES, CLOSURE_KINDS, ROUTES, LINKS };
    root.MP_DATA = DATA;
    if (typeof module !== "undefined" && module.exports) module.exports = DATA;
})(typeof window !== "undefined" ? window : globalThis);
