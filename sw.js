// Derive base path from the SW's own URL so this works under any subpath
// e.g. '/' on localhost, '/service_worker_demo/' on GitHub Pages
const SW_BASE = new URL('.', self.location.href).pathname;
const ZARR_PREFIX = SW_BASE + 'zarr/mandelbrot';
const SHAPE_H = 2048;
const SHAPE_W = 2048;
const CHUNK_H = 256;
const CHUNK_W = 256;
const MAX_ITER = 255;
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

function handleZarr(subpath) {
  const path = subpath.replace(/^\//, '');

  if (path === '' || path === 'zarr.json') {
    const meta = {
      zarr_format: 3,
      node_type: 'array',
      shape: [1, SHAPE_H, SHAPE_W],
      chunk_grid: {
        name: 'regular',
        configuration: {chunk_shape: [1, CHUNK_H, CHUNK_W]},
      },
      chunk_key_encoding: {name: 'default', separator: '/'},
      fill_value: 0,
      codecs: [{name: 'bytes', configuration: {endian: 'little'}}],
      data_type: 'uint8',
      dimension_names: ['z', 'y', 'x'],
    };
    return new Response(JSON.stringify(meta, null, 2), {
      headers: {'Content-Type': 'application/json', ...corsHeaders()},
    });
  }

  // Zarr v3 default chunk key encoding: "c/{z}/{cy}/{cx}"
  const parts = path.split('/');
  if (parts.length === 4 && parts[0] === 'c') {
    const [, z, cy, cx] = parts.map((v, i) => i === 0 ? v : Number(v));
    if (z === 0 && Number.isFinite(cy) && Number.isFinite(cx)) {
      const t0 = performance.now();
      const data = computeChunk(cy, cx);
      const elapsed = (performance.now() - t0).toFixed(1);
      notifyClients(`chunk 0/${cy}/${cx} computed in ${elapsed} ms`);
      return new Response(data, {
        headers: {'Content-Type': 'application/octet-stream', ...corsHeaders()},
      });
    }
  }

  return new Response('Not found', {status: 404, headers: corsHeaders()});
}

function computeChunk(cy, cx) {
  const data = new Uint8Array(CHUNK_H * CHUNK_W);
  const xScale = (X_MAX - X_MIN) / SHAPE_W;
  const yScale = (Y_MAX - Y_MIN) / SHAPE_H;

  for (let py = 0; py < CHUNK_H; py++) {
    const y0 = Y_MIN + (cy * CHUNK_H + py) * yScale;
    for (let px = 0; px < CHUNK_W; px++) {
      const x0 = X_MIN + (cx * CHUNK_W + px) * xScale;
      let x = 0, y = 0, n = 0;
      while (x * x + y * y <= 4 && n < MAX_ITER) {
        const xt = x * x - y * y + x0;
        y = 2 * x * y + y0;
        x = xt;
        n++;
      }
      data[py * CHUNK_W + px] = n; // MAX_ITER (255) means inside set
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
