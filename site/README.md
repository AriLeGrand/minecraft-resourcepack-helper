# Blockwright website

A static presentation site for Blockwright: plain HTML, CSS and JavaScript,
no framework and no build step.

- `index.html`: the page
- `styles.css`: all styles
- `script.js`: menu, screenshot tabs, lightbox, FAQ, scroll reveal
- `assets/`: icon, favicon and app screenshots

## View it

Open `index.html` in a browser, or serve the folder with any static server,
for example from the repository root:

```
python -m http.server 8765 --directory site
```

then go to http://localhost:8765.

## Publish it

The folder works as-is on GitHub Pages or any static host; all paths are
relative. GitHub Pages publishes a branch's root or its `/docs` folder, so
either push the contents of `site/` to a `gh-pages` branch and pick that
branch in Settings → Pages, or deploy the `site` folder with a GitHub Actions
Pages workflow (`actions/upload-pages-artifact` with `path: site`).
