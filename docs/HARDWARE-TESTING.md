# Hardware testing

A model only becomes `hardware-tested` in [DEVICE-SUPPORT.md](DEVICE-SUPPORT.md) after a sync is run on a real iPod of that model and the result is written down here. The only iPod available is a nano 7th generation.

## Before any test that writes

Copy the iPod's `iPod_Control/iTunes` and `iPod_Control/Device` folders to your computer. The app also backs up the database itself before writing, but a copy you made yourself does not depend on the app.

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
