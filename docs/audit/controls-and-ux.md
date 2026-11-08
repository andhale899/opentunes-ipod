# Controls and clarity audit

Branch `hardening/controls-and-ux`, started from main at `dcaf07e`. Scope: stop and pause controls, confirm steps, double-click guards, feedback, wording and wrong-folder handling. Robustness (refresh, journal, stale data, disconnects, the global write lock, wake lock) belongs to the other audit.

This was cut short at the owner's request. What was not done is listed at the end, not hidden.

## How it was checked

Read: every component in `app/src`, `activity.ts`, `tracked.ts`, `styles.css`, and the engine functions the panels call. Used: the practice iPod (`?demo=practice`) in headless Chrome at 390 and 1280 px wide, light and dark, plus a script that measured horizontal overflow, tap targets under 44 px and text contrast at 360 px, on every tab. Screenshots were kept in the scratchpad only.

Not done: nothing was tried on a real iPod, on a real phone or with a screen reader. Contrast and target sizes were measured by script, not judged by eye on a device.

## Stop and pause, operation by operation

"Signal" means the engine function accepts an `AbortSignal`. The column "Before" is what main had; "Now" is this branch.

| Operation | Stop before | Signal | Stop now | Pause now | iPod if stopped |
| --- | --- | --- | --- | --- | --- |
| Reading the iPod (first read) | None | No | Yes, on the start page and in the bar (added `signal` to `loadIpodFolder`) | No | Untouched, read only |
| Reading again after a change | None | No | None on purpose: stopping would show the library from before the change | No | Untouched |
| Planning a sync, removal, edit, playlist change, write-back | Add music's Stop did nothing during planning (no signal was passed) | No | Yes (added `signal` to all five plan functions) | No | Untouched, plans only change memory |
| Converting files | Yes, works (worker cancel) | Yes | Unchanged | Not done: needs `AddPanel.tsx` | Untouched |
| Reading and probing the chosen files | None | n/a | Not done: needs `AddPanel.tsx` | No | Untouched |
| Copying to the iPod | Add music: "Stop and undo" | Yes | Yes, in the bar with a question first. Off with a reason during the library write, read-back and undo | Engine `pause` added, "Pause after this file" shows in the bar, no engine work is lost | Back as it was, byte for byte (tested already) |
| Removing tracks | None | Yes, not passed | Yes, in the bar. Off during the library write. After it, stopping leaves the unfinished files as leftover files | No | Before the library write: untouched. After: tracks gone, some files left over |
| Editing one or many tracks | None | Yes, not passed | Yes, before the library is written. Off during the write | No | Untouched, or put back |
| Playlist changes | None | Yes, not passed | Same as editing | No | Same as editing |
| Backup | None | No | Yes (added `signal` to `backupIpod`). The folder is marked incomplete and cannot be restored from. A stopped backup does not replace an earlier complete one as the restore point | No | iPod untouched |
| Restore one backup | None | No | Yes while the backup is being checked (nothing written). Off with a reason once files are written, because a stop would leave a mix of old and restored files | No | Untouched, or fully restored |
| Restore everything (putting an offload copy back) | n/a | n/a | Stop and Pause in the bar (`restoreOffload` takes the `signal` and the `PauseGate`), with a confirm first. Stop works while files are copied back and is off with the reason once the library files are being put back | Yes, between files | Files copied back stay, the library is untouched. After the library restore starts it cannot be stopped |
| Offload | "Stop", lost on a tab change | Yes | "Stop (you can resume later)", also in the bar | Yes, "Pause after this file", in the panel and the bar (engine `pause`) | iPod untouched, copy resumable |
| Library test (rewrite check) | None, and not shown in the bar | No | Yes until the in-memory comparison starts, then off with a reason (it is one uninterruptible step of a few seconds) | No | Untouched |
| Write-back test | None | No | Planning: yes. Writing: off, reason shown ("cannot be stopped safely, takes a few seconds") | No | Put back if it fails |
| Looking for leftover files | None | No | Yes (added `signal` to `findOrphans`) | No | Untouched |
| Deleting leftover files | None | Yes, not passed | Yes, "Stop deleting (files not yet deleted stay)" | No | Files not yet deleted stay |
| Finding duplicates | None | n/a | Removing the ticked duplicates asks first (`ConfirmBox`, says the music cannot come back from the backup), has a once-only guard, and planning can be stopped from the bar. The panel stays mounted when you look at another Library view | No | Before the library write: untouched. After: as for removing tracks |
| Asking the AI | Yes, works, with a 5 minute limit | Yes | Unchanged | n/a | Untouched |
| Loading the model list | None | Yes, not passed | Yes, a Stop button | n/a | Untouched |
| Applying AI changes | None | Yes | Yes, in the bar, same rules as editing | No | Same as editing |

The engine side of stop was already careful (rollback on any stop during a sync). The change is that the page now uses it from one place, and refuses to offer it where the engine would have to roll back across the library write.

## Findings

Severity: high = could lose data or mislead about the iPod's state; medium = a first-time user is likely to get it wrong; low = rough edge.

| # | What | Why it is a problem | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | A job kept running after a tab change, with no Stop and no result. Tabs were thrown away when you left them | You could not stop an offload or a copy you had walked away from, could start a second one, and never saw its result | High | Fixed: tabs keep their state; Stop and Pause live in the bar |
| 2 | The bar said "Done: copying to the iPod. Now eject" after a sync that rolled back or failed | The engine reports a rolled-back sync as a result, not an error, so the bar read it as success | High | Fixed: the bar reads the report (`outcomeOf`, tested) |
| 3 | Files picked in Add music were lost when you pressed "Go to Backup" | The backup gate sends you to another tab, which threw the list away | High | Fixed (kept tabs) |
| 4 | A backup folder picked as "the iPod" opened as an iPod with tracks, and writing was offered | A backup holds a copy of `iPod_Control` | High | Fixed: explained, not opened (`wrongFolder.ts`, tested) |
| 5 | Removing tracks and deleting leftover files did not say the music cannot come back from the backup | The backup holds no music | High | Fixed: confirm steps that say so and point to Offload |
| 6 | Restore had no confirm and no way to stop | It replaces the library files | High | Fixed: confirm that says what changes and what undoes it; Stop while checking |
| 7 | Add music's Stop did nothing during planning | No signal was passed to the planner | Medium | Fixed for the bar and every plan function. Add music now passes its own signal to the planner, so its Stop button reaches it too |
| 8 | Backup could not be stopped | No signal | Medium | Fixed |
| 9 | Applying AI changes wrote straight from the preview button | Several edits at once, no summary of what would be written | Medium | Fixed: confirm step |
| 10 | "Choose another iPod" dropped the backup and every result with no warning, also mid-job | The page forgets the backup | Medium | Fixed: confirm, and off while a job runs |
| 11 | Double click guard missing: the permission prompt Chrome shows before a write leaves time to click twice | Two jobs could start | Medium | Fixed in Library, restore, write-back test, backup, offload, folder pickers, AI apply. `applySync` is guarded in `tracked.ts` (a second call with the same plan joins the first). `AddPanel` has the guard now, on "Put on the iPod" and "Check and prepare" |
| 12 | A second tab on an iPod could change it at the same time | Two writers | Medium | Warned (BroadcastChannel). Not blocked: that is the write-lock audit's job |
| 13 | Results were not announced or scrolled into view; copy results had no live region | Easy to miss on a phone | Medium | Fixed for the panels touched (`Notice`) |
| 14 | The leftover-files list drew every file | Thousands of rows on a big iPod | Low | Fixed: first 200 shown, all counted |
| 15 | Light theme small print was 2.9 to 3.1:1 (footer, dots, track meta) | Fails 4.5:1 | Low | Fixed (`--faint`). Dark theme passed |
| 16 | Tabs were not a tab list: every tab a tab stop, no arrow keys, panels unnamed | Keyboard and screen reader use | Low | Fixed |
| 17 | The Assistant key box is 38 px tall at 360 px | Under 44 px | Low | Not fixed |
| 18 | Tabs overflow sideways on a phone and cut a name in half ("Backu") | You may not see that Offload and Diagnostics exist | Low | Not fixed |
| 19 | The Diagnostics tab used "rewrite check", "write the rebuilt database back", "libgpod" | Jargon on a screen a person can open | Low | Partly fixed: those two cards renamed and the tab opens with a plain line. The device details table still says libgpod, signing and FireWire ID. It is a technical page |
| 20 | "The sync did not finish." and "Convert and check" in Add music | "Sync" is jargon; "Convert and check" hides that it also plans | Low | Fixed: "Adding the music did not finish." and "Check and prepare" |
| 21 | A read-only iPod or a full one | The first shows up as a failed write, the second as "do not fit" | Low | Not tested. The full case is already handled by the planner |

## Wording

Changed: the library test (was "Rewrite check"), the write-back test, the restore text, the backup "until a sync has been tested" line, "libgpod never opens" on the backup page, "Prepare the write" to "Check what would be written". The strings the smoke test relies on were kept, or the scenario was changed in the same commit (the library test button, one forbidden phrase, the AI apply step).

Not changed: the word "sync" in the top bar ("cannot sync yet") and the environment check, "Offload" as a tab name (it is explained on the tab), and "classic iPod" does not appear in any screen text (it appears in the device list as the model name "iPod classic", which is Apple's name).

Folder names: the backup folder is always "backup folder"; the offload result is "the folder" in "your computer". They are not yet one word for both.

## Done when the branch was merged with main

The Add music work that needed `AddPanel.tsx`, done after the merge with the robustness work, the duplicate finder, album art and offload:

1. Pause for the conversion queue: a `PauseGate` checked between files, "Pause after this file" in the panel and in the bar (Resume, Stop).
2. A once-only guard on "Put on the iPod" (and on "Check and prepare").
3. Stop while reading the picked files and while walking a chosen folder, from the panel and the bar. The files read before the stop stay in the list.
4. A confirm on "Clear the list".
5. The Add music table as one card per file on a phone, each cell under its own label. `FolderGuide.tsx` has no table (only a folder tree and lists), so the tree now scrolls instead of widening the page.
6. Wording: "Adding the music did not finish.", "Check and prepare".
7. Results use `Notice`, so they are announced and scrolled into view.
8. The panel's own "Stop and undo" during the copy is gone: the page's controls are off while a write runs, so the button could never be pressed. The bar's Stop and Pause do the job, and the panel says where they are.

From the robustness review: `allowWriting` is inside the `try` and a failed write is described with `describeError(error, { writing: true })`. Converted files that are held (planned, or being copied) keep a leave-the-page warning through `holdWork()` in `activity.ts`.

Choices made where the two reviews met:

- One reading of a finished job (`judgeWrite` in `tracked.ts`) feeds both the bar (done, stopped, did not finish) and the interrupted-write note. A stop that left the iPod as it was clears the note.
- Every panel is mounted once opened and a `fieldset disabled` wraps all of them, hidden ones too. The tab buttons are outside it and stay on during a write, so the arrow keys work and a running job's tab can be looked at.
- The album art writes have their own progress phase, so Stop is allowed during them. A stop there rolls the art back with the media, byte for byte (tested).

Still not done:

- The Pause for the copy to the iPod (and for putting an offload copy back) is in the bar and covered by engine and unit tests. It was not clicked in a browser during a copy: a copy of a few small files is over in milliseconds.
- `BulkEdit` "Apply to N tracks" and the single-track "Save changes" write at once. They are reversible by editing back, so they were left without a confirm.
- Playlist delete shows the plan before it writes, which is already a confirm step, but its text does not say the tracks stay on the iPod.
- No check of the Assistant tab's 360 px layout beyond the overflow measurement (none found).

## Tests added

- `engine/test/controls.test.mjs` (17 tests): the pause gate; stopping a read, five plan functions, leftover search, backup (and that a stopped backup cannot be restored from), restore (stop honoured while checking, ignored while writing); pausing offload and sync, and stopping while paused.
- `app/test/controls.test.ts`: stop and pause in the activity store, refusing a stop while it is unsafe, reading a report (rolled back, stopped cleanly, failed), the tracked wrapper's signal, the joined double call, the second-tab watcher, and wrong-folder explanations.
- `app/scripts/smoke.mjs`: a scenario after "organising a practice iPod" (tabs keep their list, a single tab stop with one visible panel, Remove asks first and backing out changes nothing, Choose another iPod asks first). The AI scenario now goes through the confirm step.
- `engine/test/stop-and-art.test.mjs` (5 tests, added in the merge with main): the album art has its own progress phase, a stop during the art writes rolls back the media and every art file byte for byte, and putting an offload copy back pauses between files, writes nothing while paused and can be stopped while paused.
- `app/test/integration.test.ts` (12 tests, added in the merge): one reading of a finished job (rolled back, stopped, backup, offload restore) feeds both the bar and the interrupted-write note, the bar's stopped, paused and rolled-back states, the offload restore's Stop being off once the library files are written, and `holdWork()`.
- `app/scripts/smoke.mjs`: two more scenarios after the merge. "Add music controls" (pause while converting, the leave-the-page warning while converted files are held, Clear the list asks first, the table as cards at 390 px with no sideways scroll, Stop while reading a folder) and "kept tabs and the write lock" (every panel, hidden ones too, is off while a write holds the lock; the tab list stays on and the arrow keys work).
- Run on the merged branch: `npm run check`, `npm run engine:test` and the full smoke on port 4491.
