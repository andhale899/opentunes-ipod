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
| Restore everything (putting an offload copy back) | n/a | n/a | This is an Add music job: it gets the same Stop and Pause as copying to the iPod. The button wiring is not done (see below) | Same | As copying |
| Offload | "Stop", lost on a tab change | Yes | "Stop (you can resume later)", also in the bar | Yes, "Pause after this file", in the panel and the bar (engine `pause`) | iPod untouched, copy resumable |
| Library test (rewrite check) | None, and not shown in the bar | No | Yes until the in-memory comparison starts, then off with a reason (it is one uninterruptible step of a few seconds) | No | Untouched |
| Write-back test | None | No | Planning: yes. Writing: off, reason shown ("cannot be stopped safely, takes a few seconds") | No | Put back if it fails |
| Looking for leftover files | None | No | Yes (added `signal` to `findOrphans`) | No | Untouched |
| Deleting leftover files | None | Yes, not passed | Yes, "Stop deleting (files not yet deleted stay)" | No | Files not yet deleted stay |
| Finding duplicates | n/a on this branch | n/a | No duplicate finder exists here. Whatever main added must use `ConfirmBox` before it removes anything, and its remove goes through Library "Remove selected" | n/a | n/a |
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
| 7 | Add music's Stop did nothing during planning | No signal was passed to the planner | Medium | Fixed for the bar and every plan function. The Add music panel's own button is covered by the bar |
| 8 | Backup could not be stopped | No signal | Medium | Fixed |
| 9 | Applying AI changes wrote straight from the preview button | Several edits at once, no summary of what would be written | Medium | Fixed: confirm step |
| 10 | "Choose another iPod" dropped the backup and every result with no warning, also mid-job | The page forgets the backup | Medium | Fixed: confirm, and off while a job runs |
| 11 | Double click guard missing: the permission prompt Chrome shows before a write leaves time to click twice | Two jobs could start | Medium | Fixed in Library, restore, write-back test, backup, offload, folder pickers, AI apply. `applySync` is guarded in `tracked.ts` (a second call with the same plan joins the first). `AddPanel` itself still needs the guard, see below |
| 12 | A second tab on an iPod could change it at the same time | Two writers | Medium | Warned (BroadcastChannel). Not blocked: that is the write-lock audit's job |
| 13 | Results were not announced or scrolled into view; copy results had no live region | Easy to miss on a phone | Medium | Fixed for the panels touched (`Notice`) |
| 14 | The leftover-files list drew every file | Thousands of rows on a big iPod | Low | Fixed: first 200 shown, all counted |
| 15 | Light theme small print was 2.9 to 3.1:1 (footer, dots, track meta) | Fails 4.5:1 | Low | Fixed (`--faint`). Dark theme passed |
| 16 | Tabs were not a tab list: every tab a tab stop, no arrow keys, panels unnamed | Keyboard and screen reader use | Low | Fixed |
| 17 | The Assistant key box is 38 px tall at 360 px | Under 44 px | Low | Not fixed |
| 18 | Tabs overflow sideways on a phone and cut a name in half ("Backu") | You may not see that Offload and Diagnostics exist | Low | Not fixed |
| 19 | The Diagnostics tab used "rewrite check", "write the rebuilt database back", "libgpod" | Jargon on a screen a person can open | Low | Partly fixed: those two cards renamed and the tab opens with a plain line. The device details table still says libgpod, signing and FireWire ID. It is a technical page |
| 20 | "The sync did not finish." and "Convert and check" in Add music | "Sync" is jargon; "Convert and check" hides that it also plans | Low | Not fixed, in `AddPanel.tsx` |
| 21 | A read-only iPod or a full one | The first shows up as a failed write, the second as "do not fit" | Low | Not tested. The full case is already handled by the planner |

## Wording

Changed: the library test (was "Rewrite check"), the write-back test, the restore text, the backup "until a sync has been tested" line, "libgpod never opens" on the backup page, "Prepare the write" to "Check what would be written". The strings the smoke test relies on were kept, or the scenario was changed in the same commit (the library test button, one forbidden phrase, the AI apply step).

Not changed: the word "sync" in the top bar ("cannot sync yet") and the environment check, "Offload" as a tab name (it is explained on the tab), and "classic iPod" does not appear in any screen text (it appears in the device list as the model name "iPod classic", which is Apple's name).

Folder names: the backup folder is always "backup folder"; the offload result is "the folder" in "your computer". They are not yet one word for both.

## What was not done

Needs `AddPanel.tsx` (now free to edit on a rebased copy):

1. **Pause for the conversion queue.** `prepare()` loops over files. Add a `PauseGate` (exported from the engine) and `await gate.checkpoint(signal)` at the top of each loop turn, a "Pause after this file" button using `usePauseState` from `controls.tsx`, and pass the gate to `startActivity('Preparing files', { pause: gate, stop: {...} })` so the bar shows Resume and Stop.
2. **"Put on the iPod" double-click guard.** Wrap `sync()` in `useOnce()` from `controls.tsx`. `tracked.ts` already joins a second call with the same plan, but the panel should not rely on that.
3. **Remove "Stop and undo" from the panel, or leave it.** The bar's Stop is the one that knows when stopping is unsafe. The panel's button is now safe too: `tracked.ts` ignores a caller's stop during the library write and says why in the bar. Showing it disabled with the reason would be clearer.
4. **Stop while reading files** (`addToList`) and while walking a chosen folder: no signal is passed today.
5. **Confirm for "Clear the list".** Use `ConfirmBox` ("Clear 12 files from the list? Nothing on the iPod changes."). The smoke scenario clicks "Clear the list" directly and must then click the confirm button.
6. **Tables to stacked cards on a phone.** The Add music table has 5 columns (File, Kind, What happens, On the iPod, a button). Give each `td` a `data-label` and reuse the `.stack` classes the Library table uses (`table class="library stack"` inside `div class="table-wrap stack-wrap"`). Do the same for the `FolderGuide` table: `FolderGuide.tsx` is free to edit and was not started.
7. **Wording** in `AddPanel`: "The sync did not finish." to "Adding the music did not finish."; "Convert and check" to "Check and prepare".
8. Use `Notice` from `controls.tsx` for the result blocks so they scroll into view and are announced.

Other:

- No Pause button for the Add music copy exists yet (the bar offers it already for any `applySync` call, so it appears as soon as a copy runs). It was not clicked in a browser: a copy of a few small files is over in milliseconds, so it is covered by engine tests only.
- `BulkEdit` "Apply to N tracks" and the single-track "Save changes" write at once. They are reversible by editing back, so they were left without a confirm.
- Playlist delete shows the plan before it writes, which is already a confirm step, but its text does not say the tracks stay on the iPod.
- No check of the Assistant tab's 360 px layout beyond the overflow measurement (none found).
- `tracked.ts`, `activity.ts`, `ActivityBar.tsx`, `IpodViewer.tsx`, `styles.css` and `smoke.mjs` changed on main since this branch started (album art, the duplicate finder, AI presets, the time-left bar). Expect conflicts there. The new CSS is one block at the end of `styles.css` under a marked heading.

## Tests added

- `engine/test/controls.test.mjs` (17 tests): the pause gate; stopping a read, five plan functions, leftover search, backup (and that a stopped backup cannot be restored from), restore (stop honoured while checking, ignored while writing); pausing offload and sync, and stopping while paused.
- `app/test/controls.test.ts`: stop and pause in the activity store, refusing a stop while it is unsafe, reading a report (rolled back, stopped cleanly, failed), the tracked wrapper's signal, the joined double call, the second-tab watcher, and wrong-folder explanations.
- `app/scripts/smoke.mjs`: a scenario after "organising a practice iPod" (tabs keep their list, a single tab stop with one visible panel, Remove asks first and backing out changes nothing, Choose another iPod asks first). The AI scenario now goes through the confirm step.
- Run on this branch: `npm run check`, `npm run engine:test` and the full smoke on port 4482.
