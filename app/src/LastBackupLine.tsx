import { useEffect, useRef, useState } from 'preact/hooks';
import type { BackupReport, DirectoryEntry } from '@opentunes/engine';
import { BACKUP_PANEL_ID, BACKUP_START_ID } from './BackupPanel';
import { ConfirmBox, reveal } from './controls';
import { describeError } from './describeError';
import { loadBackupRecord, type SavedBackup } from './handles';
import { regainAccess } from './ipodAccess';
import { dateText, permissionNow, type BackupInfo, type LastBackup } from './lastBackup';
import { logError, logOk, logStep } from './log';
import { checkLastBackupTracked } from './tracked';

export interface LastBackupControls {
  state: LastBackup;
  /** The click on "Check my last backup": asks Chrome for access to the backup folder, then checks. */
  checkNow: () => void;
  /** The person confirmed using the older backup anyway. */
  useOlder: () => void;
}

/**
 * Looks for the backup remembered for the iPod that was just opened and checks it, with no click
 * when Chrome already allows the folder. A backup that matches is counted at once (`accept`, with
 * kind 'verified'); one that does not match is never counted on its own. Real iPod folders only.
 */
export function useLastBackup(
  open: { root: DirectoryEntry; folderName: string; source: 'folder' | 'demo' | 'practice' } | null,
  /** Changes whenever an iPod is opened or read again after an outside change, which is when to look. */
  epoch: number,
  /** The backup this session counts now, so a check that finishes late never replaces a newer one. */
  current: BackupReport | null,
  accept: (report: BackupReport, info: BackupInfo) => void,
): LastBackupControls {
  const [state, setState] = useState<LastBackup>({ status: 'none' });
  const latest = useRef({ current, accept, open });
  latest.current = { current, accept, open };
  const token = useRef(0);

  async function check(record: SavedBackup, mine: number): Promise<void> {
    const where = latest.current.open;
    if (!where) return;
    setState({ status: 'checking', record });
    logStep('backup', `Checking the last backup for "${where.folderName}": "${record.folder}" in "${record.destinationName}".`);
    let result: LastBackup;
    try {
      result = await checkLastBackupTracked(record, where.root, { now: Date.now(), permission: 'granted' });
    } catch (error) {
      result = { status: 'problem', record, reason: 'unreadable', message: `The last backup could not be checked: ${describeError(error)}` };
    }
    if (mine !== token.current) return;
    setState(result);
    if (result.status === 'matches') {
      if (!latest.current.current?.complete) {
        logOk('backup', `The last backup "${record.folder}" passed every check, the iPod still matches it, and it counts as the backup. No new backup is needed.`);
        latest.current.accept(result.report, { kind: 'verified', madeAt: record.madeAt });
      }
    } else if (result.status === 'differs') {
      logStep('backup', `The last backup "${record.folder}" is good, but the iPod changed since: ${result.changes}. The person is asked what to do.`);
    } else if (result.status === 'problem') {
      logError('backup', `The last backup "${record.folder}" was not used (${result.reason}): ${result.message}`);
    }
  }

  useEffect(() => {
    const mine = ++token.current;
    if (!open || open.source !== 'folder') {
      setState({ status: 'none' });
      return undefined;
    }
    void (async () => {
      const record = await loadBackupRecord(open.folderName);
      if (mine !== token.current) return;
      if (!record) {
        setState({ status: 'none' });
        return;
      }
      const permission = await permissionNow(record.destination);
      if (mine !== token.current) return;
      if (permission !== 'granted') {
        logStep('backup', `A backup is remembered for "${open.folderName}", but Chrome has not given this page access to its folder yet. "Check my last backup" asks for it.`);
        setState({ status: 'needs-permission', record });
        return;
      }
      await check(record, mine);
    })();
    return () => {
      token.current += 1;
    };
  }, [open?.root, epoch]);

  return {
    state,
    checkNow() {
      if (state.status !== 'needs-permission') return;
      const record = state.record;
      const mine = token.current;
      void (async () => {
        let answer: 'granted' | 'denied';
        try {
          // First thing in the click, so Chrome can still show its permission prompt.
          answer = await regainAccess(record.destination, 'read');
        } catch (error) {
          answer = 'denied';
          logError('backup', `Chrome could not be asked for the backup folder: ${describeError(error)}`);
        }
        if (mine !== token.current) return;
        if (answer !== 'granted') {
          logError('backup', 'Access to the last backup folder was not given.');
          setState({ status: 'needs-permission', record, refused: `Chrome did not give access to the folder "${record.destinationName}". Try again and choose Allow, or make a new backup.` });
          return;
        }
        await check(record, mine);
      })();
    },
    useOlder() {
      if (state.status !== 'differs') return;
      logStep('backup', `The older backup "${state.record.folder}" from ${dateText(state.record.madeAt)} was chosen to be used anyway, after the iPod changed since: ${state.changes}.`);
      latest.current.accept(state.report, { kind: 'older', madeAt: state.record.madeAt });
    },
  };
}

/** Brings the person to the backup panel's start button. */
export function goToBackupPanel(): void {
  reveal(document.getElementById(BACKUP_PANEL_ID), false);
  document.getElementById(BACKUP_START_ID)?.focus({ preventScroll: true });
}

/**
 * Step 1's line about the last backup: one quiet line when it still matches, one button when
 * Chrome needs a click, and the plain reason (or both choices) when it cannot simply be used.
 */
export function LastBackupLine({ controls, backup, info }: { controls: LastBackupControls; backup: BackupReport | null; info: BackupInfo | null }) {
  const { state } = controls;
  const [asking, setAsking] = useState(false);
  const counted = backup !== null && backup.complete;
  // A backup made in this session is shown by the panel's own result.
  if (counted && info?.kind === 'made') return null;

  if (counted && info?.kind === 'verified' && 'record' in state) {
    return (
      <p class="last-backup ok" role="status">
        Backup from {dateText(state.record.madeAt)} in "{state.record.folder}" (in "{state.record.destinationName}") still matches this iPod, so you do not need another.{' '}
        <button type="button" class="secondary small" onClick={goToBackupPanel}>
          Make a new backup anyway
        </button>
      </p>
    );
  }

  if (counted && info?.kind === 'older' && 'record' in state) {
    return (
      <p class="last-backup warn" role="status">
        You chose the older backup from {dateText(state.record.madeAt)} in "{state.record.folder}". The iPod has changed since, so restoring it would take the library back to that date.{' '}
        <button type="button" class="secondary small" onClick={goToBackupPanel}>
          Make a new backup
        </button>
      </p>
    );
  }
  if (counted) return null;

  switch (state.status) {
    case 'checking':
      return (
        <p class="last-backup" role="status">
          Checking your last backup, "{state.record.folder}" in "{state.record.destinationName}"...
        </p>
      );
    case 'needs-permission':
      return (
        <div class="last-backup">
          <p>
            This browser made a backup of this iPod on {dateText(state.record.madeAt)}, in "{state.record.folder}" inside "{state.record.destinationName}". Chrome asks before this page may read that folder again.
          </p>
          <div class="actions">
            <button type="button" onClick={controls.checkNow}>
              Check my last backup
            </button>
          </div>
          {state.refused ? (
            <div class="result no" role="alert">
              <p>{state.refused}</p>
            </div>
          ) : null}
        </div>
      );
    case 'differs':
      return (
        <div class="callout warn last-backup" role="group" aria-label="The last backup is out of date">
          <p>
            <strong>Your last backup is out of date.</strong> {state.message} It was made on {dateText(state.record.madeAt)}.
          </p>
          {asking ? (
            <ConfirmBox
              title="Use the older backup anyway?"
              confirmLabel="Yes, use the older backup"
              cancelLabel="Do not use it"
              danger
              onConfirm={() => {
                setAsking(false);
                controls.useOlder();
              }}
              onCancel={() => setAsking(false)}
            >
              <p>
                A restore from that backup would take the iPod's library back to {dateText(state.record.madeAt)}. Anything added or changed since then would be lost from the library.
              </p>
              <p>The app's own changes are still undone automatically if they fail. This only matters if you later restore this older backup yourself.</p>
            </ConfirmBox>
          ) : (
            <div class="actions">
              <button type="button" onClick={goToBackupPanel}>
                Make a new backup
              </button>
              <button type="button" class="secondary" onClick={() => setAsking(true)}>
                Use that old backup anyway
              </button>
            </div>
          )}
        </div>
      );
    case 'problem':
      return (
        <div class="callout no last-backup" role="alert">
          <p>
            <strong>Your last backup cannot be used.</strong> {state.message}
          </p>
          <div class="actions">
            <button type="button" onClick={goToBackupPanel}>
              Make a new backup
            </button>
          </div>
        </div>
      );
    default:
      return null;
  }
}
