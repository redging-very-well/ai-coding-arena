// "Copy" button with a short "Copied!" confirmation.

import { useState } from 'preact/hooks';
import { copyText, cx } from '../../common/ui.js';

export function CopyButton(props: { text: string; label?: string; class?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      class={cx('copy-btn', props.class, state === 'ok' && 'ok', state === 'fail' && 'fail')}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(props.text);
        setState(ok ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1800);
      }}
    >
      {state === 'ok' ? '✓ Copied!' : state === 'fail' ? 'Select & copy it' : (props.label ?? '📋 Copy')}
    </button>
  );
}
