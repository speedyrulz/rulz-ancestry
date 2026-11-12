import { MEDIA_LIMITS } from '@rulz/core';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  mediaUrl,
  type MediaAddResult,
  type MediaDetails,
  type MediaInfo,
  type MediaListPage,
  type MediaTarget,
  type MediaUseInfo,
  type TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, formatSize, fullName, labelOf } from '../format';
import { ConfirmDialog, Dialog, TextAreaField, TextField, useSubmit } from './ui';

/**
 * Pictures and documents: the grid of small pictures, the button that adds
 * files, the viewer with zoom, and the list of every file in the tree.
 *
 * A picture is loaded from an address of the app's media scheme, which the
 * main process answers from the open tree's media folder (see `mediaUrl`).
 */

/** What a file is called on screen: its title, or the name it had when it was added. */
export function mediaTitle(media: Pick<MediaInfo, 'title' | 'fileName'>): string {
  if (media.title !== '') return media.title;
  return media.fileName !== '' ? media.fileName : 'File with no name';
}

/** The kind of a file in a word or two, e.g. "PNG picture". */
function kindLabel(media: MediaInfo): string {
  const ext = media.ext.toUpperCase();
  if (media.mime.startsWith('image/')) return ext === '' ? 'Picture' : `${ext} picture`;
  if (media.mime === 'application/pdf') return 'PDF document';
  if (media.mime.startsWith('audio/')) return `${ext} sound recording`.trim();
  if (media.mime.startsWith('video/')) return `${ext} film`.trim();
  return ext === '' ? 'File' : `${ext} file`;
}

/** The small picture of a file, or a tile saying what it is when there is no picture to show. */
function Preview({ media }: { media: MediaInfo }) {
  const [failed, setFailed] = useState(false);
  if (!media.present) {
    return (
      <span className="media-none" data-testid="media-missing">
        File missing
      </span>
    );
  }
  // The main process makes a preview only of pictures and of documents it would also open.
  if (failed || (media.kind !== 'image' && !media.canOpen)) {
    return (
      <span className="media-none" data-testid="media-no-preview">
        {media.ext === '' ? 'File' : media.ext.toUpperCase()}
      </span>
    );
  }
  // Windows can make a preview of more kinds of file than pictures. Where it
  // cannot, the address answers "not found" and the tile is shown instead.
  return (
    <img
      src={mediaUrl(media.id, 'thumb')}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      data-testid="media-thumb"
    />
  );
}

interface MediaGridProps {
  items: readonly MediaInfo[];
  /** Called to look at a file. */
  onOpen: (mediaId: string) => void;
  /** A line under a file's name, e.g. what it is attached to. */
  noteOf?: (media: MediaInfo) => string;
}

/** Files as a grid of small pictures. Each opens the viewer. */
export function MediaGrid({ items, onOpen, noteOf }: MediaGridProps) {
  return (
    <ul className="media-grid" data-testid="media-grid">
      {items.map((media) => {
        const note = noteOf?.(media) ?? '';
        return (
          <li key={media.id}>
            <button
              type="button"
              className="media-tile"
              title={mediaTitle(media)}
              onClick={() => onOpen(media.id)}
              data-testid="media-tile"
            >
              <span className="media-thumb">
                <Preview media={media} />
              </span>
              <span className="media-caption" data-testid="media-caption">
                {mediaTitle(media)}
              </span>
              {note !== '' && (
                <span className="media-note" data-testid="media-note">
                  {note}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface AddState {
  busy: boolean;
  /** What the last attempt has to say, if anything. */
  message: { text: string; error: boolean } | null;
  /** Shows the file picker and adds what is chosen, attached to `target` or to nothing. */
  add: (target: MediaTarget | null) => Promise<void>;
}

/** What to tell the user after files were added; null when the result speaks for itself. */
function addSummary(result: MediaAddResult, attaching: boolean): string | null {
  if (attaching) {
    const already = result.chosen - result.attached;
    return already === 0
      ? null
      : `${countOf(already, 'file was', 'files were')} attached here already.`;
  }
  const known = result.chosen - result.added;
  return known === 0 ? null : `${countOf(known, 'file is', 'files are')} in this tree already.`;
}

function useAddMedia(onTree: (tree: TreeState) => void): AddState {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<AddState['message']>(null);

  const add = async (target: MediaTarget | null) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.addMedia(target);
      // Null means the file picker was cancelled.
      if (result === null) return;
      onTree(result.tree);
      const text = addSummary(result, target !== null);
      setMessage(text === null ? null : { text, error: false });
    } catch (failure) {
      setMessage({ text: errorMessage(failure), error: true });
    } finally {
      setBusy(false);
    }
  };

  return { busy, message, add };
}

function AddMessage({ message }: { message: AddState['message'] }) {
  if (message === null) return null;
  return message.error ? (
    <p className="error" role="alert" data-testid="media-error">
      {message.text}
    </p>
  ) : (
    <span className="muted" role="status" data-testid="media-message">
      {message.text}
    </span>
  );
}

interface MediaStripProps {
  /** What the files are attached to. */
  target: MediaTarget;
  /** Goes up when the tree changes, so the files are read again. */
  revision: number;
  onTree: (tree: TreeState) => void;
  /** Called to show a person named in the viewer. */
  onSelect?: (personId: string) => void;
  addLabel?: string;
  /** Shown while nothing is attached. */
  emptyText?: string;
}

/**
 * The files attached to one thing, with a button to add more. It reads the
 * files itself, so it can be put wherever something can have files.
 */
export function MediaStrip({
  target,
  revision,
  onTree,
  onSelect,
  addLabel = 'Add pictures or documents',
  emptyText,
}: MediaStripProps) {
  const { type, id } = target;
  const targetKey = `${type}|${id}`;
  const [loaded, setLoaded] = useState<{ targetKey: string; items: MediaInfo[] } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const adding = useAddMedia(onTree);

  useEffect(() => {
    let cancelled = false;
    api.listMedia({ type, id }).then(
      (items) => {
        if (!cancelled) setLoaded({ targetKey: `${type}|${id}`, items });
      },
      () => {
        if (!cancelled) setLoaded({ targetKey: `${type}|${id}`, items: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [type, id, revision]);

  // While an edit is being read back, keep showing the files as they were.
  const items = loaded !== null && loaded.targetKey === targetKey ? loaded.items : null;

  return (
    <div className="media-strip" data-testid="media-strip">
      {items !== null && items.length > 0 && <MediaGrid items={items} onOpen={setViewing} />}
      {items !== null && items.length === 0 && emptyText !== undefined && (
        <p className="muted" data-testid="media-empty">
          {emptyText}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={adding.busy}
          onClick={() => void adding.add({ type, id })}
          data-testid="add-media"
        >
          {addLabel}
        </button>
        <AddMessage message={adding.message} />
      </div>
      {viewing !== null && (
        <MediaViewer
          mediaId={viewing}
          revision={revision}
          onTree={onTree}
          onClose={() => setViewing(null)}
          {...(onSelect ? { onSelect } : {})}
        />
      )}
    </div>
  );
}

interface TargetMediaDialogProps {
  /** What the files are of, e.g. "Pictures and documents of the birth of John Hale". */
  title: string;
  target: MediaTarget;
  revision: number;
  onTree: (tree: TreeState) => void;
  onSelect?: (personId: string) => void;
  onClose: () => void;
}

/** Lists the files attached to one thing, and adds and removes them. */
export function TargetMediaDialog({
  title,
  target,
  revision,
  onTree,
  onSelect,
  onClose,
}: TargetMediaDialogProps) {
  return (
    <Dialog title={title} onClose={onClose} testId="target-media-dialog" wide>
      <MediaStrip
        target={target}
        revision={revision}
        onTree={onTree}
        emptyText="Nothing is attached to this yet."
        {...(onSelect ? { onSelect } : {})}
      />
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          onClick={onClose}
          data-testid="target-media-close"
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}

interface Size {
  width: number;
  height: number;
}

/** Where the picture is drawn in the viewing area: its scale, and its top left corner. */
interface View {
  scale: number;
  x: number;
  y: number;
}

/** A picture is never drawn larger than this many times its own size. */
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

/** The scale at which the whole picture fits the area. A small picture is not blown up. */
function fitScale(stage: Size, natural: Size): number {
  return Math.min(stage.width / natural.width, stage.height / natural.height, 1);
}

/** Keeps the picture in sight: centred where it is smaller than the area, edge to edge where larger. */
function clampView(view: View, stage: Size, natural: Size): View {
  const along = (position: number, room: number, length: number) =>
    length <= room ? (room - length) / 2 : Math.min(0, Math.max(room - length, position));
  return {
    scale: view.scale,
    x: along(view.x, stage.width, natural.width * view.scale),
    y: along(view.y, stage.height, natural.height * view.scale),
  };
}

/** The picture at a given scale, with the middle of the area staying where it is. */
function centred(scale: number, stage: Size, natural: Size): View {
  return clampView(
    {
      scale,
      x: (stage.width - natural.width * scale) / 2,
      y: (stage.height - natural.height * scale) / 2,
    },
    stage,
    natural,
  );
}

interface ImageStageProps {
  src: string;
  alt: string;
  /** Called with the picture's own size in pixels once it is known. */
  onSize: (size: Size) => void;
}

/**
 * A picture that can be looked at closely: it starts fitted to the area, and
 * zooms with the buttons, the mouse wheel or the keyboard up to its own size
 * and beyond. Dragging moves it.
 */
function ImageStage({ src, alt, onSize }: ImageStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ fromX: number; fromY: number; view: View } | null>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  /** Null while the picture is fitted to the area, whatever size the area has. */
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setStage({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ready = natural !== null && stage.width > 0 && stage.height > 0;
  const fitted = ready ? centred(fitScale(stage, natural), stage, natural) : null;
  const current = ready ? clampView(view ?? (fitted as View), stage, natural) : null;
  const minScale = fitted === null ? 1 : Math.min(fitted.scale, 1) / 2;

  /** Changes the scale by a factor, keeping the point (px, py) of the area under the same pixel. */
  const zoomed = (from: View, factor: number, px: number, py: number): View => {
    if (natural === null) return from;
    const scale = Math.min(MAX_SCALE, Math.max(minScale, from.scale * factor));
    const ratio = scale / from.scale;
    return clampView(
      { scale, x: px - (px - from.x) * ratio, y: py - (py - from.y) * ratio },
      stage,
      natural,
    );
  };

  // The wheel zooms at the pointer. React listens for the wheel passively, so
  // it cannot stop the dialog from scrolling; this listener can.
  useEffect(() => {
    const element = stageRef.current;
    if (!element || natural === null || stage.width === 0 || stage.height === 0) return;
    const fit = centred(fitScale(stage, natural), stage, natural);
    const least = Math.min(fit.scale, 1) / 2;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setView((previous) => {
        const from = clampView(previous ?? fit, stage, natural);
        const scale = Math.min(MAX_SCALE, Math.max(least, from.scale * factor));
        const ratio = scale / from.scale;
        return clampView(
          { scale, x: px - (px - from.x) * ratio, y: py - (py - from.y) * ratio },
          stage,
          natural,
        );
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [natural, stage]);

  const step = (factor: number) => {
    if (current !== null) setView(zoomed(current, factor, stage.width / 2, stage.height / 2));
  };
  const actualSize = () => {
    if (natural !== null) setView(centred(1, stage, natural));
  };
  const move = (dx: number, dy: number) => {
    if (current !== null && natural !== null) {
      setView(clampView({ ...current, x: current.x + dx, y: current.y + dy }, stage, natural));
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || current === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { fromX: event.clientX, fromY: event.clientY, view: current };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || natural === null) return;
    const dx = event.clientX - from.fromX;
    const dy = event.clientY - from.fromY;
    // A click is not a drag; without this, a click would end the fitting.
    if (view === null && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    setView(clampView({ ...from.view, x: from.view.x + dx, y: from.view.y + dy }, stage, natural));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => void> = {
      '+': () => step(ZOOM_STEP),
      '=': () => step(ZOOM_STEP),
      '-': () => step(1 / ZOOM_STEP),
      '0': () => setView(null),
      '1': actualSize,
      ArrowLeft: () => move(60, 0),
      ArrowRight: () => move(-60, 0),
      ArrowUp: () => move(0, 60),
      ArrowDown: () => move(0, -60),
    };
    const action = keys[event.key];
    if (!action || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    action();
  };

  const percent = current === null ? '' : `${Math.round(current.scale * 100)}%`;

  return (
    <div className="viewer-main">
      <div className="viewer-tools" role="group" aria-label="Zoom">
        <button
          type="button"
          onClick={() => step(1 / ZOOM_STEP)}
          disabled={current === null || current.scale <= minScale}
          aria-label="Zoom out"
          data-testid="media-zoom-out"
        >
          −
        </button>
        <span className="viewer-zoom" data-testid="media-zoom">
          {percent}
        </span>
        <button
          type="button"
          onClick={() => step(ZOOM_STEP)}
          disabled={current === null || current.scale >= MAX_SCALE}
          aria-label="Zoom in"
          data-testid="media-zoom-in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setView(null)}
          disabled={current === null || view === null}
          title="Show the whole picture (0)"
          data-testid="media-fit"
        >
          Fit
        </button>
        <button
          type="button"
          onClick={actualSize}
          disabled={current === null || (view !== null && current.scale === 1)}
          title="One dot of the screen for each dot of the picture (1)"
          data-testid="media-actual"
        >
          Full size
        </button>
        <span className="muted">
          Turn the mouse wheel to zoom; drag to move. Double-click for full size.
        </span>
      </div>
      <div
        ref={stageRef}
        className={current !== null && view !== null ? 'viewer-stage movable' : 'viewer-stage'}
        tabIndex={0}
        aria-label="The picture. Plus and minus zoom, 0 fits it, 1 shows it full size, the arrow keys move it."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => (view === null || current?.scale !== 1 ? actualSize() : setView(null))}
        onKeyDown={onKeyDown}
        data-testid="media-stage"
      >
        {failed ? (
          <p className="muted viewer-message" data-testid="media-unreadable">
            This picture could not be drawn. The file may be damaged.
          </p>
        ) : (
          <img
            src={src}
            alt={alt}
            draggable={false}
            style={
              current === null || natural === null
                ? { visibility: 'hidden' }
                : {
                    width: natural.width,
                    height: natural.height,
                    transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})`,
                  }
            }
            onLoad={(event) => {
              const size = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              };
              if (size.width === 0 || size.height === 0) {
                setFailed(true);
                return;
              }
              setNatural(size);
              onSize(size);
            }}
            onError={() => setFailed(true)}
            data-testid="media-image"
          />
        )}
      </div>
    </div>
  );
}

interface UseLineProps {
  use: MediaUseInfo;
  onSelect?: (personId: string) => void;
}

/** One thing a file is attached to, in words, with the people it concerns as links. */
function UseLine({ use, onSelect }: UseLineProps) {
  const people = use.persons.map((person, index) => (
    <span key={person.id}>
      {index > 0 && ' and '}
      {onSelect ? (
        <button
          type="button"
          className="link"
          onClick={() => onSelect(person.id)}
          data-testid="media-use-person"
        >
          {fullName(person)}
        </button>
      ) : (
        fullName(person)
      )}
    </span>
  ));
  if (use.type === 'person') return <>{people}</>;
  if (use.type === 'family') return <>The family of {people}</>;
  if (use.type === 'source')
    return <>The source {use.detail === '' ? 'with no title' : use.detail}</>;
  if (use.type === 'citation') {
    return (
      <>
        A citation of {use.detail === '' ? 'a source with no title' : use.detail}
        {people.length > 0 && <> (about {people})</>}
      </>
    );
  }
  return (
    <>
      The {labelOf(use.what).toLowerCase()}
      {people.length > 0 && <> of {people}</>}
    </>
  );
}

interface MediaViewerProps {
  mediaId: string;
  /** Goes up when the tree changes, so the file is read again. */
  revision: number;
  onTree: (tree: TreeState) => void;
  onClose: () => void;
  /** Called to show a person the file is attached to. The viewer closes first. */
  onSelect?: (personId: string) => void;
}

/**
 * One file: the picture itself with zoom, its title and description, what it
 * is attached to, and the buttons to open it elsewhere or delete it.
 */
export function MediaViewer({ mediaId, revision, onTree, onClose, onSelect }: MediaViewerProps) {
  const key = `${mediaId}|${revision}`;
  const [loaded, setLoaded] = useState<
    { mediaId: string; details: MediaDetails | null } | { mediaId: string; error: string } | null
  >(null);
  /** What has been typed over the stored fields; it stays on screen once saved (see SourceDialog). */
  const [edits, setEdits] = useState<{ title: string; description: string; saved: boolean } | null>(
    null,
  );
  const [pixels, setPixels] = useState<Size | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMedia(mediaId).then(
      (details) => {
        if (!cancelled) setLoaded({ mediaId, details });
      },
      (failure: unknown) => {
        if (!cancelled) setLoaded({ mediaId, error: errorMessage(failure) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, mediaId]);

  const details =
    loaded !== null && loaded.mediaId === mediaId && 'details' in loaded ? loaded.details : null;
  const title = edits?.title ?? details?.media.title ?? '';
  const description = edits?.description ?? details?.media.description ?? '';
  const unsaved = edits !== null && !edits.saved;

  const save = useSubmit(async () => {
    onTree(await api.updateMedia(mediaId, { title, description }));
    setEdits({ title, description, saved: true });
  });

  if (loaded === null || loaded.mediaId !== mediaId) {
    return (
      <Dialog title="Picture or document" onClose={onClose} testId="media-viewer" full>
        <p className="muted">Loading…</p>
      </Dialog>
    );
  }
  if ('error' in loaded || details === null) {
    return (
      <Dialog title="Picture or document" onClose={onClose} testId="media-viewer">
        <p className={'error' in loaded ? 'error' : 'muted'} data-testid="media-gone">
          {'error' in loaded ? loaded.error : 'This file is not in the tree any more.'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose} data-testid="media-close">
            Close
          </button>
        </div>
      </Dialog>
    );
  }

  const { media, uses } = details;
  /** Runs something that is not an edit of the fields, and shows why it failed. */
  const attempt = (action: Promise<unknown>) => {
    setProblem(null);
    action.catch((failure: unknown) => setProblem(errorMessage(failure)));
  };
  const show = onSelect
    ? (personId: string) => {
        onClose();
        onSelect(personId);
      }
    : undefined;

  return (
    <Dialog title={mediaTitle(media)} onClose={onClose} testId="media-viewer" full>
      <div className="viewer">
        {!media.present ? (
          <div className="viewer-main">
            <p className="viewer-message" data-testid="media-absent">
              The file <span className="path">{media.fileName}</span> is no longer in the media
              folder of this tree. It may have been moved or deleted outside the app. Adding the
              same file again puts it back; its title and what it is attached to are kept.
            </p>
          </div>
        ) : media.kind === 'image' ? (
          <ImageStage
            key={media.id}
            src={mediaUrl(media.id, 'file')}
            alt={mediaTitle(media)}
            onSize={setPixels}
          />
        ) : (
          <div className="viewer-main">
            <div className="viewer-message" data-testid="media-document">
              <span className="media-thumb large">
                <Preview media={media} />
              </span>
              <p>
                The app does not show files of this kind itself.{' '}
                {media.canOpen
                  ? 'Open it in the program Windows uses for it.'
                  : 'Show it in its folder to open it from there.'}
              </p>
            </div>
          </div>
        )}

        <aside className="viewer-side">
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!save.busy && unsaved) void save.submit();
            }}
          >
            <TextField
              label="Title"
              value={title}
              onChange={(next) => setEdits({ title: next, description, saved: false })}
              maxLength={MEDIA_LIMITS.title}
              placeholder={media.fileName}
              testId="media-title"
            />
            <TextAreaField
              label="What it shows"
              value={description}
              onChange={(next) => setEdits({ title, description: next, saved: false })}
              maxLength={MEDIA_LIMITS.description}
              rows={4}
              testId="media-description"
            />
            {save.error !== null && (
              <p className="error" role="alert" data-testid="dialog-error">
                {save.error}
              </p>
            )}
            <div className="actions">
              <button
                type="submit"
                className="primary"
                disabled={save.busy || !unsaved}
                data-testid="media-save"
              >
                Save changes
              </button>
            </div>
          </form>

          <dl className="facts" data-testid="media-facts">
            <dt>File</dt>
            <dd className="path">{media.fileName}</dd>
            <dt>Kind</dt>
            <dd>
              {kindLabel(media)}, {formatSize(media.size)}
            </dd>
            {pixels !== null && (
              <>
                <dt>Size</dt>
                <dd data-testid="media-pixels">
                  {pixels.width.toLocaleString()} × {pixels.height.toLocaleString()} dots
                </dd>
              </>
            )}
          </dl>

          <h3>Attached to</h3>
          {uses.length === 0 ? (
            <p className="muted" data-testid="media-unattached">
              Nothing. It is listed under “Media” on the tree screen.
            </p>
          ) : (
            <ul className="media-uses" data-testid="media-uses">
              {uses.map((use) => (
                <li key={`${use.type}|${use.id}`} data-testid="media-use">
                  <span>
                    <UseLine use={use} {...(show ? { onSelect: show } : {})} />
                  </span>
                  <button
                    type="button"
                    className="small"
                    onClick={() =>
                      attempt(
                        api.unlinkMedia(media.id, { type: use.type, id: use.id }).then(onTree),
                      )
                    }
                    data-testid="media-detach"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {problem !== null && (
            <p className="error" role="alert" data-testid="media-problem">
              {problem}
            </p>
          )}
          <div className="actions viewer-buttons">
            {media.present && media.canOpen && (
              <button
                type="button"
                onClick={() => attempt(api.openMedia(media.id))}
                data-testid="media-open"
              >
                Open in another program
              </button>
            )}
            {media.present && (
              <button
                type="button"
                onClick={() => attempt(api.showMediaInFolder(media.id))}
                data-testid="media-show"
              >
                Show in folder
              </button>
            )}
            <button
              type="button"
              className="danger"
              onClick={() => setConfirming(true)}
              data-testid="media-delete"
            >
              Delete from tree
            </button>
            <button type="button" className="primary" onClick={onClose} data-testid="media-close">
              Close
            </button>
          </div>
        </aside>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Delete ${mediaTitle(media)} from this tree?`}
          confirmLabel="Delete file"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            onTree(await api.deleteMedia(media.id));
            onClose();
          }}
        >
          <p>
            {uses.length === 0
              ? 'It is attached to nothing.'
              : `It is taken away from the ${countOf(uses.length, 'thing', 'things')} it is attached to.`}
          </p>
          <p>
            You can bring it back with Undo. For that reason its copy stays in the media folder of
            this tree; the app does not remove it from the disk.
          </p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}

interface PersonMediaSectionProps {
  /** The files to show: everything attached on the person's page. */
  items: readonly MediaInfo[];
  /** What a file is attached to on the page, in a few words. */
  noteOf: (media: MediaInfo) => string;
  /** New files are attached to this person as a whole. */
  personId: string;
  name: string;
  revision: number;
  onTree: (tree: TreeState) => void;
  onSelect: (personId: string) => void;
}

/** The pictures and documents of a person's page. */
export function PersonMediaSection({
  items,
  noteOf,
  personId,
  name,
  revision,
  onTree,
  onSelect,
}: PersonMediaSectionProps) {
  const [viewing, setViewing] = useState<string | null>(null);
  const adding = useAddMedia(onTree);
  return (
    <section data-testid="media-section">
      <h3>Pictures and documents</h3>
      {items.length === 0 ? (
        <p className="muted" data-testid="media-empty">
          No pictures or documents attached.
        </p>
      ) : (
        <MediaGrid items={items} onOpen={setViewing} noteOf={noteOf} />
      )}
      <div className="actions">
        <button
          type="button"
          disabled={adding.busy}
          onClick={() => void adding.add({ type: 'person', id: personId })}
          data-testid="add-person-media"
        >
          Add pictures or documents
        </button>
        <span className="muted">of {name} in general, not one event or source</span>
        <AddMessage message={adding.message} />
      </div>
      {viewing !== null && (
        <MediaViewer
          mediaId={viewing}
          revision={revision}
          onTree={onTree}
          onSelect={onSelect}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}

/** How many files the list of all files shows at first, and how many more each time. */
const LIBRARY_PAGE = 60;

interface MediaLibraryDialogProps {
  tree: TreeState;
  onTree: (tree: TreeState) => void;
  /** Called to show a person a file is attached to. The dialog closes first. */
  onSelect: (personId: string) => void;
  onClose: () => void;
}

/** Every picture and document of the tree, the one added last first. */
export function MediaLibraryDialog({ tree, onTree, onSelect, onClose }: MediaLibraryDialogProps) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [unattached, setUnattached] = useState(false);
  const [limit, setLimit] = useState(LIBRARY_PAGE);
  const [loaded, setLoaded] = useState<{ filter: string; page: MediaListPage } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const adding = useAddMedia(onTree);
  const filter = `${query}|${unattached}`;

  // Search once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text.trim());
      setLimit(LIBRARY_PAGE);
    }, 150);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    api.listAllMedia({ query, unattached, offset: 0, limit }).then(
      (page) => {
        if (!cancelled) setLoaded({ filter: `${query}|${unattached}`, page });
      },
      () => {
        if (!cancelled) {
          setLoaded({ filter: `${query}|${unattached}`, page: { total: 0, media: [] } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, unattached, limit, tree.revision]);

  // Only the answer to what is asked now is shown; an older one could be clicked by mistake.
  const page = loaded !== null && loaded.filter === filter ? loaded.page : null;

  return (
    <Dialog title="Pictures and documents" onClose={onClose} testId="media-library" wide>
      {tree.media === 0 ? (
        <p className="muted" data-testid="library-empty">
          This tree has no pictures or documents yet.
        </p>
      ) : (
        <>
          <div className="library-filter">
            <TextField
              label="Find by title, description or file name"
              value={text}
              onChange={setText}
              testId="library-search"
              autoFocus
            />
            <label className="check">
              <input
                type="checkbox"
                checked={unattached}
                onChange={(event) => {
                  setUnattached(event.target.checked);
                  setLimit(LIBRARY_PAGE);
                }}
                data-testid="library-unattached"
              />
              Only those attached to nothing
            </label>
          </div>
          <div className="scroll-box tall" data-testid="library-list">
            {page === null && <p className="muted">Looking…</p>}
            {page !== null && page.media.length === 0 && (
              <p className="muted" data-testid="library-none">
                No file found.
              </p>
            )}
            {page !== null && page.media.length > 0 && (
              <MediaGrid items={page.media} onOpen={setViewing} />
            )}
          </div>
          {page !== null && (
            <div className="actions">
              <span className="muted" data-testid="library-count">
                {page.total > page.media.length
                  ? `${page.media.length.toLocaleString()} of ${page.total.toLocaleString()} shown.`
                  : countOf(page.total, 'file', 'files')}
              </span>
              {page.total > page.media.length && (
                <button
                  type="button"
                  onClick={() => setLimit(Math.min(limit + LIBRARY_PAGE, 500))}
                  disabled={limit >= 500}
                  data-testid="library-more"
                >
                  Show more
                </button>
              )}
            </div>
          )}
        </>
      )}
      <AddMessage message={adding.message} />
      <div className="dialog-actions">
        <button
          type="button"
          disabled={adding.busy}
          onClick={() => void adding.add(null)}
          title="Add files without attaching them to anyone yet"
          data-testid="library-add"
        >
          Add pictures or documents
        </button>
        <button type="button" className="primary" onClick={onClose} data-testid="library-close">
          Close
        </button>
      </div>
      {viewing !== null && (
        <MediaViewer
          mediaId={viewing}
          revision={tree.revision}
          onTree={onTree}
          onSelect={(personId) => {
            onClose();
            onSelect(personId);
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </Dialog>
  );
}

/** A button that opens the files of one thing; its label says how many there are. */
export function FilesButton({
  count,
  onClick,
  testId,
}: {
  count: number;
  onClick: () => void;
  testId: string;
}): ReactNode {
  return (
    <button
      type="button"
      title={count === 0 ? 'Attach a picture or a document' : 'See the pictures and documents'}
      onClick={onClick}
      data-testid={testId}
    >
      {count === 0 ? 'Files' : `Files (${count.toLocaleString()})`}
    </button>
  );
}
