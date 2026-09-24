# Changelog

## v0.4.1 — 2026-09-24

### Added
- Reuse of the existing authenticated Yandex Playwright storage state inside the Telemost Puppeteer recorder.
- Persistent Chromium profile support through `TELEMOST_USER_DATA_DIR`.
- Adaptive selectors for the refreshed Telemost pre-join interface.
- Explicit account-gate and join diagnostics with screenshot and JSON artifacts.
- Meeting list, transcription and MongoDB memory improvements from the current rollout branch.

### Changed
- Chromium is installed from the current Debian repository package instead of a stale pinned build.
- Docker build context excludes runtime profile data.
- Recording artifacts are created only after the meeting join is confirmed.

### Fixed
- Telemost no longer treats the Yandex sign-in button as the meeting join button.
- Failed authentication no longer produces a misleading successful zero-byte recording.
- Existing Yandex authentication from the Alice/Station integration is shared read-only with the recorder.

### Verification
- Docker image rebuilt and container recreated successfully.
- Real Telemost smoke test imported 41 valid cookies, continued in the browser and confirmed meeting entry.
- Targeted syntax and Docker checks passed.
