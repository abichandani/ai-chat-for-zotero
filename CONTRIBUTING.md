# Contributing

Thanks for poking around this plugin's source. It's a small DIY scaffold,
so the dev loop is kept correspondingly simple.

## Prerequisites

- [Zotero 7+](https://www.zotero.org/) installed locally
- Node.js and npm

## Setup

```
npm install
cp .env.example .env
```

Edit `.env` to point at your local Zotero binary and profile directory
(the example file shows the typical paths for each OS).

## Live-reload dev loop

Plugin source lives in [addon/](addon/) (`manifest.json`, `bootstrap.js`,
`content/`). This repo uses
[zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)
so you don't have to manually rebuild/reinstall an xpi after every change:

1. **Close Zotero** if it's already running — the dev server launches its
   own instance against the profile in `.env`.
2. `npm start`. This launches Zotero, installs the plugin straight from
   `addon/`, and rebuilds + hot-reloads it into the running instance
   whenever you save a file.

## Building an xpi manually

`npm run build` produces `.scaffold/build/claude-reader.xpi`, the same
artifact end users install via **Tools → Plugins → Install Plugin From
File**. Use this when you want a distributable file rather than a live
dev session.
