/** Tells the person why a button that changes the iPod is off, and how to turn it on. */
export function BackupGate({ ready, onGo }: { ready: boolean; onGo?: () => void }) {
  if (ready) return null;
  return (
    <div class="callout warn" role="note">
      <p>
        <strong>Make a backup first.</strong> Changes to the iPod stay off until a complete backup exists from this session. The backup is what lets you undo a bad write.
      </p>
      {onGo ? (
        <div class="actions">
          <button type="button" class="secondary small" onClick={onGo}>
            Go to Backup
          </button>
        </div>
      ) : null}
    </div>
  );
}
