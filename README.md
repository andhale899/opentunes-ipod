# OpenTunes

A web app that puts music, video, podcasts and audiobooks on a classic iPod without iTunes and without a server. It is built for any Chromium browser on any OS where the iPod mounts as a drive: macOS, Linux and other Unix, ChromeOS, Android and Windows. Nothing has been tried with a real iPod yet, and Linux may need a udev rule and Windows a WinUSB driver for the USB step. Both are unverified.

Personal project. It is not published or hosted anywhere.

## Status

The project is mid-rebuild, and **nothing syncs yet**. What exists today:

- An environment check page that tells you whether your browser can reach an iPod, and tries USB and folder access against a real one, including how fast Chrome can write to it. It has run once against a real nano 7th generation, see [docs/HARDWARE-TESTING.md](docs/HARDWARE-TESTING.md).
- A **read-only iPod reader**: pick an iPod's folder and the engine, running in the browser, opens its database and shows the model, how the database is signed, whether the signatures iTunes left on its database files match what the engine computes, and your library and playlists. It never writes. Demo iPods let you try it without hardware.
- A **backup** button that copies an iPod's database files (library, device and artwork, no music) to a folder you choose and reads every copy back to check it, and a **rewrite check** that writes the database the way a sync would, only inside the engine's memory, and shows what that would change on the iPod. Both are read only on the iPod. The backup and rewrite check have run on a real nano 7th generation. Below them are a **write-back test**, which writes the rebuilt database (no new songs) to the iPod after a verified backup and puts every file back if anything fails, and a **restore** that checks a backup against its checksums and copies it back. Those two are built and tested against in-memory iPods, not yet run on a real one.
- A device registry that records, per iPod model, what it can play and how far each fact can be trusted. Only the nano 7th generation has capability data so far.
- Tested core logic for capability detection and duplicate-song matching.
- The iPod database engine, rebuilt in Docker from pinned sources, with typed bindings. Its tests create, write and re-read databases for music, movies, music videos, TV shows, podcasts and audiobooks (with chapters), including the signed databases a nano 7th generation needs, with no hardware involved.

The plan is in [docs/ROADMAP.md](docs/ROADMAP.md). The first real feature, music sync to an iPod nano 7th generation, is Phase 2. The engine is ready for it apart from album artwork.

Earlier versions of this project included a downloader. That code and its history are gone from this repository, and nothing here fetches music or video from streaming services: OpenTunes works only with files you already have.

## Run it

You need Node 20 or newer and Chrome.

```
npm install
npm run dev
```

Open http://localhost:5173 in Chrome. To try it from a phone on your Wi-Fi, follow [docs/ANDROID-TESTING.md](docs/ANDROID-TESTING.md).

Other commands:

```
npm run check        # typecheck, tests and build
npm run docs:check   # fails if docs/DEVICE-SUPPORT.md is out of date
npm run engine:build # builds the iPod engine in Docker (needs Docker running)
npm run engine:test  # tests the built engine in Node
npm run smoke        # builds the app and loads the demo iPods in headless Chrome
```

## Layout

| Folder | What it holds |
| --- | --- |
| `app/` | The web app (Vite, TypeScript, Preact): the environment check and the iPod reader. |
| `core/` | Pure logic with tests: device registry, capability detection, song identity. |
| `engine/` | The iPod database engine (libgpod compiled to WebAssembly): C interface, bindings, Docker build, patches, tests. |
| `docs/` | Architecture, roadmap, device support, test guides, research. |

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Device support](docs/DEVICE-SUPPORT.md) (generated)
- [Testing on Android](docs/ANDROID-TESTING.md)
- [Hardware test checklist](docs/HARDWARE-TESTING.md)
- [The engine](docs/ENGINE-BUILD.md)
- [Third-party notices](THIRD_PARTY.md)

## Troubleshooting

**`node` fails with `Library not loaded ... libllhttp`.** Homebrew upgraded a library that this Node build links against. Running `brew reinstall node` fixes it.

**Chrome says USB or folder access is unavailable.** Open the environment check page. It names the missing feature and what to do about it. The usual cause on a phone is opening the page over plain `http://` on a local address, which Chrome does not treat as secure.
