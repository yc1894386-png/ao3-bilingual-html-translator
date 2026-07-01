# AO3 Bilingual HTML Translator

AO3 HTML / EPUB bilingual translation helper for local reading workflows.

## Run Locally

```bash
npm start
```

Then open:

```text
http://localhost:4191
```

## Features

- Import AO3 HTML / XHTML / EPUB files
- Multi-work import and deletion
- Google batch translation
- Doubao / DeepSeek AI translation and light proofreading
- Glossary support
- Selected paragraph retranslation
- Bilingual / Chinese / English HTML export
- Bilingual / Chinese / English EPUB export
- Local autosave and restore after refresh

## Secrets

Do not commit `.env` or `.env.local`.

API keys should stay on your own machine.

## GitHub Pages Note

GitHub Pages can host only static files. This project has a local Node server for translation APIs, so the full translation workflow should be run locally with `npm start`, or deployed later to a backend-capable platform.
