# Landing page

One static page, `index.html`, with its own images and fonts beside it. No
build step, no backend, and nothing is loaded from another site.

The typefaces are Archivo and Courier Prime, both under the SIL Open Font
License; the font files and their licence texts are in `fonts/`.

## Preview

```sh
open site/index.html
```

## Before deploying

`site/check.sh` lists what is still a placeholder, a claim the repository
does not back up, or a file the page asks for and does not have, and exits
non-zero until all of it is settled:

- the waitlist form's address (`YOUR_FORM_ID` in the form's `action`; a
  Formspree form address works as it is)
- the GitHub link (the repository has to exist and be public)
- the one-liner (the package has to be on npm)
- the licence named on the page has to match `packages/cli/package.json`
- the page has to stay one self-contained file that loads nothing from
  another site, and every file it points at has to be in `site/`: the
  screenshot, the fonts and their licence texts

## Deploying

- **GitHub Pages:** run the "Deploy landing page" workflow by hand. It runs
  `site/check.sh` first and stops if anything is not ready.
- **Cloudflare Pages:** connect the repository, leave the build command
  empty and set the output directory to `site`.

## Updating the sample report

```sh
site/update-sample.sh
```

It scans the test account live, replaces the account ID, resource IDs,
upload ID and public IP with stand-ins, writes the report to
`site/sample-report.html`, and takes a sharp screenshot of its top
as `site/sample-report.png`. Run it again after changing the report's design.
