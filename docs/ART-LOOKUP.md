# Album art: cover pictures and the online lookup

Where a track's cover comes from, and the one optional step that goes online. For the iPod's file format and what is and is not confirmed, see [ARTWORK-RESEARCH.md](ARTWORK-RESEARCH.md).

## Where a cover comes from

For each file that is added, the first of these that exists is used:

1. **A picture you chose for that file** (below). It is only ever set on a file with no cover, or after you press "Replace the cover", so it never takes the place of a cover that is already there unless you ask.
2. **The picture inside the file** (an MP3's APIC frame, an MP4's `covr` atom, a FLAC picture block), which the probe already reads.
3. **A cover picture in the file's folder, or the folder above it.** Only when files are added with "Choose a folder". The names are `cover`, `folder`, `front`, `album` and `AlbumArt`, as `.jpg`, `.jpeg` or `.png`, in any case, and in that order of preference. A cover at the top of a whole library is not given to every album below it: only the file's own folder and the one above (for an album with Disc 1 and Disc 2 folders) are looked in.
4. **A cover found online and approved by you** (below).

The picture is turned into pixels with Chrome's own decoder and a canvas, then shrunk to the four sizes the iPod wants (240, 58, 57 and 50 pixels) in `engine/js/artwork.ts`. A picture the browser cannot read is left off with a warning, and the music still goes on. Nothing about this leaves your computer.

### The Cover line on every row

Every row of the Add music list says, in words and with a symbol (never colour alone), where its cover comes from:

| Row says | Meaning |
| --- | --- |
| `Cover: from the file` | The picture inside the file. |
| `Cover: from the folder (cover.jpg)` | A picture in its folder, with the name. |
| `Cover: found online` | A cover you approved from the online step. |
| `Cover: from the picture you chose` | A picture you chose for that file, with a small preview on the row. |
| `No cover` | None of the above. |

Rows that cannot take art (video, files the iPod cannot use, duplicates that will be left out) say nothing. When "Put cover pictures on the iPod" is cleared, one line above the list says "Covers are off" instead. Above the list, one line counts what is missing ("3 albums have no cover.") and how many files cannot be looked up and why. What the row shows is what the sync writes: the row and `prepareItem` both read the cover through `coverSource` and `coverFor` in `app/src/albumArt.ts`, and the plan still says "Add album art to N tracks: M pictures".

A row with `No cover` has these buttons:

- **Find a cover online**, when the file can be looked up (an artist and album name, or a song title, below). It opens the online step, not collapsed, takes the cursor to its tick box and points the step at that album or song alone ("Only this one for now"; "Look up all N instead" widens it again).
- **Choose a picture...**, always. It opens a picture picker (JPEG, PNG, and WebP, which Chrome decodes).
- For a file with no album name and no usable title, the row says "This file has no album name and no song title, so it cannot be looked up. Choose a picture, or add the album name in the Library after adding." and offers only "Choose a picture...".
- For a file with no tags but a readable file name, the row offers "Use the file name as a guess" (below).

A row that already has a cover from the file, the folder or online offers "Replace the cover". A row with a chosen picture offers "Choose a different picture" and "Remove the picture I chose".

### A picture you choose

The picture is checked when you choose it, with the same limits as a cover read from inside a file: it must be no larger than 24 MB (`MAX_ARTWORK_BYTES`, the probe's own limit), its first bytes must say JPEG, PNG or WebP (the name is not trusted), Chrome must decode it, and it must be no more than 36,000,000 pixels (`MAX_SOURCE_PIXELS`, which the writer refuses above too). A picture that fails any of these is not used, and the row says why in plain words. It is shown as a small preview on the row and counts as that file's cover.

When several files in the list share an album (same album artist or artist and same album name, ignoring case and spacing), the row offers "Use this picture for all N files of this album", on by default. It gives the same picture to each of those files that has no cover yet and is not left out as a duplicate; a file that already has a cover keeps it. The files get the very same bytes, so the writer, which keeps one image per picture, stores it once. A file with no album name is its own album.

"Put cover pictures on the iPod" is a tick box in the Add music step, on by default. Writing cover art has not been tried on a real iPod yet, and the box says so.

## Find missing album art online (optional)

Shown inside "Add music", and open, whenever a file has no cover and can be looked up (it is not hidden in a collapsed section; only the long explanation is). It uses two free public services:

- **MusicBrainz** (musicbrainz.org) to find which release an artist and album name mean, or which recording a song title and artist mean.
- **The Cover Art Archive** (coverartarchive.org) for that release's front cover. It answers with a redirect to the picture on archive.org.

### What is sent

Only after you tick "Send these names to musicbrainz.org and coverartarchive.org to look for covers" and press "Find covers". The step also shows, before anything is sent, what it would send ("Would send 2 album names (with the artist) and 1 song title (with the artist, when there is one) to musicbrainz.org and coverartarchive.org.").

An album (the file has an artist and an album name):

- To `musicbrainz.org`, one search per album: `GET https://musicbrainz.org/ws/2/release/?query=release:"<album>" AND artist:"<artist>"&fmt=json&limit=10`.
- To `coverartarchive.org`, for the best matching release: `GET https://coverartarchive.org/release/<release id>/front-500`, and the browser follows the redirect to a host under `archive.org`. If a release has no cover, up to two more releases are tried.

A song (the file has no album name, or an album name but no artist, and has a title):

- To `musicbrainz.org`, one search per song: `GET https://musicbrainz.org/ws/2/recording/?query=recording:"<title>" AND artist:"<artist>"&fmt=json&limit=10`. With no artist the query is `recording:"<title>"` alone.
- To `coverartarchive.org`, the front cover of the releases that recording is on, best first (an official release of type Album, then a Single, then the rest; up to three releases), and if none has one, the front cover of the first release's release group: `GET https://coverartarchive.org/release-group/<release group id>/front-500`.
- The file's length is **not sent**. It is compared on your computer with the length MusicBrainz gives each recording, to tell versions apart: a recording more than three seconds away from the file's is left out as probably another version (a live take, a radio edit).

The artist is the album artist when the file has one, otherwise the artist. For a file with no title whose name looks like `Artist - Title.mp3` (a leading track number is dropped), the row offers that as a guess. Nothing is looked up from it until you press "Use the file name as a guess", and the result is marked as guessed and is never better than "Maybe". Nothing else is sent: no file names, no other tags, no audio, no list of your library, no cookies (`credentials: omit`), and the page's address only as an origin (`referrerPolicy: origin`). Like any web request, the services see your computer's address.

### How sure a match is

Every found song shows the picture and what it matched ("Smoke Song by Smoke Band, on Smoke Album (2001)"), and one of three words:

- **Good match**: the title and artist fit and the length is within three seconds.
- **Maybe**: the title and artist fit but the length could not be checked, or the title and artist were guessed from the file name.
- **Low confidence**: no artist to check, so it may be another song with the same title. A low confidence match is never ticked for you; you can tick it yourself.

Nothing is used until you press "Use the ticked covers". "Also fill in the album name from the match" is a second tick box, off, shown when songs are being looked up. Only for the songs you approve with it ticked, the matched album name is written into the file's tags in the list (the row says so) and so reaches the iPod's library; nothing else is changed.

### Limits and the session cache

At most 25 albums and songs are looked up each time. If there are more, the step says how many were not looked up and to press "Find covers" again to continue. Answers (found or not found) are kept while the page is open, so the same album or song is never asked for twice, and two songs that match the same release share its picture without asking for it again. A failed request is not kept, so it is tried again. The gap between MusicBrainz requests holds across runs. Nothing is stored on disk.

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

On 2026-11-08, three requests with `curl` (not Chrome) to the recording search, for one well known song (`recording:"Karma Police" AND artist:"Radiohead"`), with an `Origin` header and at least a few seconds apart. The first two were answered `503` ("The MusicBrainz web server is currently busy") with the header `access-control-allow-origin: *`; the third, a few minutes later, was answered 200. What that answer showed: `{created, count, offset, recordings: [...]}`; each recording has `id`, `score`, `title`, `artist-credit`, often `length` (milliseconds; missing on some), sometimes `disambiguation` ("live, 2003-08-23: ...", which marks a live or other special recording), and `releases`; each release has `id`, `title`, `status`, `artist-credit` and `release-group` with `id`, `primary-type` and `secondary-types` (`Live`, `Compilation` ...), and sometimes no `date`. At score 100 the first hits were live bootleg recordings, which is why the length check, a plain recording before one marked live, and a preference for official albums matter. The matching code reads exactly these fields, and `app/test/art-lookup-songs.test.ts` has a test on a trimmed copy of that answer. Not seen: the 200 answer's CORS header (only the 503s' was looked at; the earlier release search was read by Chrome from a page without trouble), anything from Chrome for this search, or the release-group cover address (`/release-group/<id>/front-500`), which was not requested. Before relying on the song lookup, run it once from the app against a well known song and look at what comes back.

The tests in `app/test/art-lookup.test.ts`, `app/test/art-lookup-songs.test.ts` and the smoke test use a fake `fetch` and never call these services. Not tried: the real recording search from the app, many albums in a row, a service that is down or blocked, or what the Cover Art Archive does when it throttles.

### What you see, and what changes

The step shows the picture it found next to each album or song, with what it matched (the MusicBrainz release for an album, "Title by Artist, on Album (year)" and a confidence word for a song), all ticked except low confidence songs. Nothing is added to the list of files, and nothing goes on the iPod, until you press "Use the ticked covers". The Cover Art Archive says its images are freely accessible, to be used at your own risk, and to be used with respect for the rights of the artists and labels. The step says so next to the pictures. Pictures are not stored anywhere: they stay in this tab until the files are added or the list is cleared.

Files left out as duplicates, files that cannot take art and files that already have a cover are never offered for a lookup.

### How to turn it off

It is off until you tick its box, and the box starts unticked every time the page loads. "Put cover pictures on the iPod" unticked hides the step and says "Covers are off". The AI assistant is not involved: the lookup is a plain request with `fetch`, and the assistant never fetches a picture.
