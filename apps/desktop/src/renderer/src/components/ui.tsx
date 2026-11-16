import { describeDate, parseDate } from '@rulz/core';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { errorMessage } from '../api';

/** Small pieces shared by the screens: the modal dialog, form rows and the submit helper. */

interface DialogProps {
  title: string;
  /** Called when the user dismisses the dialog with Escape. */
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
  /** Takes nearly the whole window, for something to look at, such as a picture. */
  full?: boolean;
}

/** What can take the focus by keyboard. */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/** A modal dialog. It is mounted while it is open and removed when closed. */
export function Dialog({
  title,
  onClose,
  children,
  testId,
  wide = false,
  full = false,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  /** The control that had the focus when the dialog opened; the focus goes back to it. */
  const [opener] = useState<Element | null>(() => document.activeElement);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) {
      dialog.showModal();
      // The browser starts at the first control; a field that asked for the focus gets it.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }

    // When the control that has the focus is removed (a button that turns into
    // something else), the focus falls to the page. Bring it back into the dialog.
    // This is the last resort: it waits a moment so that a screen that knows where the focus
    // belongs (a heading, a result) gets there first, then looks again.
    let waiting = 0;
    const rescue = () => {
      waiting = 0;
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (!dialog.isConnected || !dialog.open || dialog.querySelector('dialog[open]') !== null) {
        return;
      }
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog.querySelector<HTMLElement>('h2'))?.focus();
    };
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (waiting === 0) waiting = window.setTimeout(rescue, 50);
    });
    observer.observe(dialog, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      window.clearTimeout(waiting);
      // The dialog is gone: hand the focus back to what opened it, unless something took it.
      queueMicrotask(() => {
        if (dialog.isConnected) return;
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      });
    };
  }, [opener]);

  return (
    <dialog
      ref={ref}
      className={full ? 'dialog full' : wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={titleId}
      aria-modal="true"
      data-testid={testId}
      onCancel={(event) => {
        // Escape: let the owner unmount the dialog instead of leaving it closed but mounted.
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </dialog>
  );
}

interface SubmitState {
  busy: boolean;
  error: string | null;
  /** Runs the action; shows its error, if it fails, instead of throwing. Resolves to true on success. */
  submit: () => Promise<boolean>;
}

/**
 * Wraps an action so a form can show that it is running and why it failed.
 * The main process explains refusals in words meant for the user ("a person
 * cannot be their own parent"), so the message is shown as it is.
 */
export function useSubmit(action: () => Promise<void>): SubmitState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }, [action]);

  return { busy, error, submit };
}

interface FormDialogProps {
  title: string;
  submitLabel: string;
  /** Does the work. The dialog stays open and shows the message if this throws. */
  onSubmit: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
  /** Set to stop the form being submitted, e.g. while nothing is selected. */
  disabled?: boolean;
  danger?: boolean;
  /**
   * Shown in the dialog above the form, and not part of it: something with
   * buttons and dialogs of its own, which must not end up inside this form.
   */
  before?: ReactNode;
}

/** A dialog holding one form with Cancel and a submit button. */
export function FormDialog({
  title,
  submitLabel,
  onSubmit,
  onClose,
  children,
  testId,
  wide = false,
  disabled = false,
  danger = false,
  before,
}: FormDialogProps) {
  const { busy, error, submit } = useSubmit(onSubmit);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || disabled) return;
    void submit().then((done) => {
      if (done) onClose();
    });
  };

  return (
    <Dialog title={title} onClose={onClose} wide={wide} {...(testId ? { testId } : {})}>
      {before}
      <form onSubmit={handleSubmit} noValidate>
        {children}
        {error !== null && (
          <p className="error" role="alert" data-testid="dialog-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className={danger ? 'danger' : 'primary'}
            disabled={busy || disabled}
            data-testid="dialog-submit"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}

/** Asks before an action that removes something. */
export function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  return (
    <FormDialog
      title={title}
      submitLabel={confirmLabel}
      onSubmit={onConfirm}
      onClose={onClose}
      testId="confirm-dialog"
      danger
    >
      <div className="dialog-text">{children}</div>
    </FormDialog>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  autoFocus?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Text shown under the field. */
  hint?: ReactNode;
  /** Says what is wrong with the value; the field is marked invalid and the text is read with it. */
  error?: string | null;
}

/** The ids that tie a field to the text under it, and what a screen reader reads with the field. */
function useDescription(hint: ReactNode, error: string | null | undefined) {
  const hintId = useId();
  const errorId = useId();
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== '';
  const ids = [hasHint ? hintId : null, hasError ? errorId : null].filter((id) => id !== null);
  return {
    hintId,
    errorId,
    hasHint,
    hasError,
    describedBy: ids.length === 0 ? undefined : ids.join(' '),
  };
}

export function TextField({
  label,
  value,
  onChange,
  testId,
  autoFocus = false,
  placeholder,
  maxLength = 200,
  hint,
  error,
}: TextFieldProps) {
  const id = useId();
  const { hintId, errorId, hasHint, hasError, describedBy } = useDescription(hint, error);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? 'true' : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={hasError ? true : undefined}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hasHint && (
        <div id={hintId} className="field-hint">
          {hint}
        </div>
      )}
      {hasError && (
        <p id={errorId} className="error field-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  /** Text shown under the field. */
  hint?: ReactNode;
}

/** A field for text of several lines. */
export function TextAreaField({
  label,
  value,
  onChange,
  testId,
  rows = 3,
  maxLength = 5000,
  placeholder,
  hint,
}: TextAreaFieldProps) {
  const id = useId();
  const { hintId, hasHint, describedBy } = useDescription(hint, null);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        spellCheck={false}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hasHint && (
        <div id={hintId} className="field-hint">
          {hint}
        </div>
      )}
    </div>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  testId?: string;
  disabled?: boolean;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled = false,
}: SelectFieldProps<T>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Says how the app reads a date as it is typed, so a misread date is noticed at once. */
export function DateHint({ text }: { text: string }) {
  const parsed = parseDate(text);
  if (!parsed) return null;
  const reading = describeDate(parsed);
  return (
    <p className="hint" data-testid="date-hint">
      {reading === null
        ? 'Not recognised as a date. It is kept as written, but cannot be sorted.'
        : `Read as: ${reading}`}
    </p>
  );
}

interface DateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}

export function DateField({ label, value, onChange, testId }: DateFieldProps) {
  return (
    <TextField
      label={label}
      value={value}
      onChange={onChange}
      placeholder="e.g. 12 Mar 1881, abt 1850, bef 1900"
      hint={<DateHint text={value} />}
      {...(testId ? { testId } : {})}
    />
  );
}
