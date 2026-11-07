# Testing on Android

Goal: find out what your phone's Chrome supports and whether it can reach an iPod. Nothing here has been run yet, so treat the steps as a first attempt and correct them where reality differs.

## What you need

- An Android phone with Chrome.
- The iPod nano 7th generation, and a cable that connects it to the phone: Lightning to USB-C, or Lightning to USB-A plus a USB-C OTG adapter.
- Your computer and phone on the same Wi-Fi.

## Why a plain local address does not work

Chrome only offers WebUSB and folder access on secure pages. `http://localhost` counts as secure, but `http://192.168.1.20:5173` does not, so the app reports "Secure page: No" and every check fails. There are two ways round it, both local to your network.

### Option A: tell Chrome to trust your computer's address (simplest)

1. On the computer, run `npm run dev:lan`. It prints a Network address such as `http://192.168.1.20:5173`.
2. On the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
3. Turn the flag on, add that address to the text box, and tap Relaunch.
4. Open the address in Chrome on the phone.

Remove the flag afterwards. It lowers Chrome's protection for that address.

### Option B: forward the port with adb

This makes the phone's `localhost` point at your computer, so the page counts as secure with no flag. It needs `adb` and a wireless debugging connection, because the phone's USB port is busy with the iPod.

1. Pair the phone over wireless debugging (`adb pair`, then `adb connect`).
2. Run `adb reverse tcp:5173 tcp:5173`.
3. Run `npm run dev` and open `http://localhost:5173` on the phone.

## What to do on the page

1. Read the verdict and the feature list. Note any "No" or "Missing".
2. Connect the iPod so it appears as a drive on the phone (a USB drive notification, or in the Files app). If it does not appear, that is a result, write it down.
3. Tap **Check USB device** and choose the iPod.
4. Tap **Check iPod folder** and choose the iPod's drive.
5. Tap **Run write test**.
6. Tap **Copy report** and keep it.

## What the results mean

| Result | Meaning |
| --- | --- |
| Folder access: Yes, folder check finds `iPod_Control` | Chrome on this phone can open the iPod. The Android path is viable. |
| Folder access: No | This Chrome version has no folder picker. Update Chrome, or Android sync is not possible. A status listing says support starts at Chrome 132 on Android, which is unconfirmed. |
| USB check fails, folder check works | Android may be holding the iPod as storage. Identity may need another route. Write down the exact message. |
| Folder check works but shows no `iPod_Control` | The iPod may be empty or restored; Phase 1 adds initialisation. |
| Write test fails | Read-only mount, or a Chrome limit on removable storage. |

Android mounts FAT32 and exFAT volumes. It generally cannot read Mac-formatted (HFS+) volumes. Which format your nano 7G uses is an open question, see [ROADMAP.md](ROADMAP.md).
