/**
 * Small shared pieces for controls and clarity: a result box that scrolls into view and is
 * announced, an in-page confirm step (never the browser's confirm() box, which some browsers block),
 * a guard that ignores a second click while a job is starting, and a hook that follows a pause gate.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PauseGate, PauseState } from '@opentunes/engine';

/** Room taken at the top of the page by the sticky bars, so a revealed box is not hidden behind them. */
const STICKY_TOP = 130;

/** Scrolls an element into view only when it is not already fully visible, then moves focus to it. */
export function reveal(element: HTMLElement | null, focus = true): void {
  if (!element) return;
  const box = element.getBoundingClientRect?.();
  const height = typeof window !== 'undefined' ? window.innerHeight : 0;
  if (box && height && (box.top < STICKY_TOP || box.bottom > height)) {
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView?.({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  }
  if (focus) element.focus?.({ preventScroll: true });
}

export type Tone = 'ok' | 'no' | 'info' | 'warn';

/**
 * A result or notice. It is announced to screen readers (a problem interrupts, anything else waits
 * its turn), and on a phone it scrolls into view when it appears, so the person sees what happened.
 */
export function Notice({ tone, children, scroll = true, class: className = '' }: { tone: Tone; children: ComponentChildren; scroll?: boolean; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll) reveal(ref.current);
  }, []);
  return (
    <div ref={ref} tabIndex={-1} class={`result ${tone} ${className}`.trim()} role={tone === 'no' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/**
 * A confirm step for something that changes or deletes: it says what will happen and how to undo
 * it, and has a button named for the action. Focus starts on Cancel, so Enter does not confirm it.
 */
export function ConfirmBox({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  disabled = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** What will happen, and how to undo it. */
  children: ComponentChildren;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** True while the action runs, so a second click does nothing. */
  disabled?: boolean;
  /** Turns off only the confirm button, so the person can still back out. For a change that cannot be made right now. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    reveal(box.current, false);
    cancel.current?.focus?.({ preventScroll: true });
  }, []);
  return (
    <div ref={box} class="confirm" role="group" aria-label={title}>
      <h4>{title}</h4>
      <div class="confirm-body">{children}</div>
      <div class="actions">
        <button type="button" class={danger ? 'danger' : ''} disabled={disabled || confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancel} type="button" class="secondary" disabled={disabled} onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Wraps the start of a job so a second click, or a tap that bounces, does nothing while the first
 * is still starting. A button's `disabled` only follows state after the next draw, and the
 * permission prompt Chrome shows before a write leaves a gap long enough to click twice in.
 */
export function useOnce(): <T>(job: () => Promise<T>) => Promise<T | undefined> {
  const running = useRef(false);
  return async <T,>(job: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    try {
      return await job();
    } finally {
      running.current = false;
    }
  };
}

/** Follows a pause gate, so a panel can show Pause, Pausing and Resume. */
export function usePauseState(gate: PauseGate | null): PauseState {
  const [state, setState] = useState<PauseState>(gate?.state ?? 'running');
  useEffect(() => {
    if (!gate) {
      setState('running');
      return undefined;
    }
    setState(gate.state);
    return gate.subscribe(() => setState(gate.state));
  }, [gate]);
  return state;
}
