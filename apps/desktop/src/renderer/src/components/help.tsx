import { CircleHelp } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, IconButton } from './ui';
import './help.css';

/**
 * The help of the app. It is written here, in the app, so that it works with no internet.
 * Every claim in it is about something the app does; when a screen changes, change its topic.
 */

interface Topic {
  id: string;
  title: string;
  body: ReactNode;
}

const TOPICS: readonly Topic[] = [
  {
    id: 'start',
    title: 'Starting out',
    body: (
      <>
        <p>
          On the first screen, type a name for your family tree and press &ldquo;Create tree&rdquo;.
          The tree is a folder on this PC. By default it is made in Documents, in a folder called
          RulZ Kinspora; &ldquo;Keep it somewhere else&hellip;&rdquo; lets you choose.
        </p>
        <p>
          Press &ldquo;Add person&rdquo; to enter the first person: names, sex, birth and death. On
          a person&rsquo;s page you can add their parents, partners and children, and their events,
          sources, notes, pictures and documents.
        </p>
        <p>
          Every change can be undone. &ldquo;Undo&rdquo; and &ldquo;Redo&rdquo; are in the bar at
          the top, and Ctrl+Z and Ctrl+Y do the same. Each change is one step, so you can go back as
          far as you like.
        </p>
        <p>
          Ctrl+F searches the tree by name. &ldquo;Chart&rdquo;, &ldquo;Relationship&rdquo;,
          &ldquo;Family group sheet&rdquo; and &ldquo;Ahnentafel&rdquo; on a person&rsquo;s page
          draw their ancestors and descendants, say how someone is related to them, and make pages
          you can save or print.
        </p>
        <p>
          &ldquo;Close tree&rdquo; takes you back to the first screen, where &ldquo;Open&rdquo; or
          &ldquo;Open a tree folder&hellip;&rdquo; brings a tree back.
        </p>
      </>
    ),
  },
  {
    id: 'import',
    title: 'Importing from Ancestry',
    body: (
      <>
        <p>
          The app does not sign in to Ancestry or read your account. You bring your tree in as a
          file.
        </p>
        <ol>
          <li>
            On Ancestry&rsquo;s website, open your tree and export it as a GEDCOM file (a file
            ending in .ged). Look for &ldquo;Export tree&rdquo; in the tree&rsquo;s settings;
            Ancestry&rsquo;s own help says where it is now.
          </li>
          <li>
            Here, on the first screen, press &ldquo;Choose a GEDCOM or GEDZip file&hellip;&rdquo;
            and pick the file.
          </li>
        </ol>
        <p>
          The import always makes a new tree and never changes the file. After it, a note says what
          was read, with a button for the details.
        </p>
        <p>What is kept:</p>
        <ul>
          <li>
            People, names, events, families, sources, citations and notes, as far as the file holds
            them.
          </li>
          <li>
            Every other line of the file, even ones the app has no screen for. They go back into an
            export exactly as they were.
          </li>
          <li>
            Pictures and documents: a GEDCOM file names them and does not hold them, so the tree
            shows &ldquo;Not in the tree&rdquo; until it has the file. &ldquo;Media&rdquo; then
            &ldquo;Find the files in a folder&rdquo; looks for them in a folder you choose. A GEDZip
            file (ending in .gdz) holds the files too.
          </li>
        </ul>
        <p>
          A GEDCOM file holds the tree, not what Ancestry&rsquo;s site adds to it, such as hints.
          One export from Ancestry, of 162 people, has been tried in this version; check a large
          tree after you import it.
        </p>
      </>
    ),
  },
  {
    id: 'network',
    title: 'What leaves your PC, and when',
    body: (
      <>
        <p>
          Your tree stays on this PC. The app asks the internet only when you press a button for it:
        </p>
        <ul>
          <li>
            <strong>A search for records</strong> (&ldquo;Search records&rdquo;, &ldquo;Search for
            ancestors&rdquo;, newspapers and books). It sends what the form or the list shows, such
            as a name and two years, to the service you picked: WikiTree, Open Archives, Wikidata,
            the Library of Congress, the Internet Archive, the US National Archives, DigitalNZ or
            Trove. Before the first search, a notice says which service is sent what, and you agree
            to it.
          </li>
          <li>
            <strong>A download</strong>: the place list, or a data pack. These send nothing about
            you or your tree.
          </li>
          <li>
            <strong>Looking for a new version</strong> (see &ldquo;Updates&rdquo;).
          </li>
          <li>
            <strong>The AI assistant</strong>, only if you turn it on (see &ldquo;The AI
            assistant&rdquo;).
          </li>
        </ul>
        <p>
          Nothing is sent while you type or in the background, apart from the check for a new
          version at launch. A person who may be living is never sent. Keys you type in (for the
          National Archives, Trove, DigitalNZ or Anthropic) are kept on this PC, encrypted by
          Windows for your account, and go only to their own service.
        </p>
        <p>
          Find a Grave, FamilySearch and Geni are never asked by the app. A button opens a search at
          the site in your own browser; the name and years are then part of the address that your
          browser and the site see.
        </p>
      </>
    ),
  },
  {
    id: 'living',
    title: 'Living people',
    body: (
      <>
        <p>
          The app takes a person as living when nothing shows they have died: no death, burial,
          cremation or probate, and no event or birth more than 110 years back. On a person&rsquo;s
          page, &ldquo;Living or deceased&rdquo; lets you say it yourself, and a line under it says
          why the app thinks what it does.
        </p>
        <ul>
          <li>No search is made for a person who may be living, and nothing about them is sent.</li>
          <li>
            An export and the reports leave them out unless you choose to include everyone. In a
            chart or an Ahnentafel a living person between two others is shown as
            &ldquo;Living&rdquo;, with no name, dates or places.
          </li>
          <li>The AI assistant never reads them.</li>
        </ul>
        <p>
          If you know someone is deceased and the app does not, set them to deceased. If you know
          someone is living and the app thinks otherwise, set them to living.
        </p>
      </>
    ),
  },
  {
    id: 'packs',
    title: 'Data packs and disk space',
    body: (
      <>
        <p>Two things can be downloaded to this PC, only when you ask:</p>
        <ul>
          <li>
            <strong>The place list</strong>: &ldquo;Places&rdquo; then &ldquo;Download the place
            list&rdquo;. It is about 100 MB to download and about 76 MB on disk, from GeoNames. It
            offers places while you type and links each place of a tree to the map. It can be
            removed again.
          </li>
          <li>
            <strong>Packs</strong>: &ldquo;Packs&rdquo; holds records you can search with no
            internet, such as the 1950 US census, state by state, and the record files of Dutch and
            Belgian archives. Each pack shows its size, the free space on the disk, and about how
            large it will be once built. A pack can take a long time to build. Remove a pack from
            the same window when you no longer need it; citations made from it stay in your tree.
          </li>
        </ul>
        <p>
          Packs are kept in the RulZKinspora folder inside your local app data (Windows&rsquo;{' '}
          <code>%LOCALAPPDATA%</code>), not in your tree, and are not in a backup.
        </p>
        <p>
          A tree&rsquo;s pictures and documents are copied into its &ldquo;media&rdquo; folder. If
          you delete a file from a tree its copy stays on the disk, so that Undo can bring it back.
        </p>
      </>
    ),
  },
  {
    id: 'ai',
    title: 'The AI assistant',
    body: (
      <>
        <p>
          The AI assistant is optional and off until you turn it on. It is opened with &ldquo;AI
          assistant&rdquo; on a person&rsquo;s page, and its window says first what turning it on
          means.
        </p>
        <ul>
          <li>
            <strong>What it can do:</strong> look for records at the services you tick, for one
            person and up to three generations of their ancestors, and propose that a record fits.
            Each proposal stands in the Inbox with the app&rsquo;s own label and the words of the
            record that the AI quotes for each reason.
          </li>
          <li>
            <strong>What it cannot do:</strong> change your tree, read a person who may be living,
            or ask a service that does not allow it. Nothing changes in your tree until you keep or
            attach a record yourself.
          </li>
          <li>
            <strong>A session</strong> is the time in which it may look. You start it and can stop
            it at any time. It asks each service at most 10 questions, ends after 15 minutes without
            a call and after two hours at the most, and ends when the tree or the app closes. A line
            above the tree says that one is under way.
          </li>
          <li>
            <strong>Routes:</strong> connect Claude Desktop or Claude Code on this PC, or use your
            own Anthropic API key. The key is kept encrypted on this PC and goes only to Anthropic.
            With a key you set a cap in dollars; the app stops before a request could pass it. The
            figures it shows are an estimate, so check the bill in Anthropic&rsquo;s Console.
          </li>
          <li>
            <strong>What goes where:</strong> names, dates and places of the people being
            researched, and the records found, go to the AI service. An activity log on this PC
            lists every call an AI made, and you can clear it.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'backups',
    title: 'Backups',
    body: (
      <>
        <p>
          The app backs up a tree when you close it or quit, if anything has changed. It keeps the
          ten newest backups, and of older ones the last backup of each month for six months. They
          are in the &ldquo;backups&rdquo; folder inside the tree&rsquo;s folder.
        </p>
        <ul>
          <li>
            <strong>On request:</strong> &ldquo;Backups&rdquo; then &ldquo;Back up now&rdquo; makes
            one at once.
          </li>
          <li>
            <strong>Restore:</strong> choose a backup in the same window and confirm. Everything
            changed since then is taken out, and the tree as it is now is backed up first, so you
            can come back to it.
          </li>
          <li>
            <strong>Pictures and documents are not in a backup,</strong> only the people, events and
            sources. To keep everything safe, copy the whole tree folder to another disk now and
            then.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'updates',
    title: 'Updates',
    body: (
      <>
        <p>
          When the app starts, it looks on GitHub for a newer release. If there is one, a notice
          offers &ldquo;Update now&rdquo; and &ldquo;Not now&rdquo;.
        </p>
        <ul>
          <li>
            <strong>Update now</strong> downloads the installer and checks it against the
            release&rsquo;s checksum. Then the app closes, installs it and opens again. If an
            import, a pack install or an AI session is running, it waits until that is done.
          </li>
          <li>
            <strong>Not now</strong> hides that version at later launches, until a newer one is out
            or you check by hand.
          </li>
          <li>
            <strong>By hand:</strong> the updates button in the bar at the top opens the &ldquo;App
            updates&rdquo; window, where &ldquo;Check now&rdquo; checks.
          </li>
          <li>
            <strong>To stop the check at launch,</strong> use the switch in the updates window.
          </li>
        </ul>
        <p>
          The app asks GitHub for the release file, and &ldquo;Update now&rdquo; also downloads the
          installer from GitHub (github.com, then a githubusercontent.com download host). Nothing
          about you or your trees is sent. Your trees, settings and packs stay as they are when the
          app updates.
        </p>
      </>
    ),
  },
  {
    id: 'uninstall',
    title: 'Uninstalling',
    body: (
      <>
        <p>
          Open Windows Settings, then Apps, then Installed apps, choose RulZ Kinspora and press
          Uninstall.
        </p>
        <p>
          Uninstalling removes the program and keeps what you made. Your trees, settings and packs
          stay where they were:
        </p>
        <ul>
          <li>
            Trees: where you made them, by default <code>Documents\RulZ Kinspora</code>.
          </li>
          <li>
            Settings, recent trees, saved keys and the place list:{' '}
            <code>%APPDATA%\RulZ Kinspora</code>.
          </li>
          <li>
            Packs: <code>%LOCALAPPDATA%\RulZKinspora\packs</code>.
          </li>
        </ul>
        <p>
          Install the app again and it finds them. To remove them too, delete those folders
          yourself. A tree you delete is gone for good, so copy it first if you may want it.
        </p>
      </>
    ),
  },
  {
    id: 'smartscreen',
    title: 'The SmartScreen warning',
    body: (
      <>
        <p>
          When you run the installer, Windows may show a blue window, &ldquo;Windows protected your
          PC&rdquo;. To go on:
        </p>
        <ol>
          <li>Choose &ldquo;More info&rdquo;.</li>
          <li>Choose &ldquo;Run anyway&rdquo;.</li>
        </ol>
        <p>
          It appears because the installer is not signed. A signature costs money every year, and
          Windows warns about any new program that has few downloads, signed or not. It does not
          mean the file is harmful.
        </p>
        <p>
          Download the installer only from the project&rsquo;s GitHub Releases page, and from
          nowhere else. If the file came from another place, do not run it.
        </p>
      </>
    ),
  },
  {
    id: 'privacy',
    title: 'Privacy',
    body: (
      <>
        <ul>
          <li>
            Everything is stored on this PC. There is no account, no telemetry and no crash upload.
          </li>
          <li>
            The app asks the internet only when you press a button for it, except for one check for
            a new version at launch, which you can switch off.
          </li>
          <li>A person who may be living is never sent anywhere.</li>
          <li>
            Keys are kept encrypted by Windows for your account and go only to their own service.
          </li>
          <li>
            The AI assistant is off until you turn it on. Connecting Claude Desktop or Claude Code
            uses a connection that stays inside this PC.
          </li>
        </ul>
        <p>
          The full statement lists every internet address the app can ask, when, and what is sent.
          It is the file <code>docs/PRIVACY.md</code> in the project, on its GitHub page.
        </p>
      </>
    ),
  },
];

/** The Help button of the top bar and of the first screen, and the help it opens. */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label="Help" testId="help-open" onClick={() => setOpen(true)}>
        <CircleHelp size={16} aria-hidden="true" />
      </IconButton>
      {open && <HelpDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** A list of topics and the text of the chosen one. */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const [topicId, setTopicId] = useState(TOPICS[0]!.id);
  /** Goes up with every press on a topic, also on the one that is shown, so that the focus moves. */
  const [presses, setPresses] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const topic = TOPICS.find((candidate) => candidate.id === topicId) ?? TOPICS[0]!;

  // A new topic takes the focus to its heading, so that it is read, and the next Tab reaches its text.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'nearest' });
  }, [presses]);

  return (
    <Dialog
      title="Help"
      onClose={onClose}
      testId="help-dialog"
      wide
      footer={
        <button type="button" onClick={onClose} data-testid="help-close">
          Close
        </button>
      }
    >
      <div className="help">
        <nav aria-label="Help topics">
          <ul className="help-topics">
            {TOPICS.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="help-topic"
                  aria-current={entry.id === topicId ? 'true' : undefined}
                  data-testid={`help-topic-${entry.id}`}
                  onClick={() => {
                    setTopicId(entry.id);
                    setPresses((count) => count + 1);
                  }}
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <article className="help-text" data-testid="help-text">
          <h3 ref={heading} tabIndex={-1}>
            {topic.title}
          </h3>
          {topic.body}
        </article>
      </div>
    </Dialog>
  );
}
