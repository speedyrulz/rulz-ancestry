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

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={full ? 'dialog full' : wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(event) => {
        // Escape: let the owner unmount the dialog instead of leaving it closed but mounted.
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
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
}: TextFieldProps) {
  const id = useId();
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
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint}
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
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint}
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
