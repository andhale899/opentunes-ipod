# OpenTunes

A Chrome web app that puts music, video and podcasts on a classic iPod without iTunes and without a server. It runs in desktop Chrome and, if your phone's Chrome supports folder access, in Chrome on Android.

Personal project. It is not published or hosted anywhere.

## Status

The project is mid-rebuild, and **nothing syncs yet**. What exists today:

- An environment check page that tells you whether your browser can reach an iPod, and tries USB and folder access against a real one.
- A device registry that records, per iPod model, what it can play and how far each fact can be trusted. Only the nano 7th generation has capability data so far.
- Tested core logic for capability detection and duplicate-song matching.

The plan is in [docs/ROADMAP.md](docs/ROADMAP.md). The first real feature, music sync to an iPod nano 7th generation, is Phase 2 and depends on rebuilding the iPod database engine in Phase 1.

The previous version (a Node server with a downloader) is kept on the `v1-legacy` tag, see [docs/LEGACY.md](docs/LEGACY.md). It no longer ships. YouTube and Spotify downloading is out of scope for now, see [docs/research/spotify-youtube.md](docs/research/spotify-youtube.md).

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
```

## Layout

| Folder | What it holds |
| --- | --- |
| `app/` | The web app (Vite, TypeScript, Preact). |
| `core/` | Pure logic with tests: device registry, capability detection, song identity. |
| `engine/` | The iPod database engine (libgpod compiled to WebAssembly): C wrapper, prebuilt files from v1, build plan. |
| `docs/` | Architecture, roadmap, device support, test guides, research. |

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Device support](docs/DEVICE-SUPPORT.md) (generated)
- [Testing on Android](docs/ANDROID-TESTING.md)
- [Hardware test checklist](docs/HARDWARE-TESTING.md)
- [Building the engine](docs/ENGINE-BUILD.md)
- [Third-party notices](THIRD_PARTY.md)

## Troubleshooting

**`node` fails with `Library not loaded ... libllhttp`.** Homebrew upgraded a library that this Node build links against. Running `brew reinstall node` fixes it.

**Chrome says USB or folder access is unavailable.** Open the environment check page. It names the missing feature and what to do about it. The usual cause on a phone is opening the page over plain `http://` on a local address, which Chrome does not treat as secure.
