'use client';

import SignaturePad from 'signature_pad';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SignatureMode = 'draw' | 'type';

export interface SignatureValue {
  mode: SignatureMode;
  /** PNG data URL, rendered from the canvas (draw) or from the typed name (type). */
  dataUrl: string;
  /** Typed text, kept as evidence of what the signer entered. */
  text?: string;
}

interface Props {
  fullName: string;
  onChange: (value: SignatureValue | null) => void;
  labels?: { draw: string; type: string; clear: string; typePlaceholder: string };
  fontFamily?: string;
}

const DEFAULT_LABELS = { draw: 'Draw', type: 'Type', clear: 'Clear', typePlaceholder: 'Type your name' };
const W = 600;
const H = 200;

function renderTyped(text: string, fontFamily: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx || !text.trim()) return '';
  ctx.scale(2, 2);
  ctx.fillStyle = '#111';
  ctx.font = `64px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, H / 2, W - 32);
  return canvas.toDataURL('image/png');
}

/** Drawn (signature_pad) or typed signature. Output is an image plus the raw typed text; the server records evidence, this only captures intent. */
export function SignatureCapture({
  fullName,
  onChange,
  labels = DEFAULT_LABELS,
  fontFamily = 'cursive',
}: Props) {
  const [mode, setMode] = useState<SignatureMode>('draw');
  const [typed, setTyped] = useState(fullName);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode !== 'draw' || !canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d')?.scale(ratio, ratio);
    const pad = new SignaturePad(canvas, { penColor: '#111' });
    pad.addEventListener('endStroke', () => {
      onChange(pad.isEmpty() ? null : { mode: 'draw', dataUrl: pad.toDataURL('image/png') });
    });
    padRef.current = pad;
    return () => {
      pad.off();
      padRef.current = null;
    };
  }, [mode, onChange]);

  useEffect(() => {
    if (mode !== 'type') return;
    const dataUrl = renderTyped(typed, fontFamily);
    onChange(dataUrl ? { mode: 'type', dataUrl, text: typed } : null);
  }, [mode, typed, fontFamily, onChange]);

  const clear = useCallback(() => {
    padRef.current?.clear();
    setTyped('');
    onChange(null);
  }, [onChange]);

  return (
    <div className="space-y-3">
      <div role="tablist" className="inline-flex rounded-md border p-0.5 text-sm">
        {(['draw', 'type'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className="rounded px-3 py-1 aria-selected:bg-foreground aria-selected:text-background"
          >
            {labels[m]}
          </button>
        ))}
      </div>
      {mode === 'draw' ? (
        <canvas
          ref={canvasRef}
          aria-label={labels.draw}
          className="h-[200px] w-full touch-none rounded-md border bg-white"
        />
      ) : (
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={labels.typePlaceholder}
          maxLength={80}
          className="h-12 w-full rounded-md border px-3"
        />
      )}
      <button type="button" onClick={clear} className="text-sm underline">
        {labels.clear}
      </button>
    </div>
  );
}
