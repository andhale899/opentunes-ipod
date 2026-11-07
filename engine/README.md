# Engine

The iPod database engine: libgpod compiled to WebAssembly, plus the pieces it needs. Status and plan are in [../docs/ENGINE-BUILD.md](../docs/ENGINE-BUILD.md). **No build exists in this repo yet**; the prebuilt files below come from v1.

| Folder | What it holds |
| --- | --- |
| `src/` | The C wrapper (`ipod_manager.c`) and thread stubs, unchanged from v1. The wrapper tags every track as audio. |
| `prebuilt/` | `ipod_manager.js` and `.wasm` from v1. Cannot be regenerated. See [prebuilt/PROVENANCE.md](prebuilt/PROVENANCE.md). |
| `hashab/` | The hashAB checksum module the nano 6G and 7G need. Origin unknown. |
| `data/` | SysInfoExtended files for the nano 5G and 7G, used when an iPod does not provide its own. |
| `legacy/` | The original build script. Reference only, it points at another person's machine. |
| `build/` | Will hold generated output. Ignored by git. |
