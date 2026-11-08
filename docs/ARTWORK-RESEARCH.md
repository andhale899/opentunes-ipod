# Album art and photos on the nano 7G: research

Written on 2026-11-07, before any artwork code. Every claim is marked **CONFIRMED** (with where it comes from) or **GUESS**. CONFIRMED means "read in a file or source I opened", not "tested on an iPod": nothing here has been run on a real device, and the nano 7G stays `spec-sourced` in the registry.

Sources, in the order they are used:

- **Device file.** `engine/data/7_nano_SysInfoExtended.plist` in this repository (the nano 7G's description of itself).
- **Owner's backups.** `~/Desktop/Hobby/tunes/bkp/*/iPod_Control` (read only; eight backups made on 2026-11-07, all with the same `Artwork` folder). Only sizes and structure are used here. No ID of the unit is copied into the repository.
- **libgpod.** The source the Docker build fetches: `gtkpod/libgpod` commit `7982c55` (checked by SHA-256 against the Dockerfile).
- **ipodsync.** [github.com/buldiei/ipodsync](https://github.com/buldiei/ipodsync), MIT licence, commit `28174c7`. A Python tool for the nano 6G/7G whose README says its cover art is "confirmed on nano 7G". Read as a reference only. Its author's claim is not something I tested.
- **iOpenPod.** [github.com/TheRealSavi/iOpenPod](https://github.com/TheRealSavi/iOpenPod), GPL-3.0-or-later (`COPYING.md`), documents in `docs/research/` (`artworkdb-format.md`, `photosdb-format.md`, `artwork-sync-loss-2026-10-08.md`, `adr/0033`, `adr/0111`). Read as a reference only, and no code was copied from it or from ipodsync.

## 1. What the device file says

All **CONFIRMED** from `engine/data/7_nano_SysInfoExtended.plist`.

The old keys are empty arrays (`ImageSpecifications`, `AlbumArt`, `ChapterImageSpecs`). The data is under the `2` keys:

| Key | Format id | Size | Pixels | Crop | Row alignment | Back colour | Associated format |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AlbumArt2` | 1010 | 240 x 240 | `L565` | no | yes | 00000000 | 0 |
| `AlbumArt2` | 1011 | 240 x 240 | `L565` | no | yes | 00000000 | 1024 |
| `AlbumArt2` | 1013 | 50 x 50 | `L565` | no | yes | 00000000 | 0 |
| `AlbumArt2` | 1015 | 58 x 58 | `L565` | no | yes | 00000000 | 0 |
| `AlbumArt2` | 1016 | 57 x 57 | `L565` | no | yes | 00000000 | 0 |
| `ImageSpecifications2` (photos) | 1007 | 480 x 864 | `L565` | no | no | none | 0 |
| `ImageSpecifications2` (photos) | 1005 | 80 x 80 | `L565` | yes | no | none | 0 |
| `ChapterImageSpecs2` | 1010, 1019 (101 x 57), 1011 | | `L565` | | yes | | |

- `PixelFormat` `4C353635` is the ASCII text `L565`: 16 bits per pixel, 5 bits red, 6 green, 5 blue, little endian. libgpod reads `4C353635` as `THUMB_FORMAT_RGB565_LE` (`itdb_sysinfo_extended_parser.c`, `set_pixel_format`).
- `AlignRowBytes` true with no `RowBytesAlignment` key: libgpod reads it as an alignment of 4 bytes (`g_value_to_image_format`).
- Also declared: `SupportsSparseArtwork` true (several tracks may share one image), `MaxThumbFileSize` 50 (read by libgpod, never used by it; the unit is not stated, megabytes is a **GUESS**), `SQLiteDB` true, `DBVersion` 5, `PhotoEventsSupported` and `PhotoFacesSupported` true.
- The owner's unit shows a Photos icon: `SBPhotos` is in the `sbIconList` of `Device/IconState.plist` in the backup. **CONFIRMED.** That the unit shows photos is therefore not in doubt. How it stores them is (section 4).
- libgpod's own device tables reuse format numbers with different sizes (1016 is 140 x 140 for another model in `itdb_device.c`), so a format id means nothing without the device's own description. The art code must check the file's sizes, not trust the numbers. **CONFIRMED** (source).
- **The brief and `ENGINE-BUILD.md` say libgpod does not read the `2` keys. It does.** `g_value_to_ipod_properties` falls back to `AlbumArt2`, `ImageSpecifications2` and `ChapterImageSpecs2` when the old key is empty (`itdb_sysinfo_extended_parser.c`, lines 519 to 536). **CONFIRMED** (source). The engine already reports `supports.artwork` for the owner's file for that reason. The real gap is elsewhere: libgpod needs gdk-pixbuf to write anything, and its writer produces a different file from the one a nano 7G has (section 3).

## 2. How a nano 7G stores album art

### Files

The owner's backups hold, in `iPod_Control/Artwork` (sizes only, **CONFIRMED**):

| File | Bytes | What it is |
| --- | --- | --- |
| `ArtworkDB` | 2,120 | The index, a tree of `mh..` records. |
| `F1010_1.ithmb` | 115,200 | 240 x 240 x 2: one thumbnail. |
| `F1013_1.ithmb` | 5,000 | 50 x 50 x 2: one thumbnail. |
| `F1015_1.ithmb` | 6,728 | 58 x 58 x 2: one thumbnail. |
| `F1016_1.ithmb` | 6,612 | 58 x 57 x 2: one thumbnail with each row widened to 58 pixels (116 bytes). |

- One image only, and the track it was for is not in the library any more (its id matches no `item.pid`). So the unit has art, but no track points at it. **CONFIRMED.**
- Decoded as little-endian RGB565 with those row sizes, the 240 x 240 file is a clean picture, and the 2 spare bytes at the end of each 1016 row are zero. I looked at it. So the pixel format, the row alignment and the widening of the 57 pixel row are **CONFIRMED** from the real unit. The file names are `F<format>_<n>.ithmb`, in `Artwork` directly, with the same names inside `ArtworkDB` (`:F1010_1.ithmb`).
- Only four of the five declared formats are in use. 1011 (associated format 1024) is not in the file or in the list of formats, and ipodsync's reference file from iTunes has the same four. Why is a **GUESS**. This is the first reason not to let libgpod write the file, since libgpod writes every format the device lists (section 3).
- Thumbnails sit back to back in the `.ithmb`, one slot per image: 115,200, 5,000, 6,728 and 6,612 bytes. The mhni of each image holds the offset (0 for the one image). **CONFIRMED** (owner's file; ipodsync's writer works the same way).

### `ArtworkDB` layout

Everything little endian. **CONFIRMED** against the owner's 2,120-byte file, field by field, and against the byte templates in ipodsync (`_art_templates.py`, taken from an iTunes-made file) which have the same sizes and the same values wherever they are not per-image or per-database. The record names and the generic 12-byte header (`type`, header length, total length or child count) are also in iOpenPod's `artworkdb-format.md` and in libgpod's `db-itunes-parser.h`.

```
mhfd   header 0x84 (132)
 +0x10 = 6         libgpod writes 2 (its header comment says iTunes 7 deletes a database that
                   holds 1). 6 is in the owner's file, in ipodsync's reference and in iOpenPod's
                   Nano 5 and 7 captures. iOpenPod's notes say it is not a version number.
 +0x14 = 3         children
 +0x1c = next image id (the highest id plus 1; 101 for one image 100)
 +0x20  8 bytes, +0x28 8 bytes, +0x3c 8 bytes   random-looking, different in each database
 +0x30  one byte = 1   (libgpod writes 2)
 mhsd (index 1)  header 0x60
   mhli header 0x5c, +0x08 = number of images
     mhii header 0x98 (152), total 928 for four formats
      +0x0c = 5 children   +0x10 = image id (from 100)   +0x14 = song id (8 bytes: the track's pid)
      +0x30 = size of the source image in bytes
      +0x38 = 1, +0x3c = 1   (see below)   +0x48 and +0x50: the double NaN 00 00 00 00 00 00 F8 7F
      everything else 0 (rating, dates, and so on)
      4 x mhod type 2 (header 0x18, total 164)
            mhni header 0x4c, total 140
              +0x0c = 1 child   +0x10 format id   +0x14 offset in the .ithmb
              +0x18 size of the thumbnail slot   +0x1c vertical and horizontal padding (0, 0)
              +0x20 height (16 bit)  +0x22 width (16 bit)  +0x28 size again
              mhod type 3 (header 0x18, total 64): +0x18 string length in bytes (28), +0x1c
                  encoding 2 (UTF-16 little endian), the text ":F1010_1.ithmb" from +0x24
      1 x mhod type 6 (total 120): the 96 bytes  "mhaf" 0x60 0x3c 0...
 mhsd (index 2)  header 0x60, then mhla header 0x5c with 0 albums (these are photo albums)
 mhsd (index 3)  header 0x60, then mhlf header 0x5c, +0x08 = 4, then 4 x mhif
     mhif header 0x7c, +0x10 format id, +0x14 slot size   (1010: 115,200, 1013: 5,000, 1015: 6,728, 1016: 6,612)
```

- The order of the four formats is 1010, 1013, 1015, 1016, the same in the `mhii` records and in the `mhif` list.
- `mhii +0x38` and `+0x3c` are both 1 for the one image. iOpenPod's notes say foo_dop (an independent iPod manager) writes a count of the tracks that use an image at `+0x38` and 1 at `+0x3c`. What they mean is a **GUESS**. libgpod writes neither (its header struct stops at `+0x34`).
- For a nano 6G or 7G the values of the three 8-byte fields in `mhfd` are unknown. **GUESS:** database ids. To extend a file that already has them they are kept as they are.
- The `.ithmb` row rule for the 57 pixel format: each row is written 58 pixels wide, and the 2 extra bytes are zero. libgpod computes the same thing (`pack_RGB_565` aligns rows to `row_bytes_alignment`), but it writes 6,498 for 1016 in `mhif` where the real file says 6,612. **CONFIRMED** both ways.

### Links between a track and its art

- **In the `.itdb` files.** All five SQLite files of the owner's library (`Library`, `Locations`, `Dynamic`, `Extras`, `Genius`) have no table with `artwork` in its name. The only columns are in `Library.itdb`: `item.artwork_status`, `item.artwork_cache_id`, `album.artwork_status`, `album.artwork_item_pid`, `artist.artwork_status` and `artist.artwork_album_pid`. **CONFIRMED.**
- In the owner's library every one of them is 0: all 943 items, all 635 albums and all 338 artists. So the unit cannot show what iTunes writes there. **CONFIRMED.** The SQL steps in the device file only insert the "Unknown Artist" and "Unknown Album" rows, with 0 in these columns (lines 746 and 754 of the plist).
- What the columns hold for a track with art comes from two public sources, neither tested by me:
  - libgpod (`itdb_sqlite.c` lines 962 to 968 and 1321), **CONFIRMED** (source): `item.artwork_status` is the track's `has_artwork` (1 has art), `item.artwork_cache_id` is the image id, and after all items are written `album.artwork_item_pid` is set to the pid of one track of that album whose `artwork_cache_id` is not 0. `album.artwork_status` and `artist.*` stay 0.
  - ipodsync (`library.py`, `set_track_artwork`, `set_album_artwork`), **CONFIRMED** (source), its author says confirmed on a nano 7G: `item.artwork_status = 1`, `item.artwork_cache_id = <image id from the ArtworkDB>`, `album.artwork_item_pid = pid of a covered track`, `album.artwork_status` left 0, and the comment that iTunes does the same. `mhii` song id is the item's `pid` as an unsigned 64 bit number.
- In `iTunesCDB` (which the nano 7G also has, and ipodsync says the device regenerates), libgpod writes `artwork_count`, `artwork_size`, `has_artwork` and `mhii_link` (+0x160, the image id) in each `mhit`. **CONFIRMED** (source).
- **What libgpod loses today.** Because this build has no gdk-pixbuf, libgpod never reads the `ArtworkDB`, so `track->artwork->id` stays 0 on every track it loads. Its SQLite writer then writes `artwork_cache_id` 0 for every track. On the owner's unit that changes nothing (all are 0), but on an iPod where iTunes put art it would cut the links on any rewrite. **CONFIRMED** by reading `itdb_sqlite.c` and `itdb_itunesdb.c`. The fix is small and belongs in the engine: take the id from `mhii_link`, which libgpod does read.
- Shared images (sparse art): an iPod that declares `SupportsSparseArtwork` may have many tracks pointing at one image. In iOpenPod's nano 7 capture there are 832 tracks and 247 images. **CONFIRMED** (their `docs/sync-artwork-audit-2026-10-08.md`; I have not seen the capture). libgpod's writer does the same: one `mhii` per distinct id, with the first track's pid as song id and the others only through `mhii_link` (`ipod_artwork_db_set_ids`).

### What libgpod would write, and why we do not use it

Reading `db-artwork-writer.c`, `ithumb-writer.c` and `itdb_artwork.c` (**CONFIRMED**, source), libgpod's ArtworkDB path for an iPod with `SQLiteDB`:

- needs `HAVE_GDKPIXBUF` and gdk-pixbuf to decode and scale images. Neither is in this build (`--disable-gdk-pixbuf`). An earlier attempt on branch `wip/artwork-pixbuf` wrote a stand-in for the gdk-pixbuf calls plus three libgpod patches. It was never built or run.
- writes `mhfd +0x10` as 2 and the flag at `+0x30` as 2, no random ids, no `mhii +0x38/+0x3c`, no type 6 `mhaf` record, no second size in `mhni`, a `mhif` size of 6,498 for 1016, and thumbnails for all five declared formats including 1011.
- rewrites the whole `Artwork` folder on every save and renumbers every id, so it must be given the whole folder in memory. The engine only holds the database files.

Every one of those differs from the file a nano 7G has (section 2, `ArtworkDB` layout). Whether the device would accept libgpod's variant is unknown, and a wrong `ArtworkDB` is the sort of thing that can hide every cover (iOpenPod's notes quote an experiment where a wrong image count made all art vanish).

**Decision.** Do not use libgpod's artwork code and do not build gdk-pixbuf. Write the `ArtworkDB` and the `.ithmb` files from our own small writer (TypeScript, `engine/js/artwork.ts`), shaped like the real file above and added to an existing `ArtworkDB` without touching the records already in it. Use libgpod only for what it already does well and what is proven on the owner's unit: writing the SQLite library and the signature, with the track's art id and flag set by a small new engine function. This needs no change to the libgpod patches and the wip patches 0005 to 0007 are not used.

### Other public descriptions

- ipodsync, MIT licence, is the closest: "ArtworkDB + `F<fmt>_1.ithmb`, RGB565 LE, formats 1010/1013/1015/1016", covers appended to the end of the `.ithmb` files and one `mhii` per track; its bytes agree with the owner's file wherever I compared them. It appends to `F<fmt>_1.ithmb` without limit.
- iOpenPod (GPL-3.0-or-later) says the same about the format and gives the 57 pixel row padding. It also notes zero is not by itself proven wrong for the fields libgpod leaves empty.
- A web search for libgpod issue threads and gtkpod lists on the nano 6G or 7G artwork format found nothing specific, and no nano 7G description other than the two above. podkit's documentation (`jvgomg.github.io/podkit`) lists the nano 6G and 7G as unsupported ("different database format") and says nothing more.
- Not used: Rockbox, GNUpod and ipod-sharp, which cover other firmware or older models.
- Licences: ipodsync is MIT and iOpenPod is GPL-3.0-or-later, both usable with this project's GPL-3.0-or-later licence if code were taken. None was: the writer is written from the field list above, which the owner's own file confirms.

## 3. What a first write would look like

| Step | Source of the rule |
| --- | --- |
| Four thumbnails per image: 1010, 1013, 1015, 1016, RGB565 little endian, rows widened to a multiple of 4 bytes, widening bytes zero | Owner's file, device file, ipodsync |
| Appended to `F<format>_1.ithmb` at the file's current size | Owner's file, ipodsync |
| One `mhii` per image, ids from 100 (or the next id), `song id` = pid of the first track using it | Owner's file |
| `mhfd +0x1c` (next id), the totals and counts updated, everything else in an existing file kept as it is | Owner's file |
| `item.artwork_status = 1`, `item.artwork_cache_id = image id` for each track, `album.artwork_item_pid` from a covered track | libgpod source, ipodsync |
| Files written before the SQLite library, rolled back if anything fails | The existing sync order |

**What is not covered by any real file.**

1. Several tracks sharing one image: the `mhii +0x38` count would be a **GUESS** (the number of tracks).
2. More than one `.ithmb` per format (`F1010_2.ithmb`). libgpod does it, iOpenPod and ipodsync do not need it. Whether a nano 7G reads a second file is unknown. The writer refuses to start a second file, and says so.
3. A new `ArtworkDB` on an iPod that has none (the random `mhfd` values). The owner's unit has one.
4. Removing art. The image stays after its track is removed (as the owner's one image shows it can).
5. Non-square pictures. `Crop` is false for every album art format, so the writer fits the picture inside the square and fills the rest black. That is a **GUESS** at what looks right. Square covers, which is nearly all of them, are not affected.

## 4. Photos

- The device file declares two photo formats: 1007 (480 x 864) and 1005 (80 x 80), both `L565`. **CONFIRMED.** The owner's unit has a Photos icon. **CONFIRMED.**
- libgpod has a photo database API (`itdb_photoalbum.c`: `iPod_Control/Photos/Photo Database` and `Photos/Thumbs/F<id>_<n>.ithmb`, names written as `:Thumbs:F1017_1.ithmb`). **CONFIRMED** (source). It needs gdk-pixbuf as well, and its `ArtworkDB` writer is the same one as for album art, so the differences in section 2 apply.
- iOpenPod's `photosdb-format.md` says the Photo Database has the same record layout as the `ArtworkDB`, and that its photo album record (`mhba`) type is 6 on the nano 6 and 7 where other iPods use 2. It gives no layout for the 1007 and 1005 formats beyond "centred on a black raster, with padding" (the full-size 480 x 864 raster is 829,440 bytes per photo). **CONFIRMED** (their text); I have no file to compare it with.
- I have no photo database or `Photos` folder from a nano 7G. The owner's backups do not hold one: the backup code copies `iTunes`, `Device` and `Artwork` only, so I cannot tell if the unit has a `Photos` folder at all. Nothing the app writes today would be backed up if it wrote there, so it could not be restored.

## 5. What the build checked (added after Stage B)

Run in this branch, with the commands in the changelog. None of this is a test on an iPod.

- **The writer reproduces the owner's ArtworkDB byte for byte.** A test (`engine/test/artwork.test.mjs`, run when `OPENTUNES_REAL_ARTWORKDB` names a file) reads the owner's 2,120 byte file, rebuilds it from the fields it read (image id, track id, source size, offsets, and the unexplained `mhfd` ids) and compares: identical. It also adds an image to the real file and checks the old image's record, the ids and the format list are unchanged. This confirms the field layout and sizes in section 2 against one real file, nothing about how the device treats a file that has more images.
- **Thumbnail bytes and the ArtworkDB fields** are checked with a reader written separately from the writer, and the pixel packing against an unpacker written separately, including the zero bytes widening each 57 pixel row.
- **The library link.** After a sync with a cover, the SQLite library written in memory (and read back from the scratch iPod) holds `item.artwork_status` 1 and `item.artwork_cache_id` = the image id for that track's pid, and `album.artwork_item_pid` points at it. Tracks that already have a link keep it through a later sync (this fails if the engine's `ot_open` does not copy `mhii_link` into the id: checked by turning that line off and rebuilding). That the iPod reads these columns the way libgpod's source and ipodsync suggest is **not** tested.
- **Failure paths:** a refused or corrupted write of a thumbnail file, of the ArtworkDB and of the database each leave the scratch iPod byte for byte as it was, an ArtworkDB that changed after the plan stops the write, and an ArtworkDB or thumbnail files this code does not understand leave art off with a warning while the music goes on.
- **The old engine build** (the one in the main checkout) still works with the new code: a sync with a cover picture leaves the art off with "this engine build predates album art" and verifies.
- **The app side** has unit tests (folder cover rules, the lookup with a fake `fetch`) and a headless Chrome scenario on a practice iPod: a cover.png from a folder, a looked-up cover through a fake `fetch`, the plan, the write and the read-back.

## 6. Decisions

### Album art: **GO**, for tracks with a cover, behind a first test by the owner

Why GO: the format is known from three agreeing sources (the owner's own unit, an MIT licensed tool whose author says it works on a nano 7G, and GPL notes with captures), the pixel format and row rule are confirmed from the owner's own file, and the write can be done by adding to a file the unit already has, leaving everything already in it untouched, with the existing backup and rollback.

Risks, in order:

1. It has not run on a real unit. The first test decides everything below.
2. The SQLite side (`artwork_status`, `artwork_cache_id`, `album.artwork_item_pid`) is confirmed from source and from a tool's claim, not from a unit that holds covers. The owner's library has none to copy.
3. Several tracks sharing one image uses a guessed count.
4. A bad `ArtworkDB` can hide every cover, not only the new ones. That is why the backup includes the `Artwork` folder and the restore puts it back.
5. Art is only added, never removed or compacted. The 50 MB limit per `.ithmb` file (`MaxThumbFileSize`, read as megabytes) means about 430 covers of 115,200 bytes in the 240 pixel file. The writer stops with a message when it would pass the limit. With covers shared by album that is a lot of albums.

**First real-device test (the owner, one track).** 1. Make a complete backup with the app (it includes `Artwork`). 2. Add one MP3 or M4A with a cover picture inside, alone, without sharing a cover with anything else. 3. After the sync, the app reads the iPod back and checks the `ArtworkDB` and the `.ithmb` files. 4. Eject, then on the iPod look at Now Playing for that song (the 240 pixel cover), and at the list and Albums views (the small ones). 5. Check that the iPod's other songs still play and show no wrong covers, and that Settings, then About, still shows the same song count. 6. To undo: restore the backup from the app, which puts back `iTunes`, `Device` and `Artwork` and deletes nothing, then delete the new song's file if it is still there. If the iPod misbehaves in a way the app cannot reach, connect it to iTunes or Finder and restore it there.

Only after that is a second test worth doing: an album of several tracks with the same cover (sharing), then an album without a cover that has one found online.

### Photos: **NO-GO**

Risk: the file layout for the 1007 and 1005 formats on a nano 7G is not shown by any file I have, the folder is outside what the backup holds, and libgpod's writer is the same one that differs from the real album art file. A bad Photo Database could hide every photo, and nothing could restore it. Nothing in the app depends on photos. The nano 7G stays `spec-sourced` for them.

What would change it: a copy of the `Photos` folder from a nano 7G that has had photos put on it by iTunes or Finder (two or three photos, folder structure and sizes only, no pictures needed in the repository), the backup code extended to copy that folder, and then the same read-compare-write path as album art.
