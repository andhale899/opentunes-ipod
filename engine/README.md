# Engine

The iPod database engine: libgpod compiled to WebAssembly, plus the C wrapper the app calls. What it contains, how it is built and what the tests show are in [../docs/ENGINE-BUILD.md](../docs/ENGINE-BUILD.md).

```
npm run engine:build    # Docker build, output in engine/build/
npm run engine:test     # Node tests against that build
```

| Folder | What it holds |
| --- | --- |
| `Dockerfile` | The whole build, with every source pinned by version and SHA-256. |
| `src/` | `ipod_manager.c`, the wrapper (tags every track as audio for now), and `glib_shims.c`. |
| `patches/libgpod/` | Our three changes to libgpod, applied in name order. |
| `meson/` | The cross-compilation file used to build glib. |
| `scripts/` | `build.sh` (Docker build and copy out) and `fetch.sh` (download with a checksum check). |
| `data/` | SysInfoExtended templates for the nano 5G and 7G, for devices that do not carry their own. Device serial numbers are scrubbed and the FireWire ID is a placeholder. |
| `test/` | Node tests, and the hashAB known-answer vectors. |
| `build/` | Generated output. Ignored by git. |
