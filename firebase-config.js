/*
 * Shared-backend configuration (Firebase web app config).
 * This object is a public identifier, not a secret: what protects the data
 * is firestore.rules. Set it to null to run in on-device mode.
 */
window.MAVPULSE_FIREBASE_CONFIG = null;

/*
 * Live MavMover buses: URL of the MavPulse shuttle relay (relay/worker.js
 * deployed on Cloudflare Workers), e.g. "https://mavpulse-relay.<you>.workers.dev".
 * null = show the schedule and link to TripShot instead.
 */
window.MAVPULSE_SHUTTLE_RELAY = null;
