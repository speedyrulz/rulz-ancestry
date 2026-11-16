# Release notes

## 0.9.1

A fix to how releases are put together; the app itself is unchanged from 0.9.0.

- **Every file of a release now lands on one release.** 0.9.0's `.blockmap` was uploaded to a
  second, hidden draft and had to be moved by hand. The release workflow now creates the draft
  before uploading, and refuses to publish unless exactly one release holds the installer, its
  `.blockmap` and `latest.yml`.
- **Unit tests get more time on GitHub's test machines,** which sometimes stall, so a slow
  machine no longer fails a release.

### Updating from 0.9.0

If 0.9.0 is installed, it offers this version when it starts (or press **Check now** under
App updates). Press **Update now**: the app downloads the installer, checks it, backs up the
open tree, installs and reopens by itself. This is the first update between two released
versions, so if anything goes wrong, download `RulZ-Kinspora-Setup-0.9.1.exe` from the release
page and run it; your trees, settings and packs stay where they are.

## 0.9.0

The first public release of RulZ Kinspora, a Windows desktop app for building a family tree and
researching it with free data sources. Everything is stored on your own PC. There is no account,
no telemetry and no crash upload.

### Install

1. Download `RulZ-Kinspora-Setup-0.9.0.exe` from this release's page on GitHub, and from nowhere
   else.
2. Run it. The installer is **not signed**, so Windows shows a blue window, "Windows protected
   your PC". Choose **More info**, then **Run anyway**. It appears because the file is unsigned
   and new, not because it is harmful.
3. Follow the installer. It installs for your own account and needs no administrator rights.

Needs Windows 10 or 11, 64-bit.

### Update and uninstall

- When the app starts it looks on GitHub for a newer release. If there is one, a notice offers
  **Update now** and **Not now**. "Update now" downloads the installer, checks it against the
  release's checksum, closes the app, installs it and opens it again. It waits if an import, a
  pack install or an AI session is running. The installer comes from github.com (then a
  githubusercontent.com download host). "Not now" hides that version at later launches until a
  newer one is out or you check by hand. A switch in the "App updates" window stops the check at
  launch. The updates button in the top bar opens that window, where "Check now" checks by hand.
- To uninstall, use Windows Settings, then Apps. Your trees, settings and packs stay on the PC.

### What the app does

- Create a tree, add people with names, events, parents, partners and children, search by name,
  and undo or redo every change.
- Bring in a tree from Ancestry or another program as a GEDCOM or GEDZip file, and write one out.
  An import loses nothing: lines the app has no screen for come back in an export.
- Record sources and citations, and attach pictures and documents.
- Offer places while you type, link them to a list of the world's places (downloaded when you ask),
  and show a person's life as a timeline and a map.
- Draw four kinds of chart, say how two people are related, and find and merge duplicates.
- Make a family group sheet and an Ahnentafel, and save or print them and the charts. A person who
  may be living is left out or shown only as "Living".
- Search WikiTree, Open Archives, Wikidata, the Library of Congress, the Internet Archive, the US
  National Archives, DigitalNZ (Papers Past) and Trove for a person, and compare and attach a result.
  Search the 1950 US census and Dutch and Belgian archive records offline, from data packs.
- Open a search at Find a Grave, FamilySearch and Geni in your browser.
- An optional AI assistant, off until you turn it on, proposes record matches for you to confirm.
- Backs up a tree when it closes. Offline help is in the app (the question-mark button).
- Meets WCAG 2.2 level AA as far as automatic checks and a keyboard-only walk can show.

What the app sends, to whom and when is in [PRIVACY.md](PRIVACY.md).

### Known limits

- **The installer is unsigned,** so Windows may warn about every new version until enough people have downloaded it.
- **Little tested on real trees.** One real Ancestry export, of 162 people, has been tried, and no
  export from another program. The duplicate scores were set by hand. Check a large tree after you
  import it, and keep your original file.
- **Narrator and other screen readers** have not been tried by the author. A message about a form
  that failed is under the form, not next to its field. The pictures on the map are drawn, with a
  list under the map as the keyboard way to pick a place. A saved PDF is not tagged for screen
  readers. Text sizes follow the page zoom (Ctrl and +), not the Windows text size setting.
- **The AI assistant** has not been run with a real Anthropic key in the project's own tests.
- **Backups do not hold pictures and documents.** Copy the tree's folder to keep them.
- **Not in this version:** the narrative report, DNA, OCR, Word files, translations, ARM64, and a
  Microsoft Store build. A GEDZip file from another program has not been tried.
- Deleting a picture from a tree leaves its file on disk, so that Undo works.
