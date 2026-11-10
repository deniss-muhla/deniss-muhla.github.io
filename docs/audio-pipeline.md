# Audio pipeline

The assistant synthesizes speech in the browser with
the pinned same-origin Paradee model. The model loads on demand in a worker and produces 24 kHz
audio. A synthesis failure is shown to the user; there is no prerecorded fallback. See
[assistant runtime](assistant-runtime.md) and [third-party assets](third-party.md).

The former Kitten prerecorded corpus, its build check and the development facts/audio pair
guard are not used, and the prerecorded corpus is not served. The CV facts check still gates the
build. The legacy Kitten generator and `cv:audio` commands remain in the repository but are not
used by the runtime or site build. This does not grant publication authority or establish offline
readiness.

## Current command interface

Run `pnpm cv:facts:check` to validate the installed facts index and `pnpm build` to build the
site. Model assets must already be in the external cache; see [development](development.md).

## Assistant smoke check

Install the locked project dependencies and Chrome for Puppeteer, and build with the required
model assets already cached (`pnpm build`). Run the local suggestions and Paradee check with:

```sh
scripts/linux/assistant-smoke.sh
scripts/macos/assistant-smoke.sh
```

On Linux the wrapper looks for a system Chromium/Chrome, then Puppeteer's installed browser.
On macOS it uses Puppeteer's installed browser. Set `CHROME_PATH` to override discovery. It
starts a local preview on port 4179 and closes it after the check. Browser requests to other
origins are blocked. This diagnostic checks a running, nonzero 24 kHz audio buffer, not audible
output or human acceptance. No dependencies or models are downloaded by these scripts.
