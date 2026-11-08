import { useMemo, useState } from 'preact/hooks';
import { kindLabel } from '@opentunes/core';
import type { TrackEdit } from '@opentunes/engine';
import { BULK_TEXT_FIELDS, EMPTY_BULK, KINDS, planBulkEdit, type BulkForm, type Row } from './organise';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * One form for the selected tracks: artist, album, album artist, genre and kind. A blank box
 * leaves that field as it is. It says how many tracks would change before anything is written,
 * and the page applies all of them in one sync run.
 */
export function BulkEdit({
  selected,
  busy,
  ready,
  onApply,
}: {
  selected: Row[];
  busy: boolean;
  ready: boolean;
  /** Writes the edits. Returns true when it worked, so the form can clear. */
  onApply: (edits: TrackEdit[]) => Promise<boolean>;
}) {
  const [form, setForm] = useState<BulkForm>(EMPTY_BULK);
  const plan = useMemo(() => planBulkEdit(selected, form), [selected, form]);
  const change = (field: keyof BulkForm, value: string) => setForm({ ...form, [field]: value });

  async function apply() {
    if (await onApply(plan.edits)) setForm(EMPTY_BULK);
  }

  const asked = plan.set.length > 0;
  return (
    <div class="bulk">
      <h4>{selected.length === 1 ? 'Change more details of this track' : `Change details of ${selected.length} tracks`}</h4>
      <p class="note">Leave a box empty to keep what each track has now.</p>
      <div class="bulk-grid">
        {BULK_TEXT_FIELDS.map(([name, label]) => (
          <label class="field" key={name}>
            {label}
            <input type="text" value={form[name]} disabled={busy} placeholder="Keep as it is" onInput={(event) => change(name, (event.target as HTMLInputElement).value)} />
          </label>
        ))}
        <label class="field">
          Kind
          <select value={form.kind} disabled={busy} onChange={(event) => change('kind', (event.target as HTMLSelectElement).value)}>
            <option value="">Keep as it is</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(kind)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p class="bulk-preview" role="status">
        {!asked
          ? 'Nothing to change yet. Fill in a box to see what would happen.'
          : plan.changing === 0
            ? `All ${plural(selected.length, 'selected track')} already have these values, so nothing would change.`
            : `${plural(plan.changing, 'track')} would change (${plan.set.map((entry) => `${entry.label.toLowerCase()} to "${entry.value}"`).join(', ')})${plan.alreadyMatching ? `, and ${plural(plan.alreadyMatching, 'track')} already match` : ''}. All in one write.`}
      </p>
      <button type="button" disabled={busy || !ready || plan.changing === 0} onClick={() => void apply()}>
        {plan.changing ? `Apply to ${plural(plan.changing, 'track')}` : 'Apply changes'}
      </button>
    </div>
  );
}
