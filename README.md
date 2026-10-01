# Ideation Review site

This is a static page for reviewing the target system prompts (and the tools, source case, and evaluator scenarios around them) in `bloom_inputs/*/`. Reviewers log in with a name and password, highlight text, and leave comments and replies. The page is hosted on Firebase Hosting, and comments are stored in Firestore.

Live site: https://bloompromptreader.web.app (Firebase project `bloompromptreader`).

```
review_site/
  export_data.py        # bloom_inputs → public/data/runs.json
  firestore.rules       # shared password + access rules
  firebase.json
  public/
    index.html, app.js, style.css
    firebase-config.js  # web app config for the Firebase project
    data/runs.json      # generated, not committed
```

## Data

`public/data/` is not in git. Generate it from a checkout that has the Bloom inputs before you preview or deploy:

```
python export_data.py --inputs path/to/bloom_inputs   # default: ../bloom_inputs
```

## One-time setup

1. Create a project at https://console.firebase.google.com (Analytics can stay off).
2. Go to **Build → Authentication → Sign-in method** and enable **Anonymous**.
3. Go to **Build → Firestore Database → Create database** and start it in production mode.
4. Go to **Project settings → Your apps → Web (</>)**, register an app, and paste its config into `public/firebase-config.js`.
5. The shared password is `sharedCode()` in `firestore.rules` (currently `loyal`). Reviewers type any name.
6. Deploy with the CLI:
   ```
   npm i -g firebase-tools
   firebase login
   cd build/review_site
   firebase use --add            # pick the project
   python export_data.py
   firebase deploy
   ```
   Deploying prints the site URL (`https://<project>.web.app`). Send that URL to each reviewer along with their name and password.

## Routine updates

| What changed | Command |
|---|---|
| `agent_config.py` regenerated the ideation files | `python export_data.py && firebase deploy --only hosting` |
| The shared password changed | edit `firestore.rules` → `firebase deploy --only firestore:rules` |

Existing comments stay attached after the data is regenerated. Each highlight stores the text it quoted, so it is re-located by searching for that text. If the text no longer exists, the quote appears in the sidebar with a red bar.

To test locally, run `cd public && python -m http.server 8000`. `localhost` is authorized by default, so the real Firestore works from there.

## Notes

- **Only comments are protected by the password.** `data/runs.json` is a static file, so anyone who has the URL can read it. If that matters, the scenario data should move into Firestore behind the same rules.
- Highlights are private. They are stored at `highlights/{lower-case name}/items`, and only their owner can read them. Adding a memo to a highlight turns it into a shared comment and removes the private highlight.
- Anyone can mark a comment resolved or reopen it. Only the author can edit or delete a comment. A root comment cannot be deleted once it has replies; resolve it instead.
- Comments are stored in the `comments` collection with these fields: `parent` (null for a thread root), `runId`, `vIdx` (-1 = run-level: system prompt, tools, source case, agent config; 0..n = evaluator scenario of that variation), `field`, `start`/`end`/`quote` (null for a whole-section comment), `author`, `text`, `resolved`, `createdAt`. You can export them from the console or with the Admin SDK.
