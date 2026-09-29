'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, type ButtonSize } from './button';

/**
 * Two-step inline confirmation for destructive actions: the first click reveals what will happen and a
 * confirm/cancel pair, with focus moved to Cancel so a stray Enter never confirms.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  description,
  onConfirm,
  loading = false,
  disabled = false,
  size,
}: {
  label: string;
  confirmLabel: string;
  description?: React.ReactNode;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  disabled?: boolean;
  size?: ButtonSize;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <Button variant="danger" size={size} disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="stack">
      {description ? <p className="fine-print">{description}</p> : null}
      <div className="actions">
        <Button
          variant="danger"
          size={size}
          loading={loading}
          disabled={disabled}
          onClick={async () => {
            await onConfirm();
            setConfirming(false);
          }}
        >
          {confirmLabel}
        </Button>
        <Button ref={cancelRef} size={size} disabled={loading} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
