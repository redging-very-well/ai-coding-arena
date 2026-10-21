// Join (plan §12.1, §4): "New player" / "I'm back" tabs, a name field and a
// big 4-digit PIN keypad (the keyboard's digits work too).

import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api } from '../../common/api.js';
import { cx, PHASE_TEXT } from '../../common/ui.js';
import { nameProblem, pinKey, PIN_RE } from '../logic.js';
import { getStore, useStore } from '../store.js';

type Mode = 'new' | 'back';

export function Join() {
  const st = useStore();
  const store = getStore();
  const [mode, setMode] = useState<Mode>('new');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  const fail = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const submit = async () => {
    if (busy) return;
    const problem = nameProblem(name);
    if (problem) return fail(problem);
    if (!PIN_RE.test(pin)) return fail(mode === 'new' ? 'Pick a secret 4-digit PIN.' : 'Type your 4-digit PIN.');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') await api.join(name.trim(), pin);
      else await api.login(name.trim(), pin);
      await store.afterJoin();
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      const msg =
        e?.code === 'NAME_TAKEN'
          ? 'Someone already has that name. Pick another one, or tap “I\'m back” if it\'s you.'
          : e?.code === 'BAD_LOGIN'
            ? "That name and PIN don't match. Try again!"
            : e?.code === 'GAME_FULL'
              ? 'The game is full right now. Ask a grown-up for help.'
              : e?.code === 'RATE_LIMITED'
                ? 'Too many tries! Wait a minute, then try again.'
                : (e?.playerMessage ?? 'Oops, that didn\'t work. Try again!');
      setPin('');
      fail(msg);
    } finally {
      setBusy(false);
    }
  };

  // Digits typed anywhere outside the name field go to the PIN.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        if (e.key === 'Enter') {
          e.preventDefault();
          // Name done: digits now go to the PIN (or log in if it's complete).
          if (PIN_RE.test(pin)) void submit();
          else e.target.blur();
        }
        return;
      }
      if (/^\d$/.test(e.key)) setPin((p) => pinKey(p, e.key));
      else if (e.key === 'Backspace') setPin((p) => pinKey(p, 'back'));
      else if (e.key === 'Enter') void submit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const phase = st.game?.phase;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'go'];

  return (
    <main class="join">
      <h1 class="logo">
        PIXEL
        <br />
        CLASH
      </h1>
      {phase && <p class="dim">{phase === 'LOBBY' ? 'Join the game!' : PHASE_TEXT[phase].title}</p>}
      <div class={cx('panel join-card', shake && 'shake')}>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'new'} class={cx('tab', mode === 'new' && 'on')} onClick={() => setMode('new')}>
            New player
          </button>
          <button role="tab" aria-selected={mode === 'back'} class={cx('tab', mode === 'back' && 'on')} onClick={() => setMode('back')}>
            I'm back
          </button>
        </div>
        <label class="field">
          <span>{mode === 'new' ? 'Pick a player name' : 'Your player name'}</span>
          <input
            id="join-name"
            ref={nameRef}
            value={name}
            maxLength={16}
            autoComplete="off"
            autoCapitalize="words"
            spellcheck={false}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="e.g. Ninja Sam"
          />
        </label>
        <div class="field">
          <span>
            {mode === 'new' ? 'Pick a secret 4-digit PIN' : 'Your 4-digit PIN'}{' '}
            <button class="mini ghost" onClick={() => setShowPin((v) => !v)}>
              {showPin ? 'hide' : 'show'}
            </button>
          </span>
          <div class="pin-dots" aria-label={`${pin.length} of 4 digits`}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} class={cx('pin-dot', i < pin.length && 'on')}>
                {i < pin.length ? (showPin ? pin[i] : '●') : ''}
              </span>
            ))}
          </div>
        </div>
        <div class="pin-pad" id="pin-pad">
          {keys.map((k) =>
            k === 'go' ? (
              <button key={k} class="key go" disabled={busy} onClick={() => void submit()}>
                {busy ? '…' : 'GO'}
              </button>
            ) : (
              <button key={k} class={cx('key', k === 'back' && 'back')} onClick={() => setPin((p) => pinKey(p, k))} aria-label={k === 'back' ? 'Delete' : k}>
                {k === 'back' ? '⌫' : k}
              </button>
            ),
          )}
        </div>
        {error && (
          <p class="note bad" role="alert">
            {error}
          </p>
        )}
        {mode === 'new' && <p class="dim small">Remember your PIN! You (and Claude) need it to log in.</p>}
      </div>
    </main>
  );
}
