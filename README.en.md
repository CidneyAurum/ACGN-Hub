# ACGN Hub

A Windows desktop library for anime, manga, light novels and visual novels. Discover works, compare sources, manage downloads and read your offline collection in one place.

**[Download for Windows](https://github.com/CidneyAurum/ACGN-Hub/releases/latest)** · [中文](README.md) · [0.4.0 user guide, Chinese](docs/releases/v0.4.0-usage.md)

## Features

- Seasonal anime discovery follows the local calendar, with past seasons and a broadcast schedule. Manga, novels and visual novels have their own cover shelves.
- Search for a title or author and see related works. Metadata comes from Bangumi and VNDB; source searches can also run independently.
- Compare language, platform, edition and acquisition method. Full games, patches, trials, soundtracks, web links and direct files are labelled separately.
- Embedded aria2 supports HTTP / HTTPS, magnets and torrents, with pause, resume, limits and completed-file naming. qBittorrent is optional.
- Read downloaded CBZ comics in continuous, single-page or fullscreen mode. The TXT reader offers chapters, typography, paper themes and saved progress. Continue to the next downloaded unit of the same work.
- Keep settings, records, readers and default files in a portable `Data` folder. Registered internal paths follow a moved profile.

The interface uses real cover art and a warm television mark. No generated AI characters are included.

## Screenshots

Real v0.3.9 desktop captures using an isolated profile and public metadata. Version 0.4.0 retains this visual style.

| Seasonal anime | Manga |
| --- | --- |
| ![Anime discovery](docs/screenshots/01-anime.png) | ![Manga discovery](docs/screenshots/02-manga.png) |
| Light novels | Visual novels |
| ![Novel discovery](docs/screenshots/03-novel.png) | ![Visual novel discovery](docs/screenshots/04-galgame.png) |

## Start on Windows

Download the **Windows x64 portable ZIP** from [Releases](https://github.com/CidneyAurum/ACGN-Hub/releases/latest), extract it completely to a writable folder, and run `START-PORTABLE.cmd`. The adjacent EXE uses the same `Data` folder when the `ACGN-HUB-PORTABLE` marker is present. Keep the complete folder together.

Microsoft Edge WebView2 Runtime is required. Normal use does not require Node.js, Rust or a separate aria2 installation. An NSIS installer is also provided. Windows x64 is the current release target.

Confirm output folders in **Settings**, enable the sources you need in **Sources**, then open a work or search a source directly. Download-source presets are disabled by default. Optional JMComic and public-video workflows require their respective local tools. Packages contain no user profile or media.

## Source capabilities

| Source | What it provides |
| --- | --- |
| Bangumi / VNDB | Metadata, cover art, relationships and release records; not media downloads |
| Mikan / AcgnX / custom RSS | Source-provided torrents, magnets and links; transfer speed depends on peers and the network |
| MangaBZ / CopyManga / MangaDex | Accessible chapter images packaged as CBZ; languages depend on the source and chapter |
| LNovel | Publicly readable Chinese light-novel text, exported as TXT without illustrations |
| Shinnku | Direct archive files from translated and original-language catalogs; editions and split archives remain distinct |
| ShionLib | Edition, platform, file and hash listings; obtaining actual links may require source-site verification |
| KUN / VNDB release entries | Community pages, official stores, trials and freeware references; web pages open in a browser |

Version 0.4.0 improves LNovel title / author matching, text handling and explicit work-ID lookups, expands original-language game listings, and fixes matching, pagination and cancellation issues. Chinese Windows game entries retain priority. Original-language files are not assumed to contain Chinese translations.

Novel discovery shows the first 8 real recommendations before completing a 24-work page. Expired saved results remain visible during refresh. If a later batch fails, existing results are retained and **Complete this page** retries the current page.

When LNovel's cache misses a main series, official monthly / weekly indexes supplement the search. Mushoku Tensei's main series (2013) and Redundancy (4325) remain separate. The main-series details currently return HTTP 408 and its first chapter is taken down; a complete volume was not downloaded in this round. See the [source verification](docs/research/lnovel-main-series-v040.md), in Chinese, for the current limits.

A reachable catalog is not a guarantee that every listed file can be downloaded. Source availability and access conditions can change. WeebCentral and Kuaikan have been removed.

## Move or upgrade a portable profile

Close the app before copying the **entire portable folder, including `Data`**. On the next launch, registered paths inside the previous profile and reading-position keys are updated. External custom folders stay at their original paths. Active managed downloads are paused for an explicit resume; local control files are retained.

For upgrades, back up the old folder, extract the new package into a separate folder, and copy the old `Data` into it before starting. Preserve an existing destination `Data` rather than merging profiles. Older releases without a stored profile identity are detected only when multiple default paths agree. Never run two instances against the same profile.

Windows publishing no longer depends on NTFS hard links. Physical exFAT devices have not been tested; FAT32 still has its 4 GiB file limit. WebView2 remains a system prerequisite. Unfinished rename recovery must be resolved at the original location before moving. Connection credentials may need to be entered again on another computer.

## Development

Vue 3, TypeScript and Vite on the frontend; Tauri 2, Rust and SQLite on desktop. Use a Node.js LTS version supported by the locked Vite release. Native Windows builds also require Rust MSVC, Visual Studio C++ Build Tools and the Windows SDK.

```powershell
npm ci
npm run dev
```

Validation and native packaging:

```powershell
npm run verify
npm run test:e2e
powershell -NoProfile -File .\src-tauri\scripts\build-desktop.ps1 -Action test
powershell -NoProfile -File .\src-tauri\scripts\build-desktop.ps1 -Action bundle
```

Browser development previews the interface; native downloads and local-file access require the desktop build. Version consistency is checked before desktop compilation. Publishing scripts require matching scan evidence. User databases, media, build outputs and local evidence are excluded from Git.

## Verification and credits

Unit tests and fixture-based browser tests cover regressions; real-source probes and desktop samples have separate scopes. A complete visual-novel download, installation and launch has not been verified. Other desktop platforms are not verified. Video codecs depend on the system; EPUB and PDF use external readers.

See the [verification record](VERIFICATION.md), [user guide](docs/releases/v0.4.0-usage.md), [archived README](HISTORY.md) and [third-party notices](THIRD_PARTY_NOTICES.md). The archive preserves historical wording and original path references.

Artwork, text and other media belong to their respective rights holders. Public source availability does not change third-party licenses. This project has not specified a separate project license.
