# Update My Assistant from your own GitHub repo

Your assistant can take its updates from a GitHub repo you own instead of the default release site.

## 1. Create the repo
1. On github.com: **New repository** → name it e.g. `myassistant` → Public or Private → Create.
2. Upload the app's source (the folder that has `VERSION`, `install.sh`, `src/`, `public/`) to the repo,
   either with "Add file → Upload files" or with git:
   ```
   git init && git add . && git commit -m "My Assistant 2.1.2"
   git branch -M main && git remote add origin https://github.com/OWNER/myassistant.git && git push -u origin main
   ```

## 2. Make a release (each new version)
1. Change `VERSION` (and `package.json` "version") to the new number, e.g. `2.1.1`.
2. Build the package from the folder **above** the app folder (the app folder must be named `myassistant`):
   ```
   tar -czf myassistant-latest.tar.gz myassistant
   sha256sum myassistant-latest.tar.gz > myassistant-latest.tar.gz.sha256
   ```
3. On GitHub: **Releases → Draft a new release** → tag `v2.1.1` → attach both files
   (`myassistant-latest.tar.gz` and `myassistant-latest.tar.gz.sha256`) → Publish release.

The assistant reads the latest release, downloads `myassistant-latest.tar.gz`, checks it against the
`.sha256` file, and installs it the same way as always (data, keys and settings are kept; the database is
backed up first).

No files attached? It still works (best effort): it uses GitHub's source tarball of the latest release or tag,
as long as `VERSION`, `install.sh` and `src/server.js` are at the top of the repo. Without the `.sha256` file
there is no extra download check beyond GitHub's HTTPS.

## 3. Point your assistant at the repo
Settings → Updates → **Update source** → "My GitHub repo" → type `OWNER/myassistant` → Save → **Check now**.

- Private repo: create a GitHub token (Settings → Developer settings → Fine-grained token, read access to
  Contents of that repo) and save it on the assistant's **Vault** page with the name `github`.
- Then update with **Update now**, or on the server: `sudo myassistant update`.
- To go back to the default site: Update source → Default → Save.

Note: whoever controls the update source controls the code your server runs. Only use a repo you own.
