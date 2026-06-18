# Mandelbrot via Service Worker + Zarr v3

Live demo: **https://mkitti.github.io/service_worker_demo/**

A static web page that uses a JavaScript [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) to synthesize a 256-level multiscale Zarr v3 image of the Mandelbrot set — entirely on the client, with zero pre-rendered data. [Neuroglancer](https://github.com/google/neuroglancer) is embedded as an iframe and treats this virtual dataset like any other remote array store.

---

## How Service Workers make this possible

A **Service Worker** is a script the browser runs in a background thread, separate from the page. Once registered, it acts as a programmable network proxy: it intercepts every `fetch()` made by the page (and same-origin iframes), decides whether to forward the request to the network or synthesize a response in JavaScript, and returns whatever it likes.

The key properties that matter here:

| Property | Why it matters |
|---|---|
| **Same-origin interception** | The SW only intercepts requests to its own origin. That's why Neuroglancer is self-hosted — if it were loaded from neuroglancer-demo.appspot.com, the SW couldn't intercept its chunk requests. |
| **`skipWaiting()` + `clients.claim()`** | The SW activates immediately on install and takes control of all open tabs on the same origin without requiring a page reload. |
| **No server required** | Responses are created with `new Response(data, {headers: ...})` entirely in JavaScript. The "server" is a few hundred lines of math. |
| **Persistent across navigation** | Once registered, the SW intercepts requests from Neuroglancer even though that page was loaded later, in an iframe, with no special setup. |

The fetch handler in `sw.js` intercepts any URL under `./zarr/mandelbrot/` and routes it to one of three handlers:

```
GET ./zarr/mandelbrot/zarr.json          →  OME-NGFF group metadata (JSON)
GET ./zarr/mandelbrot/{level}/zarr.json  →  Zarr v3 array metadata (JSON)
GET ./zarr/mandelbrot/{level}/c/0/{cy}/{cx}  →  computed chunk (binary)
```

Everything else passes through to the network unchanged.

---

## What is Zarr v3?

[Zarr](https://zarr.dev/) is a chunked, compressed, N-dimensional array format designed for cloud storage. Version 3 is the current spec.

An array is described by two things:

1. **`zarr.json`** — metadata: shape, chunk shape, data type, codec pipeline, coordinate transforms.
2. **Chunk files** — raw binary data for each tile, stored at a path derived from the chunk key encoding. For a 3-D array with the default separator, chunk `(0, cy, cx)` lives at `c/0/{cy}/{cx}`.

Because Zarr is designed to be served over HTTP from object storage (S3, GCS, etc.), any HTTP server — real or fake — can serve it. The SW is a fake HTTP server that exists only inside the browser tab.

---

## OME-NGFF 0.5 and multiscale pyramids

[OME-NGFF](https://ngff.openmicroscopy.org/specifications/0.5/) is a community standard for storing microscopy images in Zarr. Its key concept is the **multiscale pyramid**: a group of arrays where each successive level halves the resolution.

The SW serves a Zarr *group* at `./zarr/mandelbrot/` whose root `zarr.json` carries OME-NGFF metadata describing all 256 resolution levels:

```json
{
  "zarr_format": 3,
  "node_type": "group",
  "attributes": {
    "ome": {
      "version": "0.5",
      "multiscales": [{
        "datasets": [
          { "path": "0",   "coordinateTransformations": [{"type":"scale","scale":[1,1,1]}] },
          { "path": "1",   "coordinateTransformations": [{"type":"scale","scale":[1,2,2]}] },
          ...
          { "path": "255", "coordinateTransformations": [{"type":"scale","scale":[1,2²⁵⁵,2²⁵⁵]}] }
        ]
      }]
    }
  }
}
```

Each level `k` is a separate Zarr array with shape `[1, 256·2^(255−k), 256·2^(255−k)]`. Level 0 (finest) has ≈ 2²⁶³ pixels per side; level 255 (coarsest) is 256×256. Neuroglancer reads this metadata and automatically selects the appropriate level as you zoom.

---

## The Mandelbrot computation

Each chunk is computed on demand in the SW thread when Neuroglancer requests it. No data is stored; no pre-computation occurs.

For chunk `(cy, cx)` at level `k`:

```
size  = 256 × 2^(255−k)          // array edge length at this level
xScale = (X_MAX − X_MIN) / size  // nm per pixel in complex-plane x
yScale = (Y_MAX − Y_MIN) / size

for each pixel (py, px) in the 256×256 chunk:
    x0 = X_MIN + (cx·256 + px) · xScale
    y0 = Y_MIN + (cy·256 + py) · yScale
    iterate z ← z² + c  until |z|² > 4, max 255 iterations
    store iteration count as uint8
```

The complex plane spans x ∈ [−2.5, 1.0], y ∈ [−1.25, 1.25] at all levels. Finer levels resolve smaller features at the boundary. Float64 arithmetic limits meaningful detail to roughly levels 211–255 (≈ 45 octaves of genuine fractal zoom); finer levels produce uniform output, but the infrastructure still serves every chunk correctly.

---

## Why 256 levels?

With 256 levels, the zoom ratio between the coarsest and finest level is 2²⁵⁵ ≈ 5.8 × 10⁷⁶. Neuroglancer can zoom in continuously through all 256 levels without hitting a "maximum zoom" limit, creating the illusion of near-infinite detail. The point of this demo is the *infrastructure* — that a service worker + Zarr + OME-NGFF can satisfy a production scientific viewer with arbitrarily deep hierarchies of on-demand computed data.

---

## File structure

```
index.html          Main page: registers SW, embeds Neuroglancer iframe, chunk log
sw.js               Service worker: OME-NGFF metadata + Mandelbrot chunk synthesis
neuroglancer/       Self-hosted Neuroglancer (built from npm package with Vite)
  index.html
  assets/
```

The Neuroglancer build uses the standalone (non-Python) entry point so it works without a server token. It is self-hosted so the SW — scoped to this origin — can intercept all of its `zarr://` requests.

---

## Running locally

```bash
# Any static file server works; Python's is convenient:
python3 -m http.server 8000

# Then open http://localhost:8000/
# (Service workers require a secure context: localhost qualifies automatically.)
```

On the first visit the SW installs and activates; the page reloads itself via `clients.claim()`. On subsequent visits the SW is already active and Neuroglancer loads immediately.

---

## References

- [Service Worker API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Zarr v3 specification](https://zarr-specs.readthedocs.io/en/latest/v3/core/v3.0.html)
- [OME-NGFF 0.5 specification](https://ngff.openmicroscopy.org/specifications/0.5/)
- [Neuroglancer](https://github.com/google/neuroglancer)
