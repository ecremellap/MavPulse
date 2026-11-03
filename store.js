/*
 * MavPulse report storage
 * -----------------------
 * The UI talks to ONE interface, ReportStore, and never to a database
 * directly (information hiding). Two implementations:
 *
 *   FirebaseReportStore  Shared, real-time store (Google Firebase:
 *                        Firestore + Authentication). Every user sees every
 *                        report within about a second. Regular users get an
 *                        anonymous account automatically (no sign-up, but a
 *                        stable reporter id so the two-reporter rule works).
 *                        Admins sign in with email + password; admin rights
 *                        come from an /admins/{uid} document that only the
 *                        team can create in the Firebase console, and the
 *                        Firestore security rules (firestore.rules) enforce it.
 *
 *   LocalReportStore     Fallback when no Firebase config is present or the
 *                        network fails: same interface, reports live in this
 *                        browser (and sync live between tabs on one device).
 *
 * ReportStore contract (duck-typed, JS has no interface keyword):
 *   init() -> Promise<{ mode: "shared"|"local", uid }>
 *   onReports(cb)            cb(reports[]) on every change
 *   addReport(report)        -> Promise
 *   removeReport(id)         -> Promise
 *   onUpdates(cb)            admin-posted campus updates
 *   postUpdate({title,body}) -> Promise   (admins only)
 *   removeUpdate(id)         -> Promise   (admins only)
 *   adminSignIn(email, pw)   -> Promise<{ isAdmin }>
 *   adminSignOut()           -> Promise
 */
(function (root) {
    "use strict";

    const WINDOW_MS = 12 * 60 * 60 * 1000;

    // ------------------------------------------------------------------
    class LocalReportStore {
        constructor(storage) {
            this.storage = storage || root.localStorage;
            this.mode = "local";
            this.KEY = "mavpulse-reports-v3";
            this.UPDATES_KEY = "mavpulse-updates-v3";
            this.reportListeners = [];
            this.updateListeners = [];
            this.isAdmin = false;
        }
        async init() {
            let uid = this._get("mavpulse-uid");
            if (!uid) { uid = "local-" + Math.random().toString(36).slice(2, 10); this._set("mavpulse-uid", uid); }
            this.uid = uid;
            if (root.addEventListener) {
                root.addEventListener("storage", e => {
                    if (e.key === this.KEY) this._emitReports();
                    if (e.key === this.UPDATES_KEY) this._emitUpdates();
                });
            }
            return { mode: this.mode, uid };
        }
        _get(k) { try { return this.storage.getItem(k); } catch (e) { return null; } }
        _set(k, v) { try { this.storage.setItem(k, v); } catch (e) { /* storage full or blocked */ } }
        _read(k) { try { const v = JSON.parse(this._get(k) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
        _reports() { const now = Date.now(); return this._read(this.KEY).filter(r => now - r.at <= WINDOW_MS); }
        _emitReports() { const list = this._reports(); this.reportListeners.forEach(cb => cb(list)); }
        _emitUpdates() { const list = this._read(this.UPDATES_KEY); this.updateListeners.forEach(cb => cb(list)); }
        onReports(cb) { this.reportListeners.push(cb); cb(this._reports()); }
        onUpdates(cb) { this.updateListeners.push(cb); cb(this._read(this.UPDATES_KEY)); }
        async addReport(report) {
            const list = this._reports();
            list.push({ ...report, id: "l-" + report.at + "-" + Math.random().toString(36).slice(2, 6) });
            this._set(this.KEY, JSON.stringify(list));
            this._emitReports();
        }
        async removeReport(id) {
            this._set(this.KEY, JSON.stringify(this._reports().filter(r => r.id !== id)));
            this._emitReports();
        }
        async postUpdate() { throw new Error("Campus updates need the shared backend."); }
        async removeUpdate() { throw new Error("Campus updates need the shared backend."); }
        async adminSignIn() { throw new Error("Admin sign-in needs the shared backend."); }
        async adminSignOut() { this.isAdmin = false; }
    }

    // ------------------------------------------------------------------
    const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Could not load " + src));
            document.head.appendChild(s);
        });
    }

    class FirebaseReportStore {
        constructor(config) { this.config = config; this.mode = "shared"; this.isAdmin = false; this.adminEmail = null; }

        async init() {
            await loadScript(SDK + "firebase-app-compat.js");
            await Promise.all([loadScript(SDK + "firebase-auth-compat.js"), loadScript(SDK + "firebase-firestore-compat.js")]);
            const fb = root.firebase;
            this.app = fb.apps.length ? fb.app() : fb.initializeApp(this.config);
            this.auth = fb.auth();
            this.db = fb.firestore();
            const user = await new Promise(resolve => {
                const stop = this.auth.onAuthStateChanged(u => { stop(); resolve(u); });
            });
            if (!user) await this.auth.signInAnonymously();
            await this._refreshRole();
            return { mode: this.mode, uid: this.uid };
        }

        async _refreshRole() {
            const u = this.auth.currentUser;
            this.uid = u ? u.uid : null;
            this.adminEmail = u && !u.isAnonymous ? u.email : null;
            this.isAdmin = false;
            if (u && !u.isAnonymous) {
                try { this.isAdmin = (await this.db.collection("admins").doc(u.uid).get()).exists; }
                catch (e) { this.isAdmin = false; }
            }
        }

        onReports(cb) {
            const since = Date.now() - WINDOW_MS;
            this.db.collection("reports").where("at", ">=", since).orderBy("at", "desc").limit(500)
                .onSnapshot(snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
                    err => console.error("Report feed error", err));
        }
        onUpdates(cb) {
            this.db.collection("updates").orderBy("at", "desc").limit(10)
                .onSnapshot(snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
                    err => console.error("Updates feed error", err));
        }
        async addReport(report) {
            const clean = {};
            ["type", "targetId", "status", "kind", "label", "lat", "lng", "reporterId", "at"].forEach(k => {
                if (report[k] !== undefined && report[k] !== null) clean[k] = report[k];
            });
            clean.reporterId = this.uid;
            await this.db.collection("reports").add(clean);
        }
        async removeReport(id) { await this.db.collection("reports").doc(id).delete(); }
        async postUpdate({ title, body, kind }) {
            if (!this.isAdmin) throw new Error("Only admins can post campus updates.");
            await this.db.collection("updates").add({
                title: String(title).slice(0, 80), body: String(body).slice(0, 280),
                at: Date.now(), author: this.adminEmail || "admin",
                kind: kind === "mavalert" ? "mavalert" : "update"
            });
        }
        async removeUpdate(id) { await this.db.collection("updates").doc(id).delete(); }
        async adminSignIn(email, password) {
            await this.auth.signInWithEmailAndPassword(email, password);
            await this._refreshRole();
            if (!this.isAdmin) {
                await this.adminSignOut();
                throw new Error("This account is not on the admin list yet.");
            }
            return { isAdmin: true };
        }
        async adminSignOut() {
            await this.auth.signOut();
            await this.auth.signInAnonymously();
            await this._refreshRole();
        }
    }

    // Pick the shared store when configured, else fall back to local.
    async function createReportStore(config) {
        if (config && config.apiKey && config.projectId) {
            try {
                const store = new FirebaseReportStore(config);
                const info = await Promise.race([
                    store.init(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Backend timeout")), 8000))
                ]);
                return { store, info };
            } catch (e) {
                console.warn("Shared backend unavailable, using on-device mode.", e);
            }
        }
        const store = new LocalReportStore();
        return { store, info: await store.init() };
    }

    root.MP_STORE = { LocalReportStore, FirebaseReportStore, createReportStore };
    if (typeof module !== "undefined" && module.exports) module.exports = root.MP_STORE;
})(typeof window !== "undefined" ? window : globalThis);
