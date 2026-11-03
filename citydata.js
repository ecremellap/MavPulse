/*
 * City of Arlington open data (official)
 * --------------------------------------
 * Read-only queries against the City's public ArcGIS server
 * (gis2.arlingtontx.gov). No key needed; responses are parsed by the pure
 * functions in logic.js (activeRoadWork, summarizeCrime).
 *   - Right-of-way permits (OD_Transportation layer 9): official road work
 *     with barricade install/remove dates.
 *   - Railroads (OD_Transportation layer 0): the Union Pacific track line.
 *   - Active police calls (PoliceExternal layer 0): updated every 15 min.
 *   - Crime data (PoliceExternal layer 1): reported Group A offenses,
 *     rolling past year. Arlington PD only: incidents handled by UTA
 *     Police on campus are not in this dataset.
 */
(function (root) {
    "use strict";
    const BASE = "https://gis2.arlingtontx.gov/agsext2/rest/services/";
    // Campus and the streets commuters use to reach it.
    const AREA = { xmin: -97.140, ymin: 32.715, xmax: -97.090, ymax: 32.745, spatialReference: { wkid: 4326 } };

    // The City's server does not send CORS headers, so a normal fetch()
    // from github.io is blocked. ArcGIS REST supports JSONP (callback=),
    // which loads the same public JSON through a <script> tag instead.
    let seq = 0;
    function jsonp(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            const cb = `__mpCity${Date.now()}_${seq++}`;
            const script = document.createElement("script");
            const cleanup = () => { delete root[cb]; script.remove(); clearTimeout(timer); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("City GIS timed out")); }, timeoutMs || 15000);
            root[cb] = data => { cleanup(); resolve(data); };
            script.onerror = () => { cleanup(); reject(new Error("City GIS unreachable")); };
            script.src = `${url}&callback=${cb}`;
            document.head.appendChild(script);
        });
    }

    async function query(path, params) {
        const p = new URLSearchParams({
            where: "1=1", geometry: JSON.stringify(AREA), geometryType: "esriGeometryEnvelope", inSR: "4326",
            spatialRel: "esriSpatialRelIntersects", outFields: "*", outSR: "4326", returnGeometry: "true", f: "json",
            ...params
        });
        const data = await jsonp(`${BASE}${path}/query?${p}`);
        if (data.error) throw new Error(data.error.message || "City GIS error");
        return data.features || [];
    }

    function sqlDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

    const CityData = {
        roadWork() {
            return query("OpenData/OD_Transportation/MapServer/9", {
                where: "Status = 'Issued' AND BarricadeInstall IS NOT NULL",
                outFields: "Permit,Status,Sub,ScopeOfWork,ProjectEnd,BarricadeInstall,BarricadeRemove,Segment",
                resultRecordCount: "1000"
            });
        },
        railroads() {
            return query("OpenData/OD_Transportation/MapServer/0", { outFields: "OBJECTID", resultRecordCount: "200" });
        },
        policeCalls() {
            return query("Police/PoliceExternal/MapServer/0", {
                outFields: "CallTypeDescription,CallDate,Location,Status,Priority", resultRecordCount: "500"
            });
        },
        crime(days) {
            const since = Date.now() - days * 24 * 3600 * 1000;
            return query("Police/PoliceExternal/MapServer/1", {
                where: `DateOfOccurrence >= DATE '${sqlDate(since)}'`,
                outFields: "Description,DateOfOccurrence,Juvenile", resultRecordCount: "2000"
            });
        }
    };
    root.MP_CITY = CityData;
})(window);
