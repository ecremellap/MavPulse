/*
 * Shared-backend configuration (Firebase web app config).
 * This object is a public identifier, not a secret: what protects the data
 * is firestore.rules. Set it to null to run in on-device mode.
 */
window.MAVPULSE_FIREBASE_CONFIG = {
    apiKey: "AIzaSyAXRL6ZKUbTqYrXMKKtZE8TbnuAED7tK3I",
    authDomain: "mavpulse-2d2fc.firebaseapp.com",
    projectId: "mavpulse-2d2fc",
    storageBucket: "mavpulse-2d2fc.firebasestorage.app",
    messagingSenderId: "940461556707",
    appId: "1:940461556707:web:0df7861df6e88f376e56d6"
};

/*
 * Live MavMover buses: URL of the MavPulse shuttle relay (relay/worker.js
 * deployed on Cloudflare Workers), e.g. "https://mavpulse-relay.<you>.workers.dev".
 * null = show the schedule and link to TripShot instead.
 */
window.MAVPULSE_SHUTTLE_RELAY = "https://mavpulse-relay.kanishkarraam-manoj2004.workers.dev";
