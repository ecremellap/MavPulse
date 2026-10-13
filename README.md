# MavPulse

A single app that brings together everything the UTA community needs to plan
their day — trains, weather, traffic, closures, and parking — so they can get to
campus informed and on time.

MavPulse is the CSE 3311 (Object-Oriented Software Engineering, Fall 2026) team
project for Team 2. This repository holds the Iteration 2 working build.

## What it is

MavPulse is a mobile-style web application. It runs entirely in the browser with
no backend server and no build step, which keeps the prototype easy to run, host,
and demo. The long-term delivery plan is to package this same interface as native
iOS and Android apps (downloadable builds), so the current web build is the
working prototype of the product users will eventually install.

The app has five tabs:

- **Alerts** — the live train-crossing alert, live National Weather Service
  weather alerts for the campus area, crowdsourced closure reporting, dismiss/
  restore, and a "notify me before I arrive" toggle.
- **Map** — a real interactive OpenStreetMap map of campus (Leaflet) with pan/
  zoom, tappable markers, and toggleable Trains / Parking / Shuttles / Closures
  layers.
- **Study** — campus study spots with quiet/group/open-now filters, a
  time-of-day busyness estimate, and crowd "busy/open" reporting that shows a
  live status when someone reports a spot.
- **Weather** — live current conditions and today's forecast for the user's
  location, in Fahrenheit.
- **Transit** — campus shuttle routes with filters and a refresh.

## Live data sources

Two features use real, live data pulled directly in the browser:

- **Weather** — the [Open-Meteo API](https://open-meteo.com/) provides current
  conditions and the daily forecast for the user's geolocated position. No API
  key is required.
- **Weather alerts** — the [U.S. National Weather Service API](https://www.weather.gov/documentation/services-web-api)
  (`api.weather.gov`) provides active watches and warnings, filtered to the UTA
  campus area (Tarrant County / Arlington). No API key is required.

Train, parking, and shuttle figures are representative sample data in this
iteration; wiring those to live feeds is planned for a later iteration.

Study-spot busyness has no public live feed, so it is shown as an estimate from
a typical weekday pattern (scaled per spot by a busyness factor) and can be
overridden by a user crowd-report ("busy" / "open") for up to an hour, the same
crowdsourcing model the app uses for train crossings.

Road closures likewise have no free public in-browser feed, so they are
**crowdsourced**: commuters report a closure on the Alerts tab and it appears in
the community feed. The app has no backend yet, so reports are stored in the
reporter's own browser (`localStorage`); syncing reports across users is a
planned backend step (e.g. Firebase).

The map is a real interactive map (Leaflet + OpenStreetMap tiles). The Leaflet
library is vendored under `vendor/leaflet/`, so the app has no external CDN
dependency.

## How to run the app

No installation or build is needed.

**Option A — open the file directly:** download the repository and open
`index.html` in any modern browser (Chrome, Safari, Edge, Firefox).

**Option B — run a local server** (recommended, so geolocation and the live APIs
work reliably):

```bash
# from the repository root
python3 -m http.server 8000
# then open http://localhost:8000 in your browser
```

When the Weather tab asks for location permission, allow it to see live local
conditions.

## How to run the tests

The project ships a small, dependency-free test suite covering its core logic
(the train-crossing confirmation rule, the study-spot estimate and crowd-report logic, the closure-report validation, and the
weather-alert filtering).

**In a terminal (no install required):**

```bash
node tests.js
```

Expected output ends with `16 / 16 tests passed`.

**In a browser:** open `tests.html` and read the pass/fail report on the page.

## Repository layout

```
index.html      the app markup (the five tabs)
style.css       all styling
script.js       all app logic, including the live-data integrations and the map
tests.js        the test suite (runs in Node or the browser)
tests.html      browser runner for the test suite
vendor/leaflet  the Leaflet map library, vendored locally (no CDN)
demo/           a standalone copy of the app for quick demos
```

## Team

Team 2 — Kanishkar Manoj, Enzo Cremella, Prashant Shrestha.
Course: CSE 3311, University of Texas at Arlington, Dr. Christoph Csallner.

## Third-party material

Weather data by Open-Meteo. Weather-alert data by the U.S. National Weather
Service (public domain). Generative AI tools were used to help build and document
parts of this project, per the CSE 3311 policy on generative AI.
