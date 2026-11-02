# ACGN Hub

A library for anime, manga, light novels and visual novels on Windows and Android. Discover works, compare sources, manage downloads and read your offline collection in one place.

**[Download released builds](https://github.com/CidneyAurum/ACGN-Hub/releases/latest)** · [中文](README.md) · [0.5.2 user guide, Chinese](docs/releases/v0.5.2-usage.md)

**[Version 0.5.2 is released, with all nine assets downloaded and verified](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.5.2)**, improving resource selection, library / source initialization, Android task recovery and JSON request lifecycles. See the [guide](docs/releases/v0.5.2-usage.md), in Chinese. This release does not change network routing or remove node restrictions.

## Features

- Seasonal anime discovery follows the local calendar, with past seasons and a broadcast schedule. Manga, novels and visual novels have their own cover shelves.
- Search for a title or author and see related works. Metadata comes from Bangumi and VNDB; source searches can also run independently.
- Compare language, platform, edition and acquisition method. Full games, patches, trials, soundtracks, web links and direct files are labelled separately.
- Windows uses embedded aria2 for HTTP / HTTPS, magnets and torrents; qBittorrent is optional. Android has its own foreground HTTP engine and supports the CBZ / TXT download workflows. Available actions reflect each platform's capabilities.
- Read downloaded CBZ comics in continuous, single-page or fullscreen mode. The TXT reader offers chapters, typography, paper themes and saved progress. Continue to the next downloaded unit of the same work.
- On Windows, keep settings, records, readers and default files in a portable `Data` folder. Registered internal paths follow a moved profile. Android uses private application storage; the platforms keep separate profiles.

The interface uses real cover art and a warm television mark. No generated AI characters are included.

## Screenshots

Real v0.3.9 desktop captures using an isolated profile and public metadata. Later versions retain this visual style. These images do not represent Android device verification.

| Seasonal anime | Manga |
| --- | --- |
| ![Anime discovery](docs/screenshots/01-anime.png) | ![Manga discovery](docs/screenshots/02-manga.png) |
| Light novels | Visual novels |
| ![Novel discovery](docs/screenshots/03-novel.png) | ![Visual novel discovery](docs/screenshots/04-galgame.png) |

Real final v0.5.0 APK captures from an independent **Android API 35 emulator**, using public metadata and an isolated profile.

| Android novel shelf | Android built-in reader |
| --- | --- |
| <img src="docs/screenshots/05-android-novel-shelf.png" alt="Android novel shelf" width="280"> | <img src="docs/screenshots/06-android-reader.png" alt="Android novel reader" width="280"> |

## Start on Windows

Download the **Windows x64 portable ZIP** from [Releases](https://github.com/CidneyAurum/ACGN-Hub/releases/latest), extract it completely to a writable folder, and run `START-PORTABLE.cmd`. The adjacent EXE uses the same `Data` folder when the `ACGN-HUB-PORTABLE` marker is present. Keep the complete folder together.

Microsoft Edge WebView2 Runtime is required. Normal use does not require Node.js, Rust or a separate aria2 installation. An NSIS installer is also provided. Windows builds target x64.

Confirm output folders in **Settings**, enable the sources you need in **Sources**, then open a work or search a source directly. Download-source presets are disabled by default. Optional JMComic and public-video workflows require their respective local tools. Packages contain no user profile or media.

## 0.5.0: Windows and Android

One Android APK includes **arm64-v8a and x86_64**, with a minimum of **Android 8.0 / API 26**. Bottom navigation opens the library, sources and downloads, with additional tools in the menu. Comics support touch paging and portrait / landscape reading. Completed files can open Android's system export / share chooser.

| Capability | Windows x64 | Android |
| --- | --- | --- |
| Discovery, search and collections | Supported | Supported |
| Ordinary HTTP file downloads | Embedded aria2 | Native foreground engine; pause / resume and restart recovery tested |
| CBZ / TXT downloads and built-in reading | Supported | Supported, with touch paging and saved reading positions |
| Magnets, torrents and qBittorrent | Supported | Unsupported; actions indicate the desktop requirement |
| Python, JMComic and public-video tools | Requires corresponding local tools | Unsupported |
| Visual-novel resource search and archive downloads | Source-dependent | Search and ordinary HTTP archives |
| Windows game launch and save tools | Supported for the corresponding local workflow | Unsupported |
| Portable profile migration | Move the complete `Data` directory | Private application storage; no Windows portable mode |

Android downloads require the application to remain running. Native HTTP tasks save checkpoints and recover paused after a restart; resuming depends on server support. There is no system background download service, so continuous lock-screen or background transfers are not promised. CBZ and TXT use the built-in readers; video playback depends on Android WebView and installed codecs. Profiles are separate, without automatic cross-platform synchronization. See the [build and verification record](docs/research/android-v050.md) for tested samples and device scope.

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

When LNovel's cache misses a main series, official monthly / weekly indexes supplement the search. Mushoku Tensei's main series (2013) and Redundancy (4325) remain separate. During 0.4.0 verification, the main-series details returned HTTP 408 and its first chapter was taken down; a complete volume was not downloaded. This does not establish current download availability. See the [source verification](docs/research/lnovel-main-series-v040.md), in Chinese, for that sample's limits.

A reachable catalog is not a guarantee that every listed file can be downloaded. Source availability and access conditions can change. WeebCentral and Kuaikan have been removed.

## Move or upgrade a portable profile

Close the app before copying the **entire portable folder, including `Data`**. On the next launch, registered paths inside the previous profile and reading-position keys are updated. External custom folders stay at their original paths. Active managed downloads are paused for an explicit resume; local control files are retained.

For upgrades, back up the old folder, extract the new package into a separate folder, and copy the old `Data` into it before starting. Preserve an existing destination `Data` rather than merging profiles. Older releases without a stored profile identity are detected only when multiple default paths agree. Never run two instances against the same profile.

Windows publishing no longer depends on NTFS hard links. Physical exFAT devices have not been tested; FAT32 still has its 4 GiB file limit. WebView2 remains a system prerequisite. Unfinished rename recovery must be resolved at the original location before moving. Connection credentials may need to be entered again on another computer.

## Development

Vue 3, TypeScript and Vite on the frontend; Tauri 2, Rust and SQLite in the native layer, with Gradle / Kotlin for Android packaging. Use a Node.js LTS version supported by the locked Vite release. Native Windows builds also require Rust MSVC, Visual Studio C++ Build Tools and the Windows SDK.

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

Browser development previews the interface; native downloads and local-file access require the corresponding native application. Version consistency is checked before desktop compilation. Publishing scripts require matching scan evidence. User databases, media, build outputs and local evidence are excluded from Git.

Android builds also require JDK 17, the Android SDK / NDK and the relevant Rust targets. Windows hosts still need the MSVC tools above. After setting `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`:

```powershell
powershell -NoProfile -File .\src-tauri\scripts\build-android.ps1 -Action info
powershell -NoProfile -File .\src-tauri\scripts\build-android.ps1 -Action build
```

The default build includes arm64 and x86_64. Packaging copies verified native libraries without changing Windows symbolic-link permissions. Release APKs must also be signed. See the [0.5.0 guide](docs/releases/v0.5.0-usage.md#开发构建) for tool versions and signing steps. Keep signing keys, passwords, profiles and build caches out of Git.

## Verification and credits

Version 0.5.2 passes **743 frontend tests, all 102 browser tests and 118 Rust tests** (2 ignored), plus type checks. Final Windows samples read existing TXT / CBZ files and saved positions. The API35 Android emulator preserves collections / sources after upgrading, invalidates changed LNovel queries, opens a 20-volume list and downloads / reads a fresh first volume with chooser cancellation. Original 9 database tables, 3 media files and 26 older executables remain intact. All nine downloaded assets match their sizes, SHA256 hashes and GitHub digests, with portable ZIP and APK identities verified. See the [verification record](VERIFICATION.md) for scope. Complete game installation / launch is not verified. EPUB and PDF require external readers.

See the [verification record](VERIFICATION.md), [0.5.0 guide](docs/releases/v0.5.0-usage.md), [released 0.4.0 guide](docs/releases/v0.4.0-usage.md), [archived README](HISTORY.md) and [third-party notices](THIRD_PARTY_NOTICES.md). The archive preserves historical wording and original path references.

Artwork, text and other media belong to their respective rights holders. Public source availability does not change third-party licenses. This project has not specified a separate project license.
