# Hardware testing

A model only becomes `hardware-tested` in [DEVICE-SUPPORT.md](DEVICE-SUPPORT.md) after a sync is run on a real iPod of that model and the result is written down here. The only iPod available is a nano 7th generation.

## Before any test that writes

Back up the iPod's database files with the reader's backup button (Phase 1, step 8), and keep that folder. The app will also back up before it writes, but a backup you made and checked yourself does not depend on the sync.

## Phase 0: environment check

Run the environment check page (desktop first, then Android, see [ANDROID-TESTING.md](ANDROID-TESTING.md)) and keep the copied report. This reads the iPod and writes one tiny file that it deletes again.

## Phase 1: read-only iPod reader

The first run against real data, and it writes nothing. In the app, under "Read your iPod", choose the iPod's top folder and keep the copied iPod report. Things to check and record:

1. It finds `iPod_Control` and loads without an error. If it fails, copy the message.
2. The model number is the one printed on the iPod or shown in its settings.
3. "Database signing" says hashAB for a nano 6G or 7G, and the FireWire ID is 16 hex digits.
4. "Device description file" says SysInfoExtended was found. If not, say so: the app would then fall back to a template.
5. The track and playlist counts match what the iPod shows.
6. Compare the report with the nano 7G facts in [DEVICE-SUPPORT.md](DEVICE-SUPPORT.md): disk format, supported features. Note any difference. Those facts came from someone else's unit.
7. "Signature on iTunesCDB" and "Signature on Locations.itdb.cbk" both say "Matches what the engine computes". This compares the signatures iTunes wrote on the iPod with the engine's own hashAB, so a match shows the engine signs the way this iPod expects, before anything is written. "Does not match" does not mean the iPod is damaged. It means the engine's understanding of the signature is off, so copy the report and do not sync. "Try a nano 7G-style demo" on the same page shows what a match looks like.
8. Back up. Under the reader's result, click "Choose where to keep the backup" and pick a folder on the computer (if Chrome refuses Desktop, Documents or Downloads themselves, make a folder inside one). It should say every file was read back and matched. Open the folder and read `README.txt`. This only reads the iPod.
9. Rewrite check. Click "Check what a rewrite would change" and copy the rewrite report. "No differences found" means a rewrite would keep everything the check can compare. Otherwise the differences are listed, and you should not sync: paste the report. From reading the code, the likely finding is that artwork links in the SQLite files are lost. The check writes only inside the engine's memory, never to the iPod.

The report leaves out track titles but includes the iPod's serial number and FireWire ID.

## Phase 2: sync cases (draft)

These cases are written ahead of the feature and will be revised when it exists.

1. Connect. The device card shows the right model and generation.
2. Sync one MP3. It appears under Music and plays.
3. Sync one AAC `.m4a` that needs no conversion. It plays and shows artwork.
4. Sync one FLAC. It is converted and plays.
5. Sync 20 tracks and cancel halfway. Resume. There are no duplicates and the iPod still works.
6. Eject, reconnect, and confirm the iPod still mounts and plays.
7. Delete one track. It disappears and its file is removed.
8. Restore the backup. The iPod returns to its earlier state.

## Recording a result

Copy this block for each run.

```
Date:
App commit:
iPod model, generation, firmware:
Disk format (if known):
Host: desktop Chrome <version> / Android Chrome <version>
Case:
Outcome: pass / fail
What happened:
Report or log attached:
```

## Results

### 2026-11-07: environment check, nano 7th generation, macOS Chrome 157

- App commit: `45b4c87` on `main`
- iPod: nano 7th generation (USB product id 0x1267), volume label IPOD NANO R, firmware not recorded
- Host: desktop Chrome 157 on macOS
- Case: Phase 0 environment check (USB, folder read only, write test)
- Outcome: **pass**
- What happened: Chrome saw the iPod over USB and read its FireWire ID without opening the device. It opened the volume and found `iPod_Control` and `iPod_Control/Device/SysInfo`. It wrote, read back and deleted a two-byte file.
- Notes: the write step took 3.7 seconds for two bytes, so the cost per file on this iPod needs measuring (the speed test was added after this run). No `iTunesDB` was found at the expected path. libgpod reads `iTunesCDB` first, so that may be normal for this model, and the reader's file listing will show. The volume holds folders made by Windows and by Android, so it has been used with both. The reader and the speed test have not been run yet.

### 2026-11-07: environment check with file listing, nano 7th generation, macOS Chrome 157 (second run)

- App commit: `b6e6ee0` on `main`
- iPod: the same nano 7th generation as above
- Host: desktop Chrome 157 on macOS
- Case: Phase 0 environment check with the `iPod_Control` listing and the timed write steps. The write-speed test and the Phase 1 reader were not run.
- Outcome: **pass**
- What happened: the listing shows the layout this model really uses. `iPod_Control/iTunes` holds `iTunesCDB` and the `iTunes Library.itlp` folder of SQLite files, with a `Locations.itdb.cbk` of the size a signature plus 81 block hashes would have. There is no `iTunesDB`, so that was normal for this model. Writing the two-byte test file took 1.49 seconds, of which closing the writer was 1.47. The other steps each took under 10 milliseconds.
- Notes: `iTunesControl` and `Device/Radio/RadioBuffer` are each exactly 20 MiB and libgpod never opens them, so the loader now leaves them out. The full list is in the registry observations for the nano 7G. The fixed cost per file on close is why the speed test compares one file at a time with several at once. Still to run: the speed test, and the reader with its new signature check.

### 2026-11-07: reader and write-speed test, nano 7th generation, macOS Chrome 157 (third run)

- App commit: `f80de7d` on `main` (the same app code as when the run was made)
- iPod: the same nano 7th generation as above
- Host: desktop Chrome 157 on macOS
- Case: Phase 1 reader (read only) and the write-speed test
- Outcome: **pass**
- What happened: the reader opened the iPod's `iTunesCDB` and read 942 music tracks and 2 playlists (the master list and a smart "Videos" list with no tracks). Both signature checks matched. It read 30 files, 1.4 MB, and left out the two 20 MiB files. In the speed test a small file cost a median 327 ms (create, write, close, delete), one 8 MB file wrote at 8.1 MB/s, and three 4 MB files at once at 13.2 MB/s.
- Decision: a sync writes three files at a time.
- Notes: the reader listed video as unsupported. That is libgpod judging video from the model number alone, and it does not know MD480, so the page no longer lists video for models libgpod does not know. Not yet shown: that libgpod's rewrite keeps everything on this iPod (artwork links, ratings, the other SQLite files). Next is a backup of the database files before any write, and a read-only rewrite check done in memory.

### 2026-11-07: environment check and speed test again, nano 7th generation, macOS Chrome 157 (fourth run)

- App commit: `0bd703d` on `main`
- iPod: the same nano 7th generation as above
- Host: desktop Chrome 157 on macOS
- Case: Phase 0 environment check with the write-speed test, run again
- Outcome: **pass**
- What happened: the write test took 551 ms, of which closing the writer was 531. The speed test gave a median 312 ms for a small file, 8.9 MB/s for one 8 MB file and 12.3 MB/s for three 4 MB files at once.
- Notes: this agrees with the third run (327 ms, 8.1 and 13.2 MB/s), so three files at a time stands. The backup and the rewrite check were not run in this report.

### 2026-11-07: rewrite check, nano 7th generation, macOS Chrome 157 (fifth run)

- App commit: `0bd703d` on `main`
- iPod: the same nano 7th generation as above
- Host: desktop Chrome 157 on macOS
- Case: Phase 1 rewrite check (the backup button was not reported on)
- Outcome: **ran, with findings**
- What happened: libgpod wrote the library in memory in 0.28 s. The library iTunesCDB lists came back identical (942 music tracks, 2 playlists, no field changed) and both signatures verified. The SQLite files differed from what iTunes wrote:
  - 6 of the 8 containers in `Library.itdb`, the iPod's built-in lists, were not written, and neither were the smart-playlist settings, because libgpod only knows the 2 playlists in `iTunesCDB`. `container_ui` in `Dynamic.itdb` shrank from 8 rows to 2.
  - `item_stats.has_been_played` went from all 942 tracks to 1, and every track got a played and skipped date (1970) where iTunes had left them empty.
  - `genre_map.genre_order` and `location_kind_map` were simplified.
  - Twelve columns that hold nothing in iTunes' files were missing, including `item.is_home_video`.
- Notes: my guess that artwork links would be lost was wrong for this iPod: none exist. The `is_home_video` column and the library version came from libgpod running the wrong one of the device's two SQL command sets, which a fourth libgpod patch fixes (library version 26 and the column now come out). The rest is libgpod rebuilding the SQLite files from its own model. Whether the nano accepts that is untested. Next is a write-back test with a verified backup and a restore.
