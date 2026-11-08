import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatBytes, formatDuration, kindLabel } from '@opentunes/core';
import {
  GROUP_OPTIONS,
  KIND_CHIPS,
  SORT_COLUMNS,
  chipCounts,
  filterRows,
  groupRows,
  invertSelection,
  nextSort,
  pageGroups,
  selectState,
  setSelected,
  sortRows,
  type GroupBy,
  type KindChip,
  type Row,
  type Selection,
  type Sort,
  type SortColumn,
} from './organise';

/** Rows drawn at a time. Everything else waits behind "Show more", so thousands of tracks stay quick. */
export const PAGE_SIZE = 200;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function Check({ state, label, disabled, onToggle }: { state: 'none' | 'some' | 'all'; label: string; disabled?: boolean; onToggle: (on: boolean) => void }) {
  return (
    <label class="hit">
      <input
        type="checkbox"
        aria-label={label}
        checked={state === 'all'}
        disabled={disabled}
        ref={(element) => {
          if (element) element.indeterminate = state === 'some';
        }}
        onChange={() => onToggle(state !== 'all')}
      />
    </label>
  );
}

/**
 * The track list: search, kind chips, sort by any column, group, and select. It draws one page of
 * rows and keeps the whole selection, so "select all" takes every track that matches, not only the
 * ones on screen. Shows a table on a wide screen and stacked cards on a narrow one (same markup,
 * the stylesheet decides), and what it draws stays a table for screen readers either way.
 */
export function TrackBrowser({
  rows,
  selected,
  onSelect,
  disabled = false,
  actions,
  label = 'tracks',
}: {
  rows: Row[];
  selected: Selection;
  onSelect: (next: Set<string>) => void;
  disabled?: boolean;
  /** Buttons for the sticky bar that shows while anything is selected. */
  actions?: ComponentChildren;
  /** What the rows are, for the empty message. */
  label?: string;
}) {
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<KindChip>('all');
  const [sort, setSort] = useState<Sort>({ column: null, direction: 'asc' });
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);

  const counts = useMemo(() => chipCounts(rows, search), [rows, search]);
  const matching = useMemo(() => filterRows(rows, { search, chip }), [rows, search, chip]);
  const sorted = useMemo(() => sortRows(matching, sort), [matching, sort]);
  const groups = useMemo(() => groupRows(sorted, groupBy), [sorted, groupBy]);
  const page = useMemo(() => pageGroups(groups, limit, collapsed), [groups, limit, collapsed]);

  // A new view of the list starts at its first page.
  useEffect(() => setLimit(PAGE_SIZE), [search, chip, sort, groupBy, rows]);
  useEffect(() => setCollapsed(new Set()), [groupBy]);

  const overall = selectState(selected, matching);
  const inView = useMemo(() => matching.reduce((sum, row) => sum + (selected.has(row.key) ? 1 : 0), 0), [matching, selected]);
  const hidden = selected.size - inView;
  const filtering = search.trim() !== '' || chip !== 'all';
  const grouped = groupBy !== 'none';
  const left = page.available - page.shown;

  const toggleGroup = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!rows.length) {
    return (
      <div class="empty">
        <strong>No {label}</strong>
        There is nothing here yet.
      </div>
    );
  }

  const sortHeader = (column: SortColumn, text: string, numeric: boolean) => {
    const active = sort.column === column;
    return (
      <th key={column} role="columnheader" scope="col" class={numeric ? 'num' : ''} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" class="sort" onClick={() => setSort(nextSort(sort, column))}>
          {text}
          <span aria-hidden="true" class="arrow">
            {active ? (sort.direction === 'asc' ? '▲' : '▼') : ''}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div class="browser">
      <div class="toolbar">
        <label class="field grow">
          Search
          <input type="search" value={search} onInput={(event) => setSearch((event.target as HTMLInputElement).value)} placeholder="Title, artist, album or genre" />
        </label>
        <label class="field">
          Group by
          <select value={groupBy} onChange={(event) => setGroupBy((event.target as HTMLSelectElement).value as GroupBy)}>
            {GROUP_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {/* On a narrow screen the column headers are hidden, so sorting lives here as well. */}
        <div class="field sort-field">
          <label>
            Sort by
            <select value={sort.column ?? ''} onChange={(event) => setSort({ column: ((event.target as HTMLSelectElement).value || null) as SortColumn | null, direction: sort.direction })}>
              <option value="">Original order</option>
              {SORT_COLUMNS.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" class="secondary" disabled={!sort.column} onClick={() => setSort({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })}>
            {sort.direction === 'asc' ? 'Ascending' : 'Descending'}
          </button>
        </div>
      </div>

      <div class="chips" role="group" aria-label="Show only">
        {KIND_CHIPS.map((entry) => (
          <button key={entry.id} type="button" class="chip" aria-pressed={chip === entry.id} onClick={() => setChip(entry.id)}>
            {entry.label} <span class="count">{counts[entry.id]}</span>
          </button>
        ))}
      </div>

      <div class="select-row">
        <button type="button" class="secondary small" disabled={disabled || !matching.length} onClick={() => onSelect(setSelected(selected, matching, true))}>
          {`Select all${filtering ? ' matching' : ''} (${matching.length})`}
        </button>
        <button type="button" class="secondary small" disabled={disabled || !selected.size} onClick={() => onSelect(new Set())}>
          Select none
        </button>
        <button type="button" class="secondary small" disabled={disabled || !matching.length} onClick={() => onSelect(invertSelection(selected, matching))}>
          Invert
        </button>
        {grouped ? (
          <>
            <button type="button" class="ghost small" onClick={() => setCollapsed(new Set(groups.map((group) => group.id)))}>
              Collapse groups
            </button>
            <button type="button" class="ghost small" onClick={() => setCollapsed(new Set())}>
              Expand groups
            </button>
          </>
        ) : null}
      </div>

      {matching.length === 0 ? (
        <div class="empty">
          <strong>Nothing matches</strong>
          Try fewer words, or pick All.
        </div>
      ) : (
        <>
          <div class="table-wrap stack-wrap">
            <table class="library stack" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col" class="pick">
                    <Check state={overall} label={`Select all ${matching.length} matching tracks`} disabled={disabled} onToggle={(on) => onSelect(setSelected(selected, matching, on))} />
                  </th>
                  {sortHeader('title', 'Title', false)}
                  {sortHeader('artist', 'Artist', false)}
                  {sortHeader('album', 'Album', false)}
                  {sortHeader('kind', 'Kind', false)}
                  {sortHeader('length', 'Length', true)}
                  {sortHeader('size', 'Size', true)}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {page.groups.map((group, index) => {
                  const open = !collapsed.has(group.id);
                  const full = groups[index]?.rows ?? group.rows;
                  return (
                    <Fragment key={group.id}>
                      {grouped ? (
                        <tr key={`group-${group.id}`} role="row" class="group-row">
                          <td role="cell" class="pick">
                            <Check state={selectState(selected, full)} label={`Select all ${full.length} in ${group.label}`} disabled={disabled} onToggle={(on) => onSelect(setSelected(selected, full, on))} />
                          </td>
                          <td role="cell" colSpan={6} class="group-head">
                            <button type="button" class="group-toggle" aria-expanded={open} onClick={() => toggleGroup(group.id)}>
                              <span aria-hidden="true" class="arrow">
                                {open ? '▼' : '▶'}
                              </span>
                              <span class="group-name">{group.label}</span>
                              <span class="count">{plural(full.length, 'track')}</span>
                            </button>
                          </td>
                        </tr>
                      ) : null}
                      {group.rows.map(({ track, key }) => {
                        const on = selected.has(key);
                        return (
                          <tr key={`${group.id}|${track.handle}`} role="row" title={track.ipod_path ?? ''} class={on ? 'selected' : ''}>
                            <td role="cell" class="pick">
                              <Check state={on ? 'all' : 'none'} label={`Select ${track.title ?? 'track'}`} disabled={disabled} onToggle={() => onSelect(setSelected(selected, [{ key, track }], !on))} />
                            </td>
                            <td role="cell" class="cell-title" data-label="Title">
                              {track.title ?? '(no title)'}
                            </td>
                            <td role="cell" class="cell-artist" data-label="Artist">
                              {track.artist ?? ''}
                            </td>
                            <td role="cell" class="cell-album" data-label="Album">
                              {track.album ?? ''}
                            </td>
                            <td role="cell" class="cell-meta" data-label="Kind">
                              {kindLabel(track.kind)}
                            </td>
                            <td role="cell" class="num cell-meta" data-label="Length">
                              {formatDuration(track.tracklen)}
                            </td>
                            <td role="cell" class="num cell-meta" data-label="Size">
                              {formatBytes(track.size)}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div class="more-row">
            <span class="muted" role="status">
              Showing {page.shown} of {page.available} {page.available === 1 ? 'track' : 'tracks'}
              {filtering ? ` (${rows.length} in all)` : ''}.
            </span>
            {left > 0 ? (
              <button type="button" class="secondary" onClick={() => setLimit(limit + PAGE_SIZE)}>
                Show more ({Math.min(PAGE_SIZE, left)} of {left} left)
              </button>
            ) : null}
          </div>
        </>
      )}

      {selected.size ? (
        <div class="selection-bar" role="region" aria-label="Selected tracks">
          <span class="selection-count" aria-live="polite">
            {plural(selected.size, 'track')} selected{hidden > 0 ? ` (${hidden} not in this view)` : ''}
          </span>
          <div class="selection-actions">
            {actions}
            <button type="button" class="ghost" disabled={disabled} onClick={() => onSelect(new Set())}>
              Clear selection
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
