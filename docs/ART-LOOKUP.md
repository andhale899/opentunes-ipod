# Album art: cover pictures and the online lookup

Where a track's cover comes from, and the one optional step that goes online. For the iPod's file format and what is and is not confirmed, see [ARTWORK-RESEARCH.md](ARTWORK-RESEARCH.md).

## Where a cover comes from

For each file that is added, the first of these that exists is used:

1. **The picture inside the file** (an MP3's APIC frame, an MP4's `covr` atom, a FLAC picture block), which the probe already reads.
2. **A cover picture in the file's folder, or the folder above it.** Only when files are added with "Choose a folder". The names are `cover`, `folder`, `front`, `album` and `AlbumArt`, as `.jpg`, `.jpeg` or `.png`, in any case, and in that order of preference. A cover at the top of a whole library is not given to every album below it: only the file's own folder and the one above (for an album with Disc 1 and Disc 2 folders) are looked in.
3. **A cover found online and approved by you** (below).

The list of chosen files shows which one each file has. A picture the browser cannot read is left off with a warning, and the music still goes on. The picture is turned into pixels with Chrome's own decoder and a canvas, then shrunk to the four sizes the iPod wants (240, 58, 57 and 50 pixels) in `engine/js/artwork.ts`. Nothing about this leaves your computer.

"Put cover pictures on the iPod" is a tick box in the Add music step, on by default. Writing cover art has not been tried on a real iPod yet, and the box says so.

## Find missing album art online (optional)

Shown inside "Add music" when some of the chosen files have no cover from steps 1 and 2. It uses two free public services:

- **MusicBrainz** (musicbrainz.org) to find which release an artist and album name mean.
- **The Cover Art Archive** (coverartarchive.org) for that release's front cover. It answers with a redirect to the picture on archive.org.

### What is sent

Only after you tick "Send the artist and album names ... to musicbrainz.org and coverartarchive.org" and press "Find covers":

- To `musicbrainz.org`, one search per album: `GET https://musicbrainz.org/ws/2/release/?query=release:"<album>" AND artist:"<artist>"&fmt=json&limit=10`.
- To `coverartarchive.org`, for the best matching release: `GET https://coverartarchive.org/release/<release id>/front-500`, and the browser follows the redirect to a host under `archive.org`. If a release has no cover, up to two more releases are tried.

The artist is the album artist when the file has one, otherwise the artist. Albums with no artist or no album name are not looked up. Nothing else is sent: no file names, no other tags, no audio, no list of your library, no cookies (`credentials: omit`), and the page's address only as an origin (`referrerPolicy: origin`). Like any web request, the services see your computer's address.

### Rate limit and identification

- MusicBrainz documents an average of one request a second per address and answers 503 above that. The lookup keeps its MusicBrainz requests 1.1 seconds apart, and after a 503 waits three seconds and tries once more, then leaves that album. The Cover Art Archive says it has no rate limit; the lookup still waits a quarter of a second between its requests.
- MusicBrainz asks every application to send a meaningful `User-Agent` with a contact address. **A web page cannot set that header** (Chrome ignores it), so this lookup cannot send one. The only identification is what the browser sends itself: its own User-Agent, the origin and the address of the page. The requests worked in a test (below), but this is a gap against what MusicBrainz asks for, and it is one reason to keep the lookup opt-in, one album at a time, and slow.
- MusicBrainz says non-commercial use of its web service is free.

### What was tested

On 2026-11-07, from headless Chrome on a page at `http://127.0.0.1`, five real requests, a second apart, for one well known public album:

- The MusicBrainz release search with `fmt=json` answered 200 and Chrome let the page read it (CORS allows browser calls). The answer is `{created, count, offset, releases: [...]}`, each release with `id`, `title`, `score`, `status`, `date` and `artist-credit`.
- `https://coverartarchive.org/release/<id>` (the listing) answered 200 through a redirect to `<host>.ca.archive.org/.../index.json`, readable by the page. Its image addresses begin `http://coverartarchive.org/`, which a page served over https could not fetch, so the lookup does not use them.
- `https://coverartarchive.org/release/<id>/front-500` answered 200 through a redirect to `<host>.ca.archive.org`, as a JPEG the page could read and decode. The host in the redirect changes, so any host under `archive.org` is accepted and nothing else.
- A release id that does not exist answers 404.

The tests in `app/test/art-lookup.test.ts` and the smoke test use a fake `fetch` and never call these services. Not tried: many albums in a row, a service that is down or blocked, or what the Cover Art Archive does when it throttles.

### What you see, and what changes

The step shows the picture it found next to each album, with the MusicBrainz release it came from, all ticked. Nothing is added to the list of files, and nothing goes on the iPod, until you press "Use the ticked covers". The Cover Art Archive says its images are freely accessible, to be used at your own risk, and to be used with respect for the rights of the artists and labels. The step says so next to the pictures. Pictures are not stored anywhere: they stay in this tab until the files are added or the list is cleared.

### How to turn it off

It is off until you tick its box, and the box starts unticked every time the page loads. "Put cover pictures on the iPod" unticked hides the step. The AI assistant is not involved: the lookup is a plain request with `fetch`, and the assistant never fetches a picture.
