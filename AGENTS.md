# Repository workflow

## Keep the public GitHub repository current

- After every completed and authorized source or documentation change, run `npm run build`.
- Commit only the files related to the requested change, then push the completed commit to `github/main` unless the user explicitly asks to keep the work local or as a draft.
- Confirm that local `HEAD` matches `github/main` and that the GitHub Pages deployment succeeds before reporting completion.
- Never publish secrets, credentials, temporary archives, dependencies, or generated folders.
- Do not push incomplete work or a failing build.
