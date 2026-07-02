# Bataille Navale — PWA multijoueur (Firebase)

Jeu de bataille navale 100% front-end (HTML/CSS/JS vanilla), sans aucun serveur applicatif.
Toute la logique tourne dans le navigateur de chaque joueur ; **Google Firebase (Firestore)** sert
uniquement de base de données partagée et de "bus" temps réel entre les deux navigateurs.

- Créer une partie / rejoindre une partie en attente
- Placement de la flotte (5 navires, règles classiques)
- Tour par tour, mise à jour en temps réel via `onSnapshot`
- Déployable sur GitHub Pages, installable en PWA sur Android (et desktop)

---

## 1. Créer le projet Firebase

1. Va sur https://console.firebase.google.com et clique **Ajouter un projet**.
2. Donne-lui un nom (ex. `bataille-navale`), désactive Google Analytics si tu n'en as pas besoin, valide.
3. Dans le menu de gauche : **Build > Authentication** → onglet **Sign-in method** → active le fournisseur **Anonyme**.
   *(On utilise l'authentification anonyme : chaque joueur reçoit un identifiant unique sans créer de compte.)*
4. Dans le menu de gauche : **Build > Firestore Database** → **Créer une base de données** → mode **production** → choisis une région proche de tes joueurs.
5. Toujours dans Firestore, onglet **Règles**, colle les règles de sécurité de la section 3 ci-dessous, puis **Publier**.
6. Retourne dans **Paramètres du projet** (icône engrenage) > onglet **Général** > section "Vos applications" > clique l'icône **Web `</>`**.
7. Donne un surnom à l'app, **ne coche pas** Firebase Hosting (on utilise GitHub Pages), clique **Enregistrer l'application**.
8. Firebase t'affiche un objet `firebaseConfig` — copie-le tel quel dans le fichier `js/firebase-config.js` du projet, à la place des valeurs `REPLACE_ME`.

C'est tout côté console : pas de Cloud Functions, pas de backend à héberger.

---

## 2. Modèle de données Firestore

```
games/{gameId}                        → document PUBLIC (métadonnées de la partie)
  hostUid, hostName
  guestUid, guestName
  status        "waiting" | "placing" | "playing" | "finished"
  turn          "host" | "guest" | null
  pendingShot   { by: uid, row, col } | null
  winner        "host" | "guest" | null
  createdAt

games/{gameId}/private/{uid}          → sous-collection PRIVÉE (une par joueur)
  grid          matrice 10x10 : 0 = vide, sinon id du navire occupant la case
  ships         [{ id, name, size, hits, cells:[[r,c],...] }, ...]
  ready         bool

games/{gameId}/shots/{uid}            → sous-collection "tirs tirés par ce joueur"
  grid          matrice 10x10 : 0 = pas tiré, "miss" | "hit" | "sunk"
```

### Pourquoi cette séparation (et pas juste 2 matrices dans un seul document) ?

Firestore ne peut pas cacher un *champ* d'un document à un utilisateur qui a le droit de lire ce
document. Si les positions des bateaux des deux joueurs étaient dans le même document `games/{id}`,
n'importe quel joueur pourrait lire la position des navires adverses directement dans la base
(triche facile, même sans toucher à l'UI).

En séparant :
- `private/{uid}` — **seul le propriétaire `uid` peut lire/écrire** son propre plan de flotte.
- `shots/{uid}` — l'historique des tirs de chaque joueur, lisible par les deux participants
  (nécessaire pour afficher le brouillard de guerre côté attaquant), mais dont le contenu ne révèle
  que "touché / raté / coulé", jamais la position des navires non touchés.

### Qui écrit quoi ?

- **L'attaquant** écrit uniquement `pendingShot` sur le document public `games/{id}` (annonce "je tire ici").
- **Le défenseur** (celui qui possède le plateau visé) est le seul à connaître la position de ses
  navires : c'est donc lui qui calcule le résultat (touché/raté/coulé) et qui écrit :
  - la mise à jour de ses propres `ships[].hits` dans `private/{sonUid}`
  - le résultat dans `shots/{uidDeLAttaquant}`
  - le changement de tour + `pendingShot: null` (+ `winner` si la partie est terminée) dans `games/{id}`

  Ces trois écritures sont envoyées en une seule transaction groupée (`writeBatch`) pour rester
  cohérentes même en cas de coupure réseau.

---

## 3. Règles de sécurité Firestore

À coller dans **Firestore > Règles** :

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /games/{gameId} {
      allow read: if request.auth != null;

      // Création : uniquement en tant qu'hôte de sa propre partie
      allow create: if request.auth != null
                    && request.resource.data.hostUid == request.auth.uid
                    && request.resource.data.status == 'waiting';

      // Mise à jour : uniquement les deux joueurs de la partie
      allow update: if request.auth != null
                    && (request.auth.uid == resource.data.hostUid
                        || request.auth.uid == resource.data.guestUid
                        // ou un joueur qui rejoint une partie encore libre
                        || (resource.data.guestUid == null
                            && request.resource.data.guestUid == request.auth.uid));

      match /private/{ownerUid} {
        allow read, write: if request.auth != null && request.auth.uid == ownerUid;
      }

      match /shots/{ownerUid} {
        // Lu par les deux joueurs de la partie (fog of war affiché des deux côtés)
        allow read: if request.auth != null
                    && (request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.hostUid
                        || request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.guestUid);

        // Écrit soit par son propriétaire (initialisation à la grille vide),
        // soit par l'autre joueur de la partie (qui résout un tir en tant que défenseur)
        allow write: if request.auth != null
                    && (request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.hostUid
                        || request.auth.uid == get(/databases/$(database)/documents/games/$(gameId)).data.guestUid);
      }
    }
  }
}
```

> Ces règles limitent déjà pas mal la triche (impossible de lire le plan de bataille adverse), mais
> comme toute la logique de résolution du tir tourne côté client, un joueur malveillant pourrait en
> théorie modifier son propre client pour tricher sur ses propres résultats. Pour un jeu entre amis,
> c'est un compromis raisonnable — c'est le prix à payer pour une architecture 100% front-end sans
> serveur de confiance.

### Index composite requis

La liste des parties en attente utilise une requête `where('status','==','waiting')` combinée à
`orderBy('createdAt','desc')`. Firestore te demandera de créer un **index composite** la première
fois que tu lances l'app : un lien apparaîtra directement dans la console du navigateur (erreur
`FirebaseError: The query requires an index...`) — clique dessus, Firebase pré-remplit tout, il
suffit de valider.

---

## 4. Lancer le projet en local

Comme le JS utilise des modules ES (`import`), il faut servir les fichiers via HTTP (pas de
`file://`). Le plus simple :

```bash
cd battleship-pwa
python3 -m http.server 8080
# puis ouvre http://localhost:8080
```

Ouvre deux onglets (ou un onglet + navigation privée) pour simuler deux joueurs.

---

## 5. Déployer sur GitHub Pages

1. Crée un dépôt GitHub (ex. `bataille-navale`) et pousse tout le contenu du dossier
   `battleship-pwa/` à la racine du dépôt.
2. Renseigne bien `js/firebase-config.js` avec tes vraies clés **avant** de pousser (ces clés
   Firebase "Web" ne sont pas secrètes en soi — c'est la Configuration API publique — la vraie
   protection vient des règles Firestore de la section 3).
3. Dans le dépôt GitHub : **Settings > Pages** → Source : **Deploy from a branch** → Branch :
   `main` / dossier `/ (root)` → **Save**.
4. Au bout de 1-2 minutes, ton jeu est en ligne sur
   `https://<ton-user>.github.io/bataille-navale/`.
5. Ajoute cette URL dans **Firebase Console > Authentication > Settings > Authorized domains**
   pour autoriser l'authentification anonyme depuis GitHub Pages.

---

## 6. Installer en PWA sur Android

Une fois le site en ligne (HTTPS obligatoire — GitHub Pages le fournit automatiquement) :

1. Ouvre l'URL dans Chrome sur Android.
2. Menu **⋮ > Ajouter à l'écran d'accueil** (ou une bannière d'installation apparaît automatiquement).
3. L'app s'installe avec l'icône radar fournie dans `icons/`, s'ouvre en plein écran (`display: standalone`)
   et le `service-worker.js` met en cache la coquille de l'app pour un démarrage rapide même avec
   une connexion faible (le contenu de partie, lui, nécessite toujours une connexion à Firestore).

Pour la remplacer par tes propres icônes, régénère simplement
`icons/icon-192.png` et `icons/icon-512.png` (mêmes dimensions, fond opaque recommandé).

---

## 7. Aller plus loin

- **Rejouer / rematch** : ajouter un bouton qui crée une nouvelle partie et redirige les deux
  joueurs — nécessite un petit signal supplémentaire dans `games/{id}` (ex. `rematchOf`).
  Nettoyage des vieilles parties : une Cloud Function planifiée (optionnelle, hors périmètre "100% front-end") ou un TTL Firestore sur `createdAt` peuvent purger les parties abandonnées.
- **Règle "rejouer après un tir réussi"** : dans `resolveIncomingShot()` (`js/app.js`), il suffit de
  ne pas changer `turn` quand `result !== 'miss'`.
- **Coup interdit hors tour** : déjà bloqué côté UI (case non cliquable) — pour un vrai blindage,
  ajouter une règle Firestore vérifiant `resource.data.turn` avant d'autoriser l'écriture de
  `pendingShot`.
