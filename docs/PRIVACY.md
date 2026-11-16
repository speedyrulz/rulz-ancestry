# Privacy

RulZ Kinspora keeps everything on your own PC. This page says what it stores, where, and every
internet address it can ask, when, and what it sends. A test (`apps/desktop/src/main/privacy.test.ts`)
fails when a host the app can ask is not named here, so this list stays whole.

## In short

- **No account, no telemetry, no crash upload.** The app never tells its authors, or anyone else,
  that you use it, what you do in it, or that it failed.
- **Your trees stay on the PC.** A tree is a folder you can move, copy or delete. Nothing uploads it.
- **The app asks the internet only when you press something:** a search, a download, a check for a
  new version. Nothing is sent while you type, and nothing in the background, except one
  check for a new version when the app starts, which you can switch off.
- **A person who may be living is never sent** to any service, not even their name.
- **Your keys stay on the PC,** encrypted by Windows for your account.

## What the app stores, and where

| What                                                                   | Where                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A tree: people, events, sources, notes, and its backups                | A folder of its own. New trees go in `Documents\RulZ Kinspora`, or where you chose.                     |
| The pictures and documents of a tree                                   | The `media` folder inside the tree folder. The app copies them there; your original stays where it was. |
| The settings of the app, the list of recent trees, the AI activity log | `%APPDATA%\RulZ Kinspora`                                                                               |
| The place list (about 76 MB), if you downloaded it                     | The `gazetteer` folder inside `%APPDATA%\RulZ Kinspora`                                                 |
| Data packs (census, archive records), if you installed any             | `%LOCALAPPDATA%\RulZKinspora\packs`                                                                     |
| Keys you typed in (National Archives, Trove, DigitalNZ, Anthropic)     | Inside the settings, encrypted with Windows data protection (Electron `safeStorage`)                    |

Keys are never written to a tree, a file you can open, a log or a test. They are never shown again
after you type them, and you can remove each one. A key encrypted for one Windows account cannot be
read on another account or PC.

Uninstalling the app leaves all of this where it is. See the help in the app, or the release notes.

## Every internet address the app can ask

The app asks each of these only for the reason in the table, and only after you press the button
for it. Searches go out through one client that sends no cookies, asks within each source's own
limits, and calls itself `RulZKinspora` with its version and the address of its code.

### Searching for records

"Search records", "Search for ancestors" and the search for newspapers, books and archive
descriptions send what the form or the list shows when you press Search or Start, and nothing else
of your tree. The app tells you before the first search which service is sent what, and asks you to
agree.

| Host                        | Service                          | What is sent                                              |
| --------------------------- | -------------------------------- | --------------------------------------------------------- |
| `api.wikitree.com`          | WikiTree                         | Given name, surname, years of birth and death             |
| `www.wikitree.com`          | WikiTree (pages)                 | Nothing: a profile opens in your browser                  |
| `api.openarchieven.nl`      | Open Archives                    | The name, and a span of years                             |
| `www.openarchieven.nl`      | Open Archives (pages, catalogue) | The list of archives, when you install an archive pack    |
| `query.wikidata.org`        | Wikidata                         | The name                                                  |
| `www.wikidata.org`          | Wikidata (pages)                 | Nothing: an entry opens in your browser                   |
| `www.loc.gov`               | Library of Congress              | Words, and the years of printing                          |
| `archive.org`               | Internet Archive                 | Words                                                     |
| `catalog.archives.gov`      | US National Archives Catalog     | Words, and your National Archives key in a request header |
| `api.digitalnz.org`         | DigitalNZ, for Papers Past       | Words and years, and your key if you saved one            |
| `paperspast.natlib.govt.nz` | Papers Past (pages)              | Nothing: a page opens in your browser                     |
| `api.trove.nla.gov.au`      | Trove                            | Words and years, and your Trove key in a request header   |
| `nla.gov.au`                | Trove (pages)                    | Nothing: a page opens in your browser                     |

A key goes to the host of its own service and nowhere else. It is sent in a request header, never in
an address.

### Sites the app never asks

The app builds a search address for these and hands it to your own browser, which then asks the
site. The fields in the address (name and years) are visible to the site and kept in your browser's
history. The app does this for no person who may be living.

| Host                      | Site                    |
| ------------------------- | ----------------------- |
| `www.findagrave.com`      | Find a Grave            |
| `www.familysearch.org`    | FamilySearch            |
| `www.geni.com`            | Geni                    |
| `1950census.archives.gov` | 1950 Census name search |

### Links the app opens in your browser

The app asks none of these. It shows a link (where to get a key, a source's terms or its
documentation) and your own browser asks the site when you click it.

| Host                           | Linked from                                          |
| ------------------------------ | ---------------------------------------------------- |
| `digitalnz.org`                | Where to get a key for Papers Past                   |
| `trove.nla.gov.au`             | Where to get a key for Trove                         |
| `foundation.wikimedia.org`     | The terms of Wikidata                                |
| `www.mediawiki.org`            | The documentation of Wikidata                        |
| `www.ancestry.com`             | The terms of Find a Grave                            |
| `www.archives.gov`             | The terms of the National Archives catalogue         |
| `usnationalarchives.github.io` | The documentation of the National Archives catalogue |
| `registry.opendata.aws`        | The documentation of the 1950 census packs           |

### Downloads

| Host                                          | What for                                                                           | What is sent                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| `download.geonames.org`                       | The place list, when you press "Download the place list" (about 100 MB)            | Nothing about you or your tree |
| `nara-1950-census.s3.us-east-2.amazonaws.com` | The 1950 census packs, when you look up and install a state                        | Nothing about you or your tree |
| `oa-export.s3.nl-ams.scw.cloud`               | The record files of Open Archives, when you install an archive pack                | Nothing about you or your tree |
| `nara-1940-census`                            | A public bucket of the 1940 census, named by the app but not asked by this version | Nothing                        |

A download asks fixed addresses on these hosts. The app checks the size of what arrives, checks
archives, builds the new data beside the old and swaps it in only when it is whole.

### Updates

| Host                    | What for                                                                                                                                                                                                              | What is sent                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `github.com`            | The newest release's file `latest.yml`, once at launch (unless you switched it off) and when you press "Check now" in the "App updates" window. "Update now" also asks `github.com` for the installer of that release | The request for the file. Nothing about you or your tree. |
| `githubusercontent.com` | GitHub redirects the request for `latest.yml`, and for the installer, to its own download hosts under this name; the app follows a redirect only to `github.com` or a host under this name                            | The request for the file.                                 |

The checksum the installer is checked against comes from `latest.yml`, and the installer from the
release page of that version, both through the hosts above. The installer is checked against that
checksum before it is run, and again just before it is started.

The request carries the same things any program's web request carries: your IP address, to GitHub,
which can see it. The app adds no account, no identifier of its own and nothing about your tree.

### The AI assistant

The assistant is optional and off until you turn it on. It has two routes, and you pick one each
time you start a session.

| Route                                    | Host                | What is sent                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your own Anthropic API key               | `api.anthropic.com` | What the assistant needs to judge records for the person you chose: names, dates and places of that person and their ancestors up to three generations, who are not living, and the records the sources returned. The key goes only here. |
| Claude Desktop or Claude Code on this PC | None from this app  | See below.                                                                                                                                                                                                                                |

On the second route the AI app that you connect talks to this app over a **named pipe**, which is a
connection that stays inside this PC. The pipe exists only while a session is under way, and is
protected by a key made for that session. This app sends nothing to the internet for it; the AI
app sends what it reads to its own service (for Claude, to Anthropic), under that service's terms.
Another program that runs under your Windows account could read the key of the pipe, so connect
only an AI app you trust.

Only sources whose terms allow it are passed on to an AI service. An activity log on this PC lists
every call an AI made, and you can clear it. Nothing changes in your tree until you keep or attach
a record yourself.

## Living people

The app takes someone as living when nothing shows they have died: no death, burial, cremation or
probate recorded, and no event or birth more than 110 years back. You can set a person as living
or deceased yourself, and the person's page says why the app thinks what it does.

- No search is made for a person who may be living, and no page for one is opened in your browser.
- An export and a report leave them out, or show "Living" and nothing else, unless you choose to
  include everyone.
- The AI assistant never reads them.

## What the app does not do

- It does not read your Ancestry account, or anyone's. You bring a tree in as a file.
- It does not scrape sites that bar automated access.
- It does not send your tree, or any file of it, anywhere.
- It does not sign you in anywhere, except that you type a key for a service that gives one.

## A change to this page

Version 0.9.0 is the first release. When a release changes what the app sends or where, this page
and the release notes say so, and the test above will not pass until the new host is named here.
