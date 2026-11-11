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
 *   account                  { email, verified, uta } or null (anonymous)
 *   utaSignUp(email, pw)     link this anonymous account to any email,
 *                            so the uid (and its points) carry over; sends
 *                            a verification email. `uta` stays true for
 *                            @mavs.uta.edu and @uta.edu addresses.
 *   utaSignIn(email, pw)     sign in on another device
 *   resendVerification()     -> Promise
 *   checkVerified()          -> Promise<boolean>  (refreshes the token)
 *   utaSignOut()             back to a fresh anonymous account
 *   onWeekReports(cb)        reports from the last 7 days (leaderboard)
 *   onProfiles(cb)           { uid: { name, show } } for the leaderboard
 *   saveProfile({name,show}) verified email accounts only (firestore.rules)
 */
(function (root) {
    "use strict";

    const WINDOW_MS = 12 * 60 * 60 * 1000;
    // Domain helpers (logic.js); required in Node tests, global in the browser.
    const MPL = () => root.MP || (typeof require !== "undefined" ? require("./logic.js") : {});

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
        get account() { return null; }
        async utaSignUp() { throw new Error("Sign-in needs the shared backend."); }
        async utaSignIn() { throw new Error("Sign-in needs the shared backend."); }
        async resendVerification() { throw new Error("Sign-in needs the shared backend."); }
        async checkVerified() { return false; }
        async utaSignOut() { }
        onWeekReports(cb) { this.reportListeners.push(cb); cb(this._reports()); }
        onProfiles(cb) { cb({}); }
        async saveProfile() { throw new Error("The leaderboard needs the shared backend."); }
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
            this._account = u && !u.isAnonymous && u.email
                ? { email: u.email, verified: !!u.emailVerified, uta: MPL().isUtaEmail(u.email) } : null;
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

        // ---------------- Optional UTA sign-in ----------------
        get account() { return this._account || null; }
        _friendly(e) {
            const map = {
                "auth/email-already-in-use": "That email already has an account. Use Sign in instead.",
                "auth/credential-already-in-use": "That email already has an account. Use Sign in instead.",
                "auth/weak-password": "Pick a password with at least 6 characters.",
                "auth/invalid-email": "That doesn't look like an email address.",
                "auth/wrong-password": "Wrong email or password.",
                "auth/invalid-credential": "Wrong email or password.",
                "auth/invalid-login-credentials": "Wrong email or password.",
                "auth/user-not-found": "No account with that email yet. Use Create account.",
                "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
                "auth/network-request-failed": "No connection. Try again when you're online."
            };
            return new Error(map[e && e.code] || (e && e.message) || "Sign-in failed.");
        }
        async utaSignUp(email, password) {
            email = String(email || "").trim().toLowerCase();
            if (!MPL().isAccountEmail(email)) throw new Error("Enter a valid email address.");
            const fb = root.firebase;
            const cred = fb.auth.EmailAuthProvider.credential(email, password);
            try {
                const u = this.auth.currentUser;
                if (u && u.isAnonymous) await u.linkWithCredential(cred);   // same uid, points carry over
                else await this.auth.createUserWithEmailAndPassword(email, password);
                await this.auth.currentUser.sendEmailVerification();
            } catch (e) { throw this._friendly(e); }
            await this._refreshRole();
            return this.account;
        }
        async utaSignIn(email, password) {
            email = String(email || "").trim().toLowerCase();
            if (!MPL().isAccountEmail(email)) throw new Error("Enter a valid email address.");
            try { await this.auth.signInWithEmailAndPassword(email, password); }
            catch (e) { throw this._friendly(e); }
            await this._refreshRole();
            return this.account;
        }
        async resendVerification() {
            try { await this.auth.currentUser.sendEmailVerification(); } catch (e) { throw this._friendly(e); }
        }
        async checkVerified() {
            const u = this.auth.currentUser;
            if (!u || u.isAnonymous) return false;
            await u.reload();
            if (this.auth.currentUser.emailVerified) await this.auth.currentUser.getIdToken(true); // rules see email_verified
            await this._refreshRole();
            return !!(this._account && this._account.verified);
        }
        async utaSignOut() { await this.adminSignOut(); }
        onWeekReports(cb) {
            const since = Date.now() - MPL().LEADERBOARD_WINDOW_MS;
            this.db.collection("reports").where("at", ">=", since).orderBy("at", "desc").limit(3000)
                .onSnapshot(snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
                    err => console.error("Weekly feed error", err));
        }
        onProfiles(cb) {
            this.db.collection("profiles").limit(1000)
                .onSnapshot(snap => { const m = {}; snap.docs.forEach(d => { m[d.id] = d.data(); }); cb(m); },
                    err => console.error("Profiles feed error", err));
        }
        async saveProfile({ name, show }) {
            const clean = MPL().cleanDisplayName(name);
            if (!clean) throw new Error("Add your first name for the leaderboard.");
            if (!this.account || !this.account.verified) throw new Error("Verify your email first.");
            await this.db.collection("profiles").doc(this.uid).set({
                name: clean, show: show !== false, uta: !!this.account.uta, at: Date.now()
            });
            return clean;
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
