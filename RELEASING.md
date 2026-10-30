# Releasing a new version

My Assistant looks for updates in these places, in this order (Settings → Updates → Update source):
1. https://updates.personalassistance.soft-tech.net   (GitHub Pages, served from this repo's /docs folder)
2. https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs   (the same folder, straight from GitHub)
3. https://abish-assistant-v2.sites.tab.bot   (the old release site)
If one can't be reached (or is behind), the next one is used. A download whose sha256 doesn't match stops
the update: nothing is installed. It never installs a version older than the one running.

Each place has the same files:
    version.json                          {"version": "X.Y.Z", "date": "YYYY-MM-DD", "notes": "What changed, in plain words."}
    myassistant-X.Y.Z.tar.gz (+ .sha256)  this version (kept: older ones stay for rollback)
    myassistant-latest.tar.gz (+ .sha256) a copy of the newest one
    install.sh                            the installer (curl -fsSL https://updates.personalassistance.soft-tech.net/install.sh | sudo bash)

To release version X.Y.Z:
1. Put X.Y.Z in VERSION and in package.json ("version"). Commit.
2. Make the tarball. It must unpack to a `myassistant/` folder (the app's files directly inside):
       tar -czf myassistant-X.Y.Z.tar.gz --exclude=node_modules --exclude=docs --exclude=.git myassistant
   (run it from the folder that contains the app folder named myassistant), then:
       sha256sum myassistant-X.Y.Z.tar.gz > myassistant-X.Y.Z.tar.gz.sha256
       cp myassistant-X.Y.Z.tar.gz docs/myassistant-latest.tar.gz
       sha256sum docs/myassistant-latest.tar.gz | sed 's#docs/##' > docs/myassistant-latest.tar.gz.sha256
   and copy myassistant-X.Y.Z.tar.gz + its .sha256 into docs/.
   The .sha256 files hold the hex digest first (sha256sum format); the file name after it does not matter.
3. Copy install.sh into docs/ (so the address above can install from scratch).
4. Write docs/version.json LAST (so the app never sees a version whose files are missing), then push to main.
   GitHub Pages publishes docs/ at https://updates.personalassistance.soft-tech.net within a minute or two.
5. In the app: Settings → Updates → Check now → Update now.
