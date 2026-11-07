# Hardware testing

A model only becomes `hardware-tested` in [DEVICE-SUPPORT.md](DEVICE-SUPPORT.md) after a sync is run on a real iPod of that model and the result is written down here. The only iPod available is a nano 7th generation.

## Before any test that writes

Copy the iPod's `iPod_Control/iTunes` and `iPod_Control/Device` folders to your computer. The app also backs up the database itself before writing, but a copy you made yourself does not depend on the app.

## Phase 0: environment check

Run the environment check page (desktop first, then Android, see [ANDROID-TESTING.md](ANDROID-TESTING.md)) and keep the copied report. This reads the iPod and writes one tiny file that it deletes again.

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

None yet.
