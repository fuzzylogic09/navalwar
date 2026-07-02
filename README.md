# Battleship — multiplayer PWA (Firebase)

A 100% front-end (vanilla HTML/CSS/JS) game of Battleship, with no application server at all.
All the game logic runs in each player's browser; **Google Firebase (Firestore)** is only used
as a shared database and a real-time "bus" between the two browsers.

- Create a game / browse and join an open game
- Fleet placement (5 ships, classic rules)
- Turn-based play, synced in real time via `onSnapshot`
- Play several games at once, with a "your turn" indicator and a vibration alert
- Resume a game you left, or delete a stuck/abandoned one
- Deployable on GitHub Pages, installable as a PWA on Android (and desktop)

---

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**.
2. Give it a name (e.g. `battleship`), skip Google Analytics if you don't need it, confirm.
3. Left menu: **Build > Authentication** → **Sign-in method** tab → enable the **Anonymous**
   provider. (Each player gets a unique ID without creating an account.)
4. Left menu: **Build > Firestore Database** → **Create database** → **production** mode → pick
   a region close to your players.
5. Still in Firestore, **Rules** tab → paste the security rules from section 3 below → **Publish**.
6. Go back to **Project settings** (gear icon) > **General** tab > "Your apps" section > click the
   **Web `</>`** icon.
7. Give the app a nickname, **don't check** Firebase Hosting (we're using GitHub Pages), click
   **Register app**.
8. Firebase shows you a `firebaseConfig` object — copy it as-is into `js/firebase-config.js`,
   replacing the `REPLACE_ME` placeholders.

That's it on the console side: no Cloud Functions, no backend to host.

---

## 2. Firestore data model

```
games/{gameId}                        → PUBLIC document (game metadata)
  hostUid, hostName
  guestUid, guestName
  status        "waiting" | "placing" | "playing" | "finished"
  turn          "host" | "guest" | null
  pendingShot   { by: uid, row, col } | null
  winner        "host" | "guest" | null
  hostReady, guestReady   booleans — set once each player has placed their fleet
  createdAt

games/{gameId}/private/{uid}          → PRIVATE subcollection (one per player)
  grid          10x10 flattened array: 0 = empty, otherwise the id of the ship on that cell
  ships         [{ id, name, size, hits, cells:[{r,c},...] }, ...]
  ready         bool

games/{gameId}/shots/{uid}            → "shots fired by this player" subcollection
  grid          10x10 flattened array: 0 = not fired at, "miss" | "hit" | "sunk"
```

> Firestore doesn't support nested arrays (arrays of arrays), so grids are stored as a flat
> 100-item array instead of `[[...],[...]]`, and ship cell coordinates as `{r,c}` objects instead
> of `[r,c]` pairs. `js/app.js` converts back and forth automatically (`gridToFlat` /
> `flatToGrid`, `cellsToObj` / `cellsFromObj`).

### Why this split (instead of one document with two matrices)?

Firestore can't hide a *field* of a document from a user who has read access to that document. If
both players' ship positions lived in the same `games/{id}` document, any player could read the
opponent's ship positions straight from the database (trivial cheating, no client hacking needed).

By splitting things up:
- `private/{uid}` — **only the owner `uid` can read/write** their own fleet layout.
- `shots/{uid}` — each player's shot history, readable by both participants (needed to render the
  fog of war on the attacker's side), but its content only ever reveals "hit / miss / sunk", never
  the position of untouched ships.

### Who writes what?

- **The attacker** only writes `pendingShot` on the public `games/{id}` document ("I'm firing
  here").
- **The defender** (the owner of the targeted board) is the only one who knows their own ship
  positions, so they compute the result (hit/miss/sunk) and write:
  - the updated `ships[].hits` in their own `private/{theirUid}`
  - the result in `shots/{attackerUid}`
  - the turn change + `pendingShot: null` (+ `winner` if the game just ended) in `games/{id}`

  These three writes are sent as a single `writeBatch` to stay consistent even across a flaky
  connection.

---

## 3. Firestore security rules

Paste this into **Firestore > Rules**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /games/{gameId} {
      allow read: if request.auth != null;

      // Create: only as the host of your own game
      allow create: if request.auth != null
                    && request.resource.data.hostUid == request.auth.uid
                    && request.resource.data.status == 'waiting';

      // Update: only the two players in the game
      allow update: if request.auth != null
                    && (request.auth.uid == resource.data.hostUid
                        || request.auth.uid == resource.data.guestUid
                        // or a player joining a still-open game
                        || (resource.data.guestUid == null
                            && request.resource.data.guestUid == request.auth.uid));

      // Delete: only the host or the guest of the game
      // (lets you "kill" a stuck / abandoned game)
      allow delete: if request.auth != null
                    && (request.auth.uid == resource.data.hostUid
                        || request.auth.uid == resource.data.guestUid);

      match /private/{ownerUid} {
        allow read, write: if request.auth != null && request.auth.uid == ownerUid;
      }

      match /shots/{ownerUid} {
        // Read by both players in the game (fog of war shown on both sides)
        allow read: if request.auth != null
                    && (request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.hostUid
                        || request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.guestUid);

        // Written either by its owner (initializing the empty grid),
        // or by the other player in the game (resolving a shot as defender)
        allow write: if request.auth != null
                    && (request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.hostUid
                        || request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.guestUid);
      }
    }
  }
}
```

> These rules already prevent a good chunk of cheating (you can't read the opponent's ship
> layout), but since all shot-resolution logic runs client-side, a malicious player could in
> theory tamper with their own client to lie about their own results. For a game played with
> friends, that's a reasonable trade-off — it's the price of a 100% front-end architecture with no
> trusted server.

### Required composite index

The open-games list uses a `where('status','==','waiting')` query combined with
`orderBy('createdAt','desc')`. Firestore will ask you to create a **composite index** the first
time you run the app: a link appears directly in the browser console (error
`FirebaseError: The query requires an index...`) — click it, Firebase pre-fills everything, just
confirm.

---

## 4. Run locally

Since the JS uses ES modules (`import`), files must be served over HTTP (not `file://`):

```bash
cd battleship-pwa
python3 -m http.server 8080
# then open http://localhost:8080
```

Open two tabs (or one tab + a private window) to simulate two players.

---

## 5. Deploy on GitHub Pages

1. Create a GitHub repo (e.g. `battleship`) and push the whole `battleship-pwa/` folder content
   to the repo root.
2. Fill in `js/firebase-config.js` with your real keys **before** pushing (Firebase "Web" keys
   aren't secret by themselves — that's the public Configuration API — the real protection comes
   from the Firestore security rules in section 3).
3. In the repo: **Settings > Pages** → Source: **Deploy from a branch** → Branch: `main` /
   folder `/ (root)` → **Save**.
4. After 1-2 minutes, the game is live at `https://<your-user>.github.io/battleship/`.
5. Add that URL under **Firebase Console > Authentication > Settings > Authorized domains** to
   allow anonymous auth from GitHub Pages.

---

## 6. Install as a PWA on Android

Once the site is live (HTTPS required — GitHub Pages provides it automatically):

1. Open the URL in Chrome on Android.
2. Menu **⋮ > Add to Home screen** (or an install banner shows up automatically).
3. The app installs with the radar icon from `icons/`, opens full-screen (`display: standalone`),
   and `service-worker.js` caches the app shell for a fast start even on a weak connection (game
   content itself always needs a live connection to Firestore).

To swap in your own icons, just regenerate `icons/icon-192.png` and `icons/icon-512.png` (same
dimensions, opaque background recommended).

---

## 7. Feature notes

### Deleting a game ("killing" a stuck game)

In the menu, the **"My games"** section lists every game you created or joined, regardless of
status. A **Delete** button is available there, with two-step confirmation (click "Delete" → it
turns into "Yes, delete" / "Cancel").

Deleting a game removes the `games/{id}` document plus, best-effort, the `private/` and `shots/`
subcollections of both players. If the other player is actively in that game when it's deleted,
their client is automatically sent back to the menu with a notice.

### Resuming a game

Firebase's anonymous auth keeps your identity in the same browser as long as you don't clear its
data — that's exactly why your games show up under "My games" in the first place. A **Resume**
button lets you jump straight back into any non-finished game: back onto the battle screen if
it's in progress, or back to your saved fleet if you're still in the placement phase.

This covers "I closed the tab and I'm coming back later, same device/browser" — by far the most
common case. Resuming from a **different** device/browser isn't supported: that would require a
real account system (e.g. Google Sign-In instead of anonymous auth) to safely transfer identity,
since a player's ship layout is only ever readable by their own Firebase Auth `uid`.

### Playing several games at once

Nothing special to set up — since Firestore listeners for all "my games" run continuously in the
background regardless of which screen you're on, you can freely bounce between games via
"Resume". Each row in "My games" shows a live **Your turn** / **Opponent's turn** badge for games
in progress, so you always know where you're needed.

### Turn notifications (vibration)

The moment it becomes your turn in *any* of your games — even one you're not currently looking
at — the app triggers a short vibration pattern (on devices/browsers that support the Vibration
API) plus a toast naming the opponent. This only fires on the transition from "not your turn" to
"your turn", not on every snapshot update, so you won't get buzzed repeatedly while waiting.

### Renaming your captain

Click your name in the top-right corner to edit it inline (Enter to confirm, Esc to cancel). The
new name is saved locally and also pushed to any of your active games so your opponent sees the
update.

---

## 8. Going further

- **Rematch**: add a button that creates a new game and redirects both players — needs a small
  extra signal on `games/{id}` (e.g. `rematchOf`). Cleaning up old abandoned games: an optional
  scheduled Cloud Function, or a Firestore TTL policy on `createdAt`, could purge them
  automatically (outside the "100% front-end" scope of this project).
- **"Fire again after a hit" rule**: in `resolveIncomingShot()` (`js/app.js`), simply skip
  changing `turn` when `result !== 'miss'`.
- **Blocking out-of-turn shots at the rules level**: already blocked in the UI (the cell isn't
  clickable) — for real enforcement, add a Firestore rule checking `resource.data.turn` before
  allowing a `pendingShot` write.
- **Cross-device resume**: switch from anonymous auth to a real sign-in method (Google, email
  link, etc.) so a player's `uid` — and therefore their private board — stays stable across
  devices.