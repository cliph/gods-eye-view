import { haversineKm } from '../common/geo.js';
import { makeOptInRateLimiter, clientKey } from '../common/rate-limit.js';

export { clientKey };

/**
 * How far a client-supplied pose may sit from its registered camera before the
 * Street View fallback refuses it.
 *
 * Sized off the furthest pose the app can actually produce, which is NOT the
 * per-axis clamp. `normalizeCalibration` (`src/layers/cctv/calibration.js`)
 * bounds offsetNorthM and offsetEastM to +/-900 m INDEPENDENTLY, and
 * `offsetDegrees` (`src/layers/cctv/model.js`) applies them to lat and lon
 * separately, so a north-east drag to the UI's own limit lands hypot(900, 900)
 * = 1272.8 m away. A 900 m or 1000 m radius would refuse that pose and freeze
 * the Street View preview mid-calibration while the 3D viewshed kept turning —
 * the silent regression this whole module is shaped to avoid. 1500 m clears the
 * real diagonal with margin and is still far too tight to be useful as a
 * general-purpose Street View proxy.
 */
export const STREET_VIEW_ANCHOR_RADIUS_M = 1500;

/** Street View Static API envelope, and the defaults the route has always used. */
const FOV_MIN = 20;
const FOV_MAX = 120;
const FOV_DEFAULT = 80;
const PITCH_MIN = -40;
const PITCH_MAX = 20;
const PITCH_DEFAULT = 0;
const HEADING_DEFAULT = 0;

/** Read one query parameter from a URLSearchParams or a plain object; blank reads as absent. */
function readParam(params, name) {
  const raw =
    typeof params?.get === 'function' ? params.get(name) : params?.[name];
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text ? text : null;
}

/** First finite candidate, else the supplied fallback. Mirrors the route's historical precedence. */
function firstFinite(candidates, fallback) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (
      candidate !== null &&
      candidate !== undefined &&
      candidate !== '' &&
      Number.isFinite(value)
    )
      return value;
  }
  return fallback;
}

/** Clamp to an inclusive range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Fold any finite bearing into [0, 360). */
function normalizeHeading(value) {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Decide whether `/api/cctv/frame/:id` may spend the operator's Google key on a
 * Street View Static API image, and with what bounded pose.
 *
 * The route used to read lat/lon/heading/fov/pitch off the query string and
 * prefer them over the registered source unconditionally. An unregistered
 * camera id therefore left `source` undefined, the upstream fetch no-opped on
 * an empty URL, and control fell through to Street View on coordinates the
 * caller chose outright — an open, unmetered, worldwide image proxy billed to
 * whoever ran the server (upstream issue #20).
 *
 * Simply ignoring the client pose was never available. The client ALWAYS sends
 * the full pose (`src/layers/cctv/source.js` frameUrlFor) and the calibration
 * gizmo legitimately drives it: a gizmo drag rewrites the camera's
 * lat/lon/heading/pitch/fov and forces a frame re-fetch, so a route that
 * ignored those values would freeze the Street View preview while the 3D
 * viewshed kept rotating — a regression nothing would report. The pose is
 * ANCHORED to the registered source instead: accepted, but only within
 * STREET_VIEW_ANCHOR_RADIUS_M of where the operator registered that camera.
 *
 * An unregistered id is refused outright. An earlier draft carved out "the
 * catalog is empty, so this must be the no-config demo path", which failed
 * open: the austin and caltrans packs are unconditionally enabled
 * (`./catalog.js` LIVE_PACKS), so zero sources does not mean "nothing was
 * configured", it means LOADING FAILED — and a failed cold start caches the
 * empty result for CCTV_SOURCE_CACHE_MS, reopening this very proxy for that
 * window on a server whose operator did configure cameras. A failure signal
 * cannot be what grants permission.
 *
 * The cost is that the client's seeded demo catalog
 * (`src/layers/cctv/lifecycle.js`, `sourceKind:'seed'`, no upstream URL) now
 * renders as the synthetic card rather than Street View. That is already what
 * every operator without a Google key sees, and it degrades visibly rather than
 * silently.
 *
 * This bounds WHICH image may be requested, not how many: the per-IP ceiling is
 * the separate opt-in limiter below, and neither is a billing cap. Provider-side
 * budgets remain the authoritative spend control.
 *
 * Pure by construction — no fetch, no env, no clock — which is what makes the
 * policy testable without a server. Returning `null` is benign: the route falls
 * through to the synthetic SVG it already had, so the contract that this
 * endpoint always answers with an image is preserved.
 *
 * @param {object} input
 * @param {{lat?:number,lon?:number,headingDeg?:number,fovDeg?:number,pitchDeg?:number}|undefined} input.source - The registered catalog source, if the id resolved to one.
 * @param {URLSearchParams|Record<string,string>} input.params - The request's query parameters.
 * @returns {{lat:number,lon:number,heading:number,fov:number,pitch:number}|null} A bounded request, or null to skip Street View entirely.
 */
export function resolveStreetViewRequest({ source, params } = {}) {
  // No registered camera means no anchor, and an unanchored request is exactly
  // the open-proxy shape this exists to refuse. See the note above on why an
  // empty catalog is NOT a licence to skip this.
  if (!source) return null;

  const lat = firstFinite([readParam(params, 'lat'), source?.lat], Number.NaN);
  const lon = firstFinite([readParam(params, 'lon'), source?.lon], Number.NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  if (source) {
    const anchorLat = Number(source.lat);
    const anchorLon = Number(source.lon);
    // A registered camera with no usable position cannot anchor anything, and an
    // unanchored request is the very shape this guard exists to refuse.
    if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon)) return null;
    if (
      haversineKm(anchorLat, anchorLon, lat, lon) * 1000 >
      STREET_VIEW_ANCHOR_RADIUS_M
    )
      return null;
  }

  return {
    lat,
    lon,
    heading: normalizeHeading(
      firstFinite(
        [readParam(params, 'heading'), source?.headingDeg],
        HEADING_DEFAULT,
      ),
    ),
    fov: clamp(
      firstFinite([readParam(params, 'fov'), source?.fovDeg], FOV_DEFAULT),
      FOV_MIN,
      FOV_MAX,
    ),
    pitch: clamp(
      firstFinite(
        [readParam(params, 'pitch'), source?.pitchDeg],
        PITCH_DEFAULT,
      ),
      PITCH_MIN,
      PITCH_MAX,
    ),
  };
}

// Construct lazily after the standalone environment has loaded.
// undefined = not built yet; null = unlimited; fn = active limiter
let _streetViewRateLimiter;

/**
 * Opt-in per-IP ceiling for the CCTV Street View fallback, the one CCTV branch
 * that spends metered Google quota. Null = unlimited (the default), so this is
 * a runtime no-op unless `GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN` is set to a
 * positive integer.
 *
 * Deliberately a SEPARATE budget from `GEV_RATELIMIT_GOOGLE_PER_MIN`: Places
 * search is user-initiated and occasional, while CCTV frames are polled
 * continuously for every visible camera and, in seeded demo mode, every frame
 * is a Street View call. Sharing one bucket would let ordinary CCTV traffic
 * starve place search.
 *
 * Checked only immediately before a Street View call, never on ordinary
 * upstream frames, so working cameras stay unthrottled. A block is NOT a 429 —
 * the route falls through to its synthetic frame and records the throttle in
 * the health report, because the camera grid has to keep rendering.
 *
 * @param {{rebuild?:boolean}} [options] - `rebuild` re-reads the environment; tests use it to isolate cases.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function streetViewRateLimiter({ rebuild = false } = {}) {
  if (rebuild || _streetViewRateLimiter === undefined)
    _streetViewRateLimiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN,
    );
  return _streetViewRateLimiter;
}
