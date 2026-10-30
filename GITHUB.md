# Updates from GitHub

Since 2.3.1 the assistant takes its updates from your repo's /docs folder, published by GitHub Pages at
https://updates.personalassistance.soft-tech.net. If that can't be reached it reads the same folder from
https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs, and after that
https://abish-assistant-v2.sites.tab.bot. How to put a new version there: see RELEASING.md.

Settings → Updates → Update source shows the order. "Another address" takes any https folder with the same files
(version.json, myassistant-latest.tar.gz + .sha256); a github.com/OWNER/REPO link is turned into its /docs folder.

The older mode ("GitHub latest release" of an OWNER/REPO, set in 2.1–2.3.0) still works for anyone who had it set;
choosing the default or another address in Update source turns it off.
