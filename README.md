# MavPulse

**Live campus and commute conditions for the UTA community** — rail crossings, closures, weather alerts, parking, study spots and MavMover shuttles in one installable app.

**Live app:** https://ecremellap.github.io/MavPulse/ · **Tests:** https://ecremellap.github.io/MavPulse/tests.html

CSE 3311 (Fall 2026) · Team 2: Kanishkar Manoj, Enzo Cremella, Prashant Shrestha

## Install on your phone (no app store)

MavPulse is a Progressive Web App, so the same code is the phone app and the web-browser version.

- **iPhone:** open the link in Safari → Share → **Add to Home Screen**
- **Android:** open the link in Chrome → ⋮ → **Install app**

It opens full screen like a native app and keeps its app shell offline. We chose this over an iOS App Store listing ($99/year) or an Android-only APK (no iPhone users, "unknown app" warnings).

## What's real in Iteration 3

| Feature | Source | Status |
|---|---|---|
| Rail crossing status (Cooper, Center, Mesquite, Davis, Collins, Bowen) | Crowd reports; positions from OpenStreetMap (UP Dallas Subdivision) | Live, shared |
| Two-reporter confirmation, 20-min expiry, "it's clear" | UC-01 rules in `logic.js` | Live |
| Closures (kind + location from a picker, GPS, or map tap — no typing) | Crowd reports | Live, shared |
| Weather alerts + alert areas on the map | National Weather Service API | Live |
| Current weather for campus | Open-Meteo | Live |
| Parking: real UTA garages and lots, "full / spaces open" reports, link to UTA Parking Finder | UTA PATS + crowd reports | Live, shared |
| Study spots: busy / open status from student reports only (no estimate shown) | Crowd reports | Live, shared |
| MavMover routes, stops, hours, "running now"; one tap to TripShot live bus tracking | UTA PATS schedule + TripShot link | Live |
| Official city road work (barricaded right-of-way permits) on the map and Home | City of Arlington public GIS | Live, refreshed every 30 min |
| Union Pacific track line on the map | City of Arlington public GIS | Live |
| Safety layer: reported offenses (last 30 days) and active police calls near campus | Arlington Police Department public data | Live (crime nightly, calls every 15 min) |
| UTA MavAlert relays (verified admins) + MavAlert sign-up and emergency info links | Admin relay; UTA has no public MavAlert feed | Live, shared |
| Live GPS: blue dot, follow mode, warning when within 1 km of a blocked crossing, closure or road work | Browser geolocation | Live |
| Morning brief | All of the above | Live |
| Notifications: Commuter / Quiet / Off | Browser notifications | Live |
| Contributor points and levels | Crowd reports | Live |
| Admins: post official campus updates, remove bad reports | Firebase Auth + `/admins` allowlist | Live |
| Test mode: simulate a train | Local only | For testing the 30-second requirement |

"Shared" means reports sync to every user in real time through Firebase (Firestore). Without a Firebase config the app runs in on-device mode with the same features.

## Code structure

| File | Role |
|---|---|
| `data.js` | Real reference data (crossings, lots, study spots, places, MavMover routes), all coordinates checked against OpenStreetMap |
| `logic.js` | Every rule as a pure, tested function (confirmation, expiry, anti-spam, schedule, notifications, points, brief) |
| `citydata.js` | Read-only queries to the City of Arlington's public ArcGIS server (road work, rail line, police calls, crime) |
| `store.js` | `ReportStore` interface with two implementations: `FirebaseReportStore` (shared) and `LocalReportStore` (fallback). The UI only knows the interface. |
| `script.js` | UI wiring for the five tabs, map layers and settings |
| `firestore.rules` | Server-side security: report shape validation, only reporters/admins can delete, only admins post updates, nobody can make themselves admin |
| `sw.js`, `manifest.webmanifest` | Installable PWA + offline app shell |
| `tests.js`, `tests.html` | 61 automated tests |

## Run and test

No build step. Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000`.

```
node tests.js        # 61 / 61 tests passed
```

## Shared backend setup (Firebase)

1. Create a Firebase project, enable Firestore and Authentication (Anonymous + Email/Password).
2. Put the web app config in `firebase-config.js`.
3. Paste `firestore.rules` into Firestore → Rules → Publish.
4. To add an admin: create their Email/Password user in Authentication, copy the UID, and create a Firestore document `admins/<UID>`.

## Sources

City of Arlington open GIS data (right-of-way permits, railroads, Arlington PD crime and active calls; UTA Police incidents are not included) · UTA PATS — MavMover routes and parking lot addresses · OpenStreetMap contributors (map tiles, crossing and building positions) · National Weather Service API · Open-Meteo · TripShot (linked, not copied) · Leaflet.

## Use of generative AI

Per the CSE 3311 GenAI policy: parts of this code, tests, and documentation were drafted with Anthropic's Claude and reviewed, tested and edited by the team.
