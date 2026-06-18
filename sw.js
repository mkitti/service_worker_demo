// Derive base path from the SW's own URL so this works under any subpath
// e.g. '/' on localhost, '/service_worker_demo/' on GitHub Pages
const SW_BASE = new URL('.', self.location.href).pathname;
const ZARR_PREFIX = SW_BASE + 'zarr/mandelbrot';

// Pyramid: level 0 = finest (~2^263 px), level 255 = coarsest (256 px)
// 256 levels creates the illusion of near-infinite zoom in Neuroglancer.
// Meaningful Mandelbrot detail exists for levels ~211-255 (float64 precision
// limits finer levels to uniform output, but all levels serve valid chunks).
const N_LEVELS  = 32;
const CHUNK_SIZE = 256;
const MAX_ITER   = 255;
const X_MIN = -2.5, X_MAX = 1.0;
const Y_MIN = -1.25, Y_MAX = 1.25;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const {pathname} = new URL(event.request.url);
  if (!pathname.startsWith(ZARR_PREFIX)) return;
  event.respondWith(handleZarr(pathname.slice(ZARR_PREFIX.length)));
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
  };
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: {'Content-Type': 'application/json', ...corsHeaders()},
  });
}

function handleZarr(subpath) {
  const path = subpath.replace(/^\//, '');
  const parts = path === '' ? [] : path.split('/');

  // ── Group root: OME-NGFF 0.5 multiscales metadata ──────────────────────────
  if (path === '' || path === 'zarr.json') {
    return jsonResponse(groupMeta());
  }

  const level = Number(parts[0]);
  if (!Number.isFinite(level) || level < 0 || level >= N_LEVELS) {
    return new Response('Not found', {status: 404, headers: corsHeaders()});
  }

  // ── Array metadata: "{level}/zarr.json" ────────────────────────────────────
  if (parts.length === 2 && parts[1] === 'zarr.json') {
    return jsonResponse(arrayMeta(level));
  }

  // ── Chunk: "{level}/c/0/{cy}/{cx}" ─────────────────────────────────────────
  if (parts.length === 5 && parts[1] === 'c' && parts[2] === '0') {
    const cy = Number(parts[3]);
    const cx = Number(parts[4]);
    if (Number.isFinite(cy) && Number.isFinite(cx)) {
      const t0 = performance.now();
      const data = computeChunk(level, cy, cx);
      const elapsed = (performance.now() - t0).toFixed(1);
      notifyClients(`L${level} chunk ${cy}/${cx} in ${elapsed} ms`);
      return new Response(data, {
        headers: {'Content-Type': 'application/octet-stream', ...corsHeaders()},
      });
    }
  }

  return new Response('Not found', {status: 404, headers: corsHeaders()});
}

// Array size at a given level. Uses Math.pow to avoid 32-bit >> overflow.
// level 0: CHUNK_SIZE * 2^255 ≈ 1.48e79   level 255: CHUNK_SIZE (256)
function levelSize(level) {
  return CHUNK_SIZE * Math.pow(2, N_LEVELS - 1 - level);
}

function groupMeta() {
  return {
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [{
          name: 'mandelbrot',
          axes: [
            {name: 'z', type: 'space', unit: 'nanometer'},
            {name: 'y', type: 'space', unit: 'nanometer'},
            {name: 'x', type: 'space', unit: 'nanometer'},
          ],
          datasets: Array.from({length: N_LEVELS}, (_, k) => ({
            path: String(k),
            coordinateTransformations: [
              // Fixed physical extent: 8192 nm × 8192 nm at all levels.
              // Level 255 (coarsest) = 256 px at 32 nm/px; each finer level halves pixel size.
              // scale[k] = 32 / 2^(255-k) nm/px
              {type: 'scale', scale: [1.0,
                32 / Math.pow(2, N_LEVELS - 1 - k),
                32 / Math.pow(2, N_LEVELS - 1 - k)]},
            ],
          })),
          coordinateTransformations: [
            {type: 'scale', scale: [1.0, 1.0, 1.0]},
          ],
          type: 'gaussian',
        }],
      },
    },
  };
}

function arrayMeta(level) {
  const size = levelSize(level);
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: [1, size, size],
    chunk_grid: {
      name: 'regular',
      configuration: {chunk_shape: [1, CHUNK_SIZE, CHUNK_SIZE]},
    },
    chunk_key_encoding: {name: 'default', separator: '/'},
    fill_value: 0,
    codecs: [{name: 'bytes', configuration: {endian: 'little'}}],
    data_type: 'uint8',
    dimension_names: ['z', 'y', 'x'],
  };
}

function computeChunk(level, cy, cx) {
  const size = levelSize(level);
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const xScale = (X_MAX - X_MIN) / size;
  const yScale = (Y_MAX - Y_MIN) / size;

  for (let py = 0; py < CHUNK_SIZE; py++) {
    const y0 = Y_MIN + (cy * CHUNK_SIZE + py) * yScale;
    for (let px = 0; px < CHUNK_SIZE; px++) {
      const x0 = X_MIN + (cx * CHUNK_SIZE + px) * xScale;
      let x = 0, y = 0, n = 0;
      while (x * x + y * y <= 4 && n < MAX_ITER) {
        const xt = x * x - y * y + x0;
        y = 2 * x * y + y0;
        x = xt;
        n++;
      }
      data[py * CHUNK_SIZE + px] = n;
    }
  }
  return data;
}

async function notifyClients(msg) {
  const clients = await self.clients.matchAll();
  for (const client of clients) {
    client.postMessage({type: 'chunk-served', msg});
  }
}
