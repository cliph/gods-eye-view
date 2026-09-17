// Street View fallback admission for the CCTV frame route. `/api/cctv/frame/:id`
// used to read lat/lon/heading/fov/pitch straight off the query string and
// prefer them over the registered source, so an UNREGISTERED camera id left
// `source` undefined, the upstream fetch no-opped, and control fell through to
// the Street View fallback on purely client-supplied coordinates — an open,
// unmetered, worldwide Street View image proxy billed to the operator's Google
// key (upstream issue #20). These pin what the resolver now admits, both as
// pure policy and through the mounted route with an injected upstream.
//
// The client ALWAYS sends the full pose (src/layers/cctv/source.js frameUrlFor)
// and the calibration gizmo legitimately drives it, so "reject client pose" was
// never an option; the pose is ANCHORED to the registered source instead.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  STREET_VIEW_ANCHOR_RADIUS_M,
  STREET_VIEW_DEFAULT_PER_MIN,
  resolveStreetViewRequest,
  streetViewRateLimiter,
} from '../../server/providers/cctv/streetview.js';
import { clientKey } from '../../server/providers/common/rate-limit.js';

/** A registered catalog source, shaped like `server/providers/cctv/normalize.js` output. */
function registeredSource(patch = {}) {
  return { id: 'austin-1', name: 'Congress Ave', city: 'Austin', lat: 30.2672, lon: -97.7431, headingDeg: 90, fovDeg: 70, pitchDeg: -5, ...patch };
}

/** The query string the client always sends alongside a frame request. */
function poseParams({ lat, lon, heading, fov, pitch } = {}) {
  const params = new URLSearchParams();
  if (lat !== undefined) params.set('lat', String(lat));
  if (lon !== undefined) params.set('lon', String(lon));
  if (heading !== undefined) params.set('heading', String(heading));
  if (fov !== undefined) params.set('fov', String(fov));
  if (pitch !== undefined) params.set('pitch', String(pitch));
  return params;
}

// ─── Admission policy ────────────────────────────────────────────────────────

test('an unregistered camera ID does not reach Street View when the catalog is populated', () => {
  // The open-proxy shape from issue #20: /api/cctv/frame/anything?lat=..&lon=..
  // Every real deployment has sources, so this is the branch that closes.
  const resolved = resolveStreetViewRequest({
    source: undefined,
    params: poseParams({ lat: 48.8584, lon: 2.2945, heading: 10, fov: 90, pitch: 0 }),
  });

  assert.equal(resolved, null, 'an unregistered id with a populated catalog must never spend Street View quota');
});

test('an unregistered camera ID is refused even when the server catalog is empty', () => {
  // An earlier draft carved out "empty catalog means demo mode, allow it". That
  // FAILED OPEN. The austin and caltrans packs are unconditionally enabled
  // (server/providers/cctv/catalog.js LIVE_PACKS), so a server only returns zero
  // sources when loading FAILED — and a failed cold start caches [] for
  // CCTV_SOURCE_CACHE_MS (15 min), during which the carve-out reopened the exact
  // proxy issue #20 reports, on a box whose operator did configure sources.
  // "Empty" is a failure signal here, not a configuration state, so it cannot be
  // the thing that grants permission.
  const resolved = resolveStreetViewRequest({
    source: undefined,
    params: poseParams({ lat: 40.7484, lon: -73.9857, heading: 200, fov: 75, pitch: -3 }),
    catalogEmpty: true,
  });

  assert.equal(resolved, null, 'an empty catalog must not grant Street View to unregistered ids');
});

test('calibration preview regression guard: a client pose inside the anchor radius is honored', () => {
  // The camera calibration gizmo legitimately drives lat/lon/heading/pitch/fov
  // (src/data/cctvGizmo.js -> src/layers/cctv/calibration.js -> model.js) and
  // forces a frame re-fetch. If this test fails, the Street View preview
  // freezes while the 3D viewshed keeps rotating — a silent regression that no
  // error surfaces. This is why the pose is anchored rather than discarded.
  const source = registeredSource();
  const resolved = resolveStreetViewRequest({
    source,
    params: poseParams({ lat: source.lat + 0.005, lon: source.lon + 0.005, heading: 123.5, fov: 55, pitch: -12 }),
  });

  assert.ok(resolved, 'a nudged calibration pose must still resolve');
  assert.equal(resolved.lat, source.lat + 0.005);
  assert.equal(resolved.lon, source.lon + 0.005);
  assert.equal(resolved.heading, 123.5);
  assert.equal(resolved.fov, 55);
  assert.equal(resolved.pitch, -12);
});

test('a client lat/lon beyond the anchor radius of a registered source is refused', () => {
  const source = registeredSource();
  const resolved = resolveStreetViewRequest({
    source,
    params: poseParams({ lat: source.lat + 0.02, lon: source.lon, heading: 0, fov: 80, pitch: 0 }),
  });

  assert.equal(resolved, null, 'a registered id must not become a worldwide Street View proxy');
  // Sized off the furthest reachable calibration pose, hypot(900, 900) = 1272.8 m
  // (see the DIAGONAL test below), not the +/-900 m per-axis clamp.
  assert.equal(STREET_VIEW_ANCHOR_RADIUS_M, 1500);
});

test('the anchor radius admits the client calibration limit and refuses just past its own bound', () => {
  const source = registeredSource({ lat: 0, lon: 0 });
  const metresNorth = (m) => resolveStreetViewRequest({ source, params: poseParams({ lat: m / 111_195, lon: 0 }) });

  assert.ok(metresNorth(900), 'the client-side +/-900 m calibration limit must stay inside the anchor');
  assert.ok(metresNorth(1495));
  assert.equal(metresNorth(1505), null);
});

test('the anchor admits a DIAGONAL drag to the calibration UI limit, not just an axis-aligned one', () => {
  // offsetNorthM and offsetEastM are clamped to +/-900 m INDEPENDENTLY
  // (src/layers/cctv/calibration.js normalizeCalibration) and applied to lat and
  // lon separately (src/layers/cctv/model.js offsetDegrees), so the furthest
  // pose the gizmo can actually produce is hypot(900, 900) = 1272.8 m, not
  // 900 m. A radius that only clears the per-axis limit silently kills the
  // Street View preview on a north-east drag — the exact regression the anchor
  // exists to avoid. Sized off the real diagonal.
  const source = registeredSource({ lat: 0, lon: 0 });
  const offset = (northM, eastM) =>
    resolveStreetViewRequest({
      source,
      params: poseParams({ lat: northM / 111_195, lon: eastM / 111_195 }),
    });

  assert.ok(offset(900, 900), 'a diagonal drag to the UI\'s own limit must still preview');
  assert.ok(
    STREET_VIEW_ANCHOR_RADIUS_M >= Math.hypot(900, 900),
    'the anchor radius must cover the furthest reachable calibration pose',
  );
});

test('a registered source without a usable position cannot anchor a client pose', () => {
  const resolved = resolveStreetViewRequest({
    source: registeredSource({ lat: undefined, lon: undefined }),
    params: poseParams({ lat: 48.8584, lon: 2.2945 }),
  });

  assert.equal(resolved, null, 'no anchor means no way to bound the request');
});

test('out-of-range client coordinates are rejected outright', () => {
  const source = registeredSource();
  for (const bad of [{ lat: 95, lon: source.lon }, { lat: -91, lon: source.lon }, { lat: source.lat, lon: 200 }, { lat: source.lat, lon: -181 }]) {
    assert.equal(resolveStreetViewRequest({ source, params: poseParams(bad) }), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveStreetViewRequest({ source: undefined, params: poseParams({ lat: -91, lon: 0 }) }), null);
  assert.equal(resolveStreetViewRequest({ source: undefined, params: poseParams({}) }), null, 'demo mode still needs a position');
  assert.equal(resolveStreetViewRequest({ source: undefined, params: poseParams({ lat: Number.NaN, lon: Number.NaN }) }), null, 'demo mode has nothing to fall back to');
});

test('an UNPARSABLE coordinate falls back to the registered source rather than being refused', () => {
  // Deliberately distinct from out-of-range. A value that is not a number at
  // all is treated as absent, which is the route's historical behavior and
  // still anchored; a number that names a point off the planet is a malformed
  // request and gets no Street View call at all.
  const source = registeredSource();
  const resolved = resolveStreetViewRequest({ source, params: poseParams({ lat: Number.NaN, lon: Number.NaN }) });
  assert.deepEqual(resolved, { lat: source.lat, lon: source.lon, heading: 90, fov: 70, pitch: -5 });
});

test('heading is normalized and fov/pitch are clamped to the Street View Static API envelope', () => {
  const source = registeredSource();
  const at = (patch) => resolveStreetViewRequest({ source, params: poseParams({ lat: source.lat, lon: source.lon, ...patch }) });

  assert.equal(at({ heading: -30 }).heading, 330);
  assert.equal(at({ heading: 400 }).heading, 40);
  assert.equal(at({ heading: 360 }).heading, 0);
  assert.equal(at({ heading: -720.5 }).heading, 359.5);
  assert.equal(at({ fov: 999 }).fov, 120);
  assert.equal(at({ fov: 1 }).fov, 20);
  assert.equal(at({ fov: 55 }).fov, 55);
  assert.equal(at({ pitch: -90 }).pitch, -40);
  assert.equal(at({ pitch: 90 }).pitch, 20);
  assert.equal(at({ pitch: 11 }).pitch, 11);
});

test('missing pose values fall back to the registered source, then to the historical defaults', () => {
  const source = registeredSource();
  assert.deepEqual(resolveStreetViewRequest({ source, params: poseParams({}) }), { lat: source.lat, lon: source.lon, heading: 90, fov: 70, pitch: -5 });

  const bare = resolveStreetViewRequest({ source: registeredSource({ headingDeg: undefined, fovDeg: undefined, pitchDeg: undefined }), params: poseParams({}) });
  assert.deepEqual(bare, { lat: source.lat, lon: source.lon, heading: 0, fov: 80, pitch: 0 });
});

test('blank and unparsable pose parameters do not override the registered source', () => {
  const source = registeredSource();
  const params = new URLSearchParams({ lat: '', lon: '   ', heading: 'north', fov: 'wide', pitch: 'down' });
  assert.deepEqual(resolveStreetViewRequest({ source, params }), { lat: source.lat, lon: source.lon, heading: 90, fov: 70, pitch: -5 });
});

test('the resolver performs no I/O and holds no state', () => {
  const source = registeredSource();
  const params = poseParams({ lat: source.lat, lon: source.lon, heading: 12, fov: 44, pitch: 3 });
  const first = resolveStreetViewRequest({ source, params });
  assert.deepEqual(resolveStreetViewRequest({ source, params }), first);
  assert.equal(resolveStreetViewRequest.constructor.name, 'Function', 'the resolver is synchronous — no fetch, no env, no clock');
});

// ─── Opt-in limiter ──────────────────────────────────────────────────────────

test('the Street View limiter caps by default, and only an explicit 0 opts out', () => {
  // Issue #20 asks for MANDATORY quota controls before any Street View request.
  // The house convention for GEV_RATELIMIT_* is opt-in/unlimited, but those
  // endpoints are user-initiated; this one is polled by the app itself for every
  // visible camera, so an unset default of "unlimited" would leave the metered
  // branch uncapped on exactly the installs least likely to tune it.
  const previousLimit = process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
  try {
    delete process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
    assert.equal(typeof streetViewRateLimiter({ rebuild: true }), 'function', 'unset env must still cap');
    assert.equal(STREET_VIEW_DEFAULT_PER_MIN, 240);
    process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = '0';
    assert.equal(streetViewRateLimiter({ rebuild: true }), null, 'an explicit 0 is the documented opt-out');
    process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = 'lots';
    assert.equal(typeof streetViewRateLimiter({ rebuild: true }), 'function', 'a typo must not silently disable the cap');

    process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = '2';
    const limiter = streetViewRateLimiter({ rebuild: true });
    assert.equal(typeof limiter, 'function');

    // clientKey reads the real socket peer address; different peers hold
    // separate per-IP windows.
    const viewer = clientKey({ socket: { remoteAddress: '10.0.0.1' } });
    const other = clientKey({ socket: { remoteAddress: '10.0.0.2' } });
    assert.equal(limiter(viewer), true);
    assert.equal(limiter(other), true);
    assert.equal(limiter(viewer), true);
    assert.equal(limiter(viewer), false, 'a third request from one IP inside the window is blocked');
    assert.equal(limiter(other), true, 'other clients keep their own quota');

    process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = '9';
    assert.equal(streetViewRateLimiter(), limiter, 'the limiter is built once and reused so its per-IP window state persists');
  } finally {
    if (previousLimit === undefined) delete process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
    else process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = previousLimit;
    streetViewRateLimiter({ rebuild: true });
  }
});

test('the Street View limiter is a separate budget from the Places limiter', () => {
  // CCTV frames are polled continuously for every visible camera while Places
  // search is user-initiated and occasional; a shared bucket would let ordinary
  // CCTV traffic starve place search.
  const previousStreetView = process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
  const previousGoogle = process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
  try {
    delete process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
    process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '1';
    const limiter = streetViewRateLimiter({ rebuild: true });
    const key = clientKey({ socket: { remoteAddress: '10.0.0.3' } });
    // The Places cap of 1/min must not govern CCTV frames: the CCTV budget is
    // its own, so the second and third frames still pass.
    assert.equal(limiter(key), true);
    assert.equal(limiter(key), true);
    assert.equal(limiter(key), true, 'a 1/min Places cap must not throttle camera frames');
  } finally {
    if (previousStreetView === undefined) delete process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
    else process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = previousStreetView;
    if (previousGoogle === undefined) delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
    else process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = previousGoogle;
    streetViewRateLimiter({ rebuild: true });
  }
});

// ─── Through the mounted route ───────────────────────────────────────────────

const CAMERA = { id: 'austin-1', name: 'Congress Ave', city: 'Austin', lat: 30.2672, lon: -97.7431, headingDeg: 90, fovDeg: 70, pitchDeg: -5 };

/** Collects what a handler wrote, the way a Node ServerResponse would. */
function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

/** Mount the real provider with a configured Google key and record every outbound fetch. */
function mount(t, { sources = [CAMERA], streetViewLimit, googleKey = 'test-street-view-key' } = {}) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
    serverKey: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    browserKey: process.env.GOOGLE_MAPS_API_KEY,
    limit: process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify(sources);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  if (googleKey === null) {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
  } else {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = googleKey;
  }
  if (streetViewLimit === undefined) delete process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN;
  else process.env.GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN = String(streetViewLimit);
  streetViewRateLimiter({ rebuild: true });

  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(Uint8Array.from([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of [
      ['CCTV_SOURCES_JSON', before.json],
      ['CCTV_SOURCES_FILE', before.file],
      ['CCTV_FORCE_AUSTIN', before.austin],
      ['GOOGLE_MAPS_SERVER_API_KEY', before.serverKey],
      ['GOOGLE_MAPS_API_KEY', before.browserKey],
      ['GEV_RATELIMIT_CCTV_STREETVIEW_PER_MIN', before.limit],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    streetViewRateLimiter({ rebuild: true });
  });

  let handler = null;
  const plugin = cctvProxy();
  plugin.configureServer({ middlewares: { use: (_route, fn) => { handler = fn; } } });
  assert.ok(handler, 'the CCTV provider must mount a middleware');

  const call = async (path, remoteAddress = '10.0.0.7') => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers: {}, method: 'GET', socket: { remoteAddress }, on() {} }, res);
    await done;
    return res;
  };
  const health = async (id) => {
    const res = await call('/health');
    return JSON.parse(res.body).cameras.find((camera) => camera.id === id);
  };
  const streetViewCalls = () => requests.filter((url) => url.includes('/maps/api/streetview'));
  return { call, health, streetViewCalls, requests };
}

test('the route refuses to bill Street View for an unregistered camera id', async (t) => {
  const app = mount(t);
  const res = await app.call('/frame/attacker-chosen?lat=48.8584&lon=2.2945&heading=0&fov=90&pitch=0');

  assert.deepEqual(app.streetViewCalls(), [], 'no Google Street View request may be issued');
  assert.equal(res.statusCode, 200, 'the route contract is still "always returns an image"');
  assert.equal(res.headers['Content-Type'], 'image/svg+xml');
  assert.notEqual(res.headers['X-CCTV-Source'], 'streetview');
});

test('the route still serves a Street View frame for a registered camera at its own position', async (t) => {
  const app = mount(t, { sources: [{ ...CAMERA, url: '' }] });
  const res = await app.call(`/frame/${CAMERA.id}?lat=${CAMERA.lat + 0.001}&lon=${CAMERA.lon}&heading=120&fov=60&pitch=-8`);

  const calls = app.streetViewCalls();
  assert.equal(calls.length, 1, 'the calibration preview must still reach Street View');
  assert.match(calls[0], /heading=120/);
  assert.match(calls[0], /fov=60/);
  assert.match(calls[0], /pitch=-8/);
  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
});

test('the route refuses a registered camera dragged far outside its anchor radius', async (t) => {
  const app = mount(t, { sources: [{ ...CAMERA, url: '' }] });
  const res = await app.call(`/frame/${CAMERA.id}?lat=48.8584&lon=2.2945&heading=0&fov=80&pitch=0`);

  assert.deepEqual(app.streetViewCalls(), []);
  assert.equal(res.headers['Content-Type'], 'image/svg+xml');
});

test('a configured Street View cap degrades to the synthetic frame instead of a 429', async (t) => {
  const app = mount(t, { sources: [{ ...CAMERA, url: '' }], streetViewLimit: 1 });
  const first = await app.call(`/frame/${CAMERA.id}?lat=${CAMERA.lat}&lon=${CAMERA.lon}`);
  assert.equal(first.headers['X-CCTV-Source'], 'streetview');

  const second = await app.call(`/frame/${CAMERA.id}?lat=${CAMERA.lat}&lon=${CAMERA.lon}`);
  assert.equal(app.streetViewCalls().length, 1, 'the second frame must not spend quota');
  assert.equal(second.statusCode, 200, 'the camera grid keeps rendering — no 429');
  assert.equal(second.headers['Content-Type'], 'image/svg+xml');

  const entry = await app.health(CAMERA.id);
  assert.equal(entry.status, 'degraded');
  assert.match(entry.message, /rate limit/i, 'the throttle must be visible in the health report');
});

test('a deployment with no Google key never spends limiter budget it cannot use', async (t) => {
  // streetViewFallback returns null immediately when no key is configured
  // (server/providers/cctv.js googleServerApiKey), so charging the per-IP bucket
  // before that check burns a budget no request can ever spend. On a Pinokio
  // install — which now defaults the cap to 240/min — a keyless operator would
  // watch every camera's health read "rate limited" for a provider they never
  // configured, and the real message ("no source configured") would be replaced
  // by a false one.
  const app = mount(t, { sources: [{ ...CAMERA, url: '' }], streetViewLimit: 1, googleKey: null });

  await app.call(`/frame/${CAMERA.id}?lat=${CAMERA.lat}&lon=${CAMERA.lon}`);
  const second = await app.call(`/frame/${CAMERA.id}?lat=${CAMERA.lat}&lon=${CAMERA.lon}`);

  assert.deepEqual(app.streetViewCalls(), [], 'no key means no Street View request either way');
  assert.equal(second.statusCode, 200);
  const entry = await app.health(CAMERA.id);
  assert.doesNotMatch(
    entry.message,
    /rate limit/i,
    'a keyless deployment must not be told it was throttled',
  );
});
