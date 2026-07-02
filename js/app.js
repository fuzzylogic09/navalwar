// ============================================================
// BATAILLE NAVALE — logique de l'application (front-end pur)
// Firebase Firestore = base de données + "serveur" temps réel.
// ============================================================

import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, updateDoc, getDoc, deleteDoc,
  onSnapshot, query, where, orderBy, serverTimestamp,
  writeBatch, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- Constantes de jeu ----------
const SIZE = 10;
const COLS = ['A','B','C','D','E','F','G','H','I','J'];
const FLEET = [
  { id: 1, name: 'Porte-avions', size: 5 },
  { id: 2, name: 'Cuirassé',     size: 4 },
  { id: 3, name: 'Croiseur',     size: 3 },
  { id: 4, name: 'Sous-marin',   size: 3 },
  { id: 5, name: 'Torpilleur',   size: 2 },
];

// ---------- État local ----------
let uid = null;
let playerName = localStorage.getItem('bn_name') || '';
let currentGameId = null;
let currentGameData = null;   // dernier snapshot du doc games/{id}
let myRole = null;            // 'host' | 'guest'
let unsubGame = null, unsubMyShots = null, unsubOppShots = null, unsubList = null;

// placement state
let placementOrientation = 'H'; // H | V
let selectedShipId = null;
let placedShips = {};   // shipId -> {cells:[[r,c]...]}
let placementGrid = emptyGrid();

// tracking boards for battle
let myShotsGrid = emptyGrid();     // ce que j'ai tiré chez l'adversaire (0/miss/hit/sunk)
let incomingGrid = emptyGrid();    // tirs reçus sur ma flotte (0/miss/hit/sunk)
let myFleetState = null;           // ships + hits (copie de mon doc privé)

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

// ---------- Conversion pour Firestore ----------
// Firestore n'accepte pas les tableaux imbriqués (array of arrays).
// On stocke donc les grilles 10x10 sous forme de tableau à plat (100 éléments),
// et les coordonnées de cases sous forme d'objets {r,c} plutôt que [r,c].
function gridToFlat(grid) {
  return grid.flat();
}
function flatToGrid(flat) {
  const g = [];
  for (let r = 0; r < SIZE; r++) {
    g.push(flat.slice(r * SIZE, r * SIZE + SIZE));
  }
  return g;
}
function cellsToObj(cells) {
  return cells.map(([r, c]) => ({ r, c }));
}

// ---------- Utilitaires DOM ----------
const $ = (sel) => document.querySelector(sel);
const screens = document.querySelectorAll('[data-screen]');
function showScreen(id) {
  screens.forEach(s => s.hidden = (s.id !== id));
}
function toast(msg, alert = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (alert ? ' alert' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ============================================================
// AUTHENTIFICATION (anonyme) — chaque appareil = un uid unique
// ============================================================
onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    boot();
  }
});
signInAnonymously(auth).catch(err => {
  console.error(err);
  toast("Impossible de se connecter à Firebase — vérifiez js/firebase-config.js", true);
});

function boot() {
  if (playerName) {
    $('#pilotName').textContent = playerName;
    showScreen('screen-menu');
    listenGameList();
    listenMyGames();
  } else {
    showScreen('screen-name');
  }
}

// ============================================================
// ÉCRAN : PSEUDO
// ============================================================
$('#formName').addEventListener('submit', (e) => {
  e.preventDefault();
  const val = $('#inputName').value.trim();
  if (!val) return;
  playerName = val.slice(0, 18);
  localStorage.setItem('bn_name', playerName);
  $('#pilotName').textContent = playerName;
  showScreen('screen-menu');
  listenGameList();
  listenMyGames();
});

// ============================================================
// ÉCRAN : MENU — "Vos parties" (avec suppression) + liste des parties
// ============================================================
let unsubMyGamesHost = null, unsubMyGamesGuest = null;
let myGamesMap = new Map(); // gameId -> data (fusion des deux requêtes ci-dessous)

function listenMyGames() {
  if (unsubMyGamesHost) unsubMyGamesHost();
  if (unsubMyGamesGuest) unsubMyGamesGuest();
  myGamesMap = new Map();

  const applySnap = (snap) => {
    snap.docChanges().forEach(change => {
      if (change.type === 'removed') {
        myGamesMap.delete(change.doc.id);
      } else {
        myGamesMap.set(change.doc.id, { id: change.doc.id, ...change.doc.data() });
      }
    });
    renderMyGames();
  };

  unsubMyGamesHost = onSnapshot(query(collection(db, 'games'), where('hostUid', '==', uid)), applySnap, (err) => console.error(err));
  unsubMyGamesGuest = onSnapshot(query(collection(db, 'games'), where('guestUid', '==', uid)), applySnap, (err) => console.error(err));
}

const STATUS_LABEL = { waiting: 'En attente', placing: 'Placement', playing: 'En cours', finished: 'Terminée' };

function renderMyGames() {
  const list = $('#myGamesList');
  const rows = Array.from(myGamesMap.values()).sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
  if (!rows.length) {
    list.innerHTML = '<p class="empty-hint">Aucune partie créée ou rejointe pour l\'instant.</p>';
    return;
  }
  list.innerHTML = '';
  rows.forEach(g => {
    const isHost = g.hostUid === uid;
    const role = isHost ? 'Hôte' : 'Invité';
    const opponent = isHost ? (g.guestName ?? 'en attente…') : g.hostName;
    const row = document.createElement('div');
    row.className = 'game-row';
    row.innerHTML = `
      <div class="game-row-info">
        <span class="status-badge ${g.status}">${STATUS_LABEL[g.status] ?? g.status}</span>
        <span class="game-row-host">${role} · vs ${escapeHtml(opponent)}</span>
        <span class="game-row-meta">Secteur ${g.id.slice(0,6).toUpperCase()}</span>
      </div>
      <div class="row-actions"></div>
    `;
    const actions = row.querySelector('.row-actions');
    renderDeleteControls(actions, g);
    list.appendChild(row);
  });
}

function renderDeleteControls(container, g) {
  container.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost';
  btn.textContent = 'Supprimer';
  btn.addEventListener('click', () => {
    container.innerHTML = `
      <div class="confirm-row">
        <span class="confirm-text">Supprimer définitivement ?</span>
        <button class="btn btn-ghost" data-act="cancel">Annuler</button>
        <button class="btn btn-danger" data-act="confirm">Oui, supprimer</button>
      </div>
    `;
    container.querySelector('[data-act="cancel"]').addEventListener('click', () => renderDeleteControls(container, g));
    container.querySelector('[data-act="confirm"]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Suppression…';
      await deleteGame(g);
    });
  });
  container.appendChild(btn);
}

async function deleteGame(g) {
  try {
    // Nettoyage best-effort des sous-collections (peut échouer partiellement
    // selon les règles de sécurité si l'autre joueur n'a jamais rien écrit).
    const cleanups = [];
    if (g.hostUid) {
      cleanups.push(deleteDoc(doc(db, 'games', g.id, 'private', g.hostUid)).catch(() => {}));
      cleanups.push(deleteDoc(doc(db, 'games', g.id, 'shots', g.hostUid)).catch(() => {}));
    }
    if (g.guestUid) {
      cleanups.push(deleteDoc(doc(db, 'games', g.id, 'private', g.guestUid)).catch(() => {}));
      cleanups.push(deleteDoc(doc(db, 'games', g.id, 'shots', g.guestUid)).catch(() => {}));
    }
    await Promise.all(cleanups);
    await deleteDoc(doc(db, 'games', g.id));
    toast('Partie supprimée');

    // Si je suis en train de jouer cette partie-là, retour au menu.
    if (currentGameId === g.id) {
      returnToMenu();
    }
  } catch (err) {
    console.error(err);
    toast("Impossible de supprimer cette partie", true);
  }
}

// ============================================================
// ÉCRAN : MENU — liste des parties + création
// ============================================================
function listenGameList() {
  if (unsubList) unsubList();
  const q = query(
    collection(db, 'games'),
    where('status', '==', 'waiting'),
    orderBy('createdAt', 'desc')
  );
  unsubList = onSnapshot(q, (snap) => {
    const list = $('#gameList');
    if (snap.empty) {
      list.innerHTML = '<p class="empty-hint">Aucune partie en attente. Créez-en une !</p>';
      return;
    }
    list.innerHTML = '';
    snap.forEach(docSnap => {
      const g = docSnap.data();
      if (g.hostUid === uid) return; // ne pas afficher sa propre partie dans la liste
      const row = document.createElement('div');
      row.className = 'game-row';
      row.innerHTML = `
        <div class="game-row-info">
          <span class="game-row-host">${escapeHtml(g.hostName)}</span>
          <span class="game-row-meta">Secteur ${docSnap.id.slice(0,6).toUpperCase()}</span>
        </div>
        <button class="btn btn-primary">Rejoindre</button>
      `;
      row.querySelector('button').addEventListener('click', () => joinGame(docSnap.id));
      list.appendChild(row);
    });
    if (!list.children.length) {
      list.innerHTML = '<p class="empty-hint">Aucune partie en attente. Créez-en une !</p>';
    }
  }, (err) => {
    console.error(err);
    toast("Erreur de lecture Firestore — vérifiez les règles de sécurité", true);
  });
}

$('#btnCreateGame').addEventListener('click', async () => {
  const ref = doc(collection(db, 'games'));
  await setDoc(ref, {
    hostUid: uid,
    hostName: playerName,
    guestUid: null,
    guestName: null,
    status: 'waiting',       // waiting -> placing -> playing -> finished
    turn: null,              // 'host' | 'guest'
    pendingShot: null,
    winner: null,
    hostReady: false,
    guestReady: false,
    createdAt: serverTimestamp(),
  });
  currentGameId = ref.id;
  myRole = 'host';
  enterPlacement();
});

async function joinGame(gameId) {
  const ref = doc(db, 'games', gameId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().status !== 'waiting') {
    toast("Cette partie n'est plus disponible", true);
    return;
  }
  await updateDoc(ref, {
    guestUid: uid,
    guestName: playerName,
    status: 'placing',
  });
  currentGameId = gameId;
  myRole = 'guest';
  enterPlacement();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// ============================================================
// ÉCRAN : PLACEMENT DE LA FLOTTE
// ============================================================
function enterPlacement() {
  if (unsubList) unsubList();
  placementGrid = emptyGrid();
  placedShips = {};
  selectedShipId = FLEET[0].id;
  placementOrientation = 'H';
  $('#placementGameCode').textContent = currentGameId.slice(0,6).toUpperCase();
  renderFleetList();
  renderPlacementBoard();
  $('#btnReady').disabled = true;
  $('#placementStatus').textContent = '';
  showScreen('screen-placement');

  if (myRole === 'host') {
    // host attend qu'un adversaire rejoigne pour passer en 'placing' (déjà 'waiting')
    unsubGame = onSnapshot(doc(db, 'games', currentGameId), (snap) => {
      if (!snap.exists()) { toast('Cette partie a été supprimée', true); returnToMenu(); return; }
      const g = snap.data();
      currentGameData = g;
      if (g.status === 'placing' && $('#placementStatus').dataset.waiting !== '1') {
        toast(`${g.guestName} a rejoint le secteur !`);
      }
      handlePostPlacementTransition(g);
    });
  } else {
    unsubGame = onSnapshot(doc(db, 'games', currentGameId), (snap) => {
      if (!snap.exists()) { toast('Cette partie a été supprimée', true); returnToMenu(); return; }
      currentGameData = snap.data();
      handlePostPlacementTransition(currentGameData);
    });
  }
}

function renderFleetList() {
  const ul = $('#fleetList');
  ul.innerHTML = '';
  FLEET.forEach(ship => {
    const li = document.createElement('li');
    li.className = 'fleet-item' + (ship.id === selectedShipId ? ' selected' : '') + (placedShips[ship.id] ? ' placed' : '');
    li.innerHTML = `<span>${ship.name}</span><span class="dots">${'●'.repeat(ship.size)}</span>`;
    li.addEventListener('click', () => {
      if (placedShips[ship.id]) return;
      selectedShipId = ship.id;
      renderFleetList();
    });
    ul.appendChild(li);
  });
}

$('#btnRotate').addEventListener('click', () => {
  placementOrientation = placementOrientation === 'H' ? 'V' : 'H';
  toast(`Orientation : ${placementOrientation === 'H' ? 'Horizontale' : 'Verticale'}`);
});

$('#btnResetPlace').addEventListener('click', () => {
  placementGrid = emptyGrid();
  placedShips = {};
  selectedShipId = FLEET[0].id;
  renderFleetList();
  renderPlacementBoard();
  $('#btnReady').disabled = true;
});

$('#btnRandomPlace').addEventListener('click', () => {
  placementGrid = emptyGrid();
  placedShips = {};
  FLEET.forEach(ship => {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 300) {
      attempts++;
      const orient = Math.random() < 0.5 ? 'H' : 'V';
      const r = Math.floor(Math.random() * SIZE);
      const c = Math.floor(Math.random() * SIZE);
      const cells = shipCells(r, c, ship.size, orient);
      if (cells && canPlace(cells)) {
        commitShip(ship.id, cells);
        placed = true;
      }
    }
  });
  selectedShipId = null;
  renderFleetList();
  renderPlacementBoard();
  checkAllPlaced();
});

function shipCells(r, c, size, orient) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const rr = orient === 'V' ? r + i : r;
    const cc = orient === 'H' ? c + i : c;
    if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) return null;
    cells.push([rr, cc]);
  }
  return cells;
}

function canPlace(cells) {
  for (const [r, c] of cells) {
    if (placementGrid[r][c] !== 0) return false;
    // interdit aussi les cases directement adjacentes (règle de confort, pas obligatoire)
  }
  return true;
}

function commitShip(shipId, cells) {
  cells.forEach(([r, c]) => { placementGrid[r][c] = shipId; });
  placedShips[shipId] = { cells };
}

function renderPlacementBoard() {
  const board = $('#placementBoard');
  board.innerHTML = '';
  buildCoordHeader(board);
  for (let r = 0; r < SIZE; r++) {
    const rowLabel = document.createElement('div');
    rowLabel.className = 'cell coord';
    rowLabel.textContent = r + 1;
    board.appendChild(rowLabel);
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell clickable';
      if (placementGrid[r][c] !== 0) cell.classList.add('ship');
      cell.dataset.r = r; cell.dataset.c = c;
      cell.addEventListener('click', () => onPlacementCellClick(r, c));
      cell.addEventListener('mouseenter', () => previewShip(r, c));
      board.appendChild(cell);
    }
  }
}

function buildCoordHeader(board) {
  const corner = document.createElement('div');
  corner.className = 'cell coord';
  board.appendChild(corner);
  COLS.forEach(letter => {
    const h = document.createElement('div');
    h.className = 'cell coord';
    h.textContent = letter;
    board.appendChild(h);
  });
}

function previewShip(r, c) {
  if (!selectedShipId || placedShips[selectedShipId]) return;
  const ship = FLEET.find(s => s.id === selectedShipId);
  const cells = shipCells(r, c, ship.size, placementOrientation);
  document.querySelectorAll('#placementBoard .cell.clickable').forEach(el => {
    el.classList.remove('preview-ok', 'preview-bad');
  });
  if (!cells) return;
  const ok = canPlace(cells);
  cells.forEach(([rr, cc]) => {
    const el = document.querySelector(`#placementBoard .cell[data-r="${rr}"][data-c="${cc}"]`);
    if (el) el.classList.add(ok ? 'preview-ok' : 'preview-bad');
  });
}

function onPlacementCellClick(r, c) {
  if (!selectedShipId || placedShips[selectedShipId]) return;
  const ship = FLEET.find(s => s.id === selectedShipId);
  const cells = shipCells(r, c, ship.size, placementOrientation);
  if (!cells || !canPlace(cells)) {
    toast("Placement impossible ici", true);
    return;
  }
  commitShip(ship.id, cells);
  selectedShipId = FLEET.find(s => !placedShips[s.id])?.id ?? null;
  renderFleetList();
  renderPlacementBoard();
  checkAllPlaced();
}

function checkAllPlaced() {
  const allPlaced = FLEET.every(s => placedShips[s.id]);
  $('#btnReady').disabled = !allPlaced;
}

$('#btnReady').addEventListener('click', async () => {
  const ships = FLEET.map(s => ({
    id: s.id, name: s.name, size: s.size, hits: 0,
    cells: cellsToObj(placedShips[s.id].cells),
  }));
  await setDoc(doc(db, 'games', currentGameId, 'private', uid), {
    grid: gridToFlat(placementGrid),
    ships,
    ready: true,
  });
  await setDoc(doc(db, 'games', currentGameId, 'shots', uid), {
    grid: gridToFlat(emptyGrid()),
  }, { merge: true });

  $('#btnReady').disabled = true;
  $('#placementStatus').textContent = "Flotte enregistrée. En attente de l'adversaire…";
  $('#placementStatus').dataset.waiting = '1';
  myFleetState = { ships, grid: placementGrid };

  // On signale que je suis prêt via un champ PUBLIC (les deux joueurs peuvent
  // le lire/écrire) — impossible de lire le "ready" de l'adversaire depuis son
  // document privé, qui reste protégé par les règles de sécurité.
  await updateDoc(doc(db, 'games', currentGameId), {
    [`${myRole}Ready`]: true,
  });
});

// Le document public games/{id} contient déjà hostReady/guestReady.
// Dès que les deux sont vrais, on démarre la partie. Un seul des deux clients
// suffit à déclencher l'update (les deux peuvent le tenter sans risque, la
// valeur écrite est identique).
async function maybeStartGame(g) {
  if (!g.hostReady || !g.guestReady || g.status === 'playing' || g.status === 'finished') return;
  const gameRef = doc(db, 'games', currentGameId);
  await updateDoc(gameRef, { status: 'playing', turn: 'host' });
}

function handlePostPlacementTransition(g) {
  if (!g) return;
  maybeStartGame(g);
  if (g.status === 'playing') {
    enterGame(g);
  }
}

// ============================================================
// ÉCRAN : PARTIE (temps réel)
// ============================================================
async function enterGame(g) {
  if (unsubGame) unsubGame();
  currentGameData = g;

  const oppUid = myRole === 'host' ? g.guestUid : g.hostUid;
  const oppName = myRole === 'host' ? g.guestName : g.hostName;
  $('#gameCode').textContent = currentGameId.slice(0,6).toUpperCase();
  $('#opponentName').textContent = oppName;

  // recharger mon état de flotte privé si besoin (ex: reconnexion)
  const mySnap = await getDoc(doc(db, 'games', currentGameId, 'private', uid));
  const myData = mySnap.data();
  myFleetState = { ...myData, grid: flatToGrid(myData.grid) };

  showScreen('screen-game');
  renderAttackBoard();
  renderDefenseBoard();
  updateHud(g);

  unsubGame = onSnapshot(doc(db, 'games', currentGameId), async (snap) => {
    if (!snap.exists()) { toast('Cette partie a été supprimée', true); returnToMenu(); return; }
    const data = snap.data();
    currentGameData = data;
    updateHud(data);

    if (data.status === 'finished') {
      showResult(data);
      return;
    }

    // Si un tir est en attente ET qu'il me vise (je suis le défenseur), je le résous.
    if (data.pendingShot && data.pendingShot.by !== uid) {
      await resolveIncomingShot(data);
    }
    renderAttackBoard();
    renderDefenseBoard();
  });

  unsubMyShots = onSnapshot(doc(db, 'games', currentGameId, 'shots', uid), (snap) => {
    const flat = snap.data()?.grid;
    myShotsGrid = flat ? flatToGrid(flat) : emptyGrid();
    renderAttackBoard();
  });

  const oppShotsRef = doc(db, 'games', currentGameId, 'shots', oppUid);
  unsubOppShots = onSnapshot(oppShotsRef, (snap) => {
    const flat = snap.data()?.grid;
    incomingGrid = flat ? flatToGrid(flat) : emptyGrid();
    renderDefenseBoard();
  });
}

function updateHud(g) {
  const isMyTurn = (myRole === 'host' && g.turn === 'host') || (myRole === 'guest' && g.turn === 'guest');
  const el = $('#turnIndicator');
  el.classList.toggle('my-turn', isMyTurn);
  el.classList.toggle('opp-turn', !isMyTurn);
  $('#turnValue').textContent = isMyTurn ? 'À vous de tirer' : "Adversaire";
  $('#gameStatus').textContent = isMyTurn
    ? 'Sélectionnez une case sur la grille adverse pour ouvrir le feu.'
    : "En attente du tir de l'adversaire…";
}

function renderAttackBoard() {
  const board = $('#attackBoard');
  board.innerHTML = '';
  buildCoordHeader(board);
  const g = currentGameData;
  const isMyTurn = g && ((myRole === 'host' && g.turn === 'host') || (myRole === 'guest' && g.turn === 'guest'));
  const pending = g?.pendingShot;

  for (let r = 0; r < SIZE; r++) {
    const rowLabel = document.createElement('div');
    rowLabel.className = 'cell coord';
    rowLabel.textContent = r + 1;
    board.appendChild(rowLabel);
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      const val = myShotsGrid[r][c];
      cell.className = 'cell';
      if (val === 'miss') cell.classList.add('miss');
      else if (val === 'hit') cell.classList.add('hit');
      else if (val === 'sunk') cell.classList.add('sunk');
      else if (isMyTurn && g?.status === 'playing') cell.classList.add('clickable');

      if (pending && pending.by === uid && pending.row === r && pending.col === c) {
        cell.classList.add('pending');
      }

      if (isMyTurn && val === 0 && g?.status === 'playing' && !pending) {
        cell.addEventListener('click', () => fireShot(r, c));
      }
      board.appendChild(cell);
    }
  }
}

function renderDefenseBoard() {
  const board = $('#defenseBoard');
  board.innerHTML = '';
  buildCoordHeader(board);
  const myGrid = myFleetState?.grid ?? emptyGrid();
  for (let r = 0; r < SIZE; r++) {
    const rowLabel = document.createElement('div');
    rowLabel.className = 'cell coord';
    rowLabel.textContent = r + 1;
    board.appendChild(rowLabel);
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const shotVal = incomingGrid[r]?.[c];
      const hasShip = myGrid[r][c] !== 0;
      if (shotVal === 'hit') cell.classList.add('hit');
      else if (shotVal === 'sunk') cell.classList.add('sunk');
      else if (shotVal === 'miss') cell.classList.add('miss');
      else if (hasShip) cell.classList.add('ship');
      board.appendChild(cell);
    }
  }
}

// ---------- Tirer un coup (je suis l'attaquant) ----------
async function fireShot(r, c) {
  const gameRef = doc(db, 'games', currentGameId);
  const fresh = await getDoc(gameRef);
  const g = fresh.data();
  if (g.pendingShot) { toast('Un tir est déjà en cours de résolution', true); return; }
  const isMyTurn = (myRole === 'host' && g.turn === 'host') || (myRole === 'guest' && g.turn === 'guest');
  if (!isMyTurn) return;

  await updateDoc(gameRef, {
    pendingShot: { by: uid, row: r, col: c },
  });
}

// ---------- Résoudre un tir reçu (je suis le défenseur) ----------
async function resolveIncomingShot(g) {
  const { by, row, col } = g.pendingShot;
  const attackerUid = by;
  const attackerRole = myRole === 'host' ? 'guest' : 'host';

  // éviter double résolution (plusieurs événements peuvent arriver vite)
  if (resolveIncomingShot._busy) return;
  resolveIncomingShot._busy = true;
  try {
    const myBoardRef = doc(db, 'games', currentGameId, 'private', uid);
    const myBoardSnap = await getDoc(myBoardRef);
    const myBoard = myBoardSnap.data();
    const myGrid2D = flatToGrid(myBoard.grid);

    const shipId = myGrid2D[row][col];
    let result = 'miss';
    let updatedShips = myBoard.ships;

    if (shipId !== 0) {
      updatedShips = myBoard.ships.map(s => {
        if (s.id !== shipId) return s;
        const hits = s.hits + 1;
        return { ...s, hits };
      });
      const ship = updatedShips.find(s => s.id === shipId);
      result = ship.hits >= ship.size ? 'sunk' : 'hit';
    }

    const allSunk = updatedShips.every(s => s.hits >= s.size);

    const attackerShotsRef = doc(db, 'games', currentGameId, 'shots', attackerUid);
    const attackerShotsSnap = await getDoc(attackerShotsRef);
    const attackerFlat = attackerShotsSnap.data()?.grid;
    const attackerGrid = attackerFlat ? flatToGrid(attackerFlat) : emptyGrid();

    if (result === 'sunk') {
      // révèle tout le navire coulé sur la grille de l'attaquant
      const ship = updatedShips.find(s => s.id === shipId);
      ship.cells.forEach(({ r: rr, c: cc }) => { attackerGrid[rr][cc] = 'sunk'; });
    } else {
      attackerGrid[row][col] = result;
    }

    const batch = writeBatch(db);
    batch.update(myBoardRef, { ships: updatedShips });
    batch.set(attackerShotsRef, { grid: gridToFlat(attackerGrid) }, { merge: true });

    const gameRef = doc(db, 'games', currentGameId);
    if (allSunk) {
      batch.update(gameRef, {
        pendingShot: null,
        status: 'finished',
        winner: attackerRole,
      });
    } else {
      batch.update(gameRef, {
        pendingShot: null,
        turn: myRole, // c'est maintenant au défenseur (moi) de tirer
      });
    }
    await batch.commit();
  } finally {
    resolveIncomingShot._busy = false;
  }
}

// ============================================================
// FIN DE PARTIE
// ============================================================
function showResult(g) {
  if (unsubGame) unsubGame();
  if (unsubMyShots) unsubMyShots();
  if (unsubOppShots) unsubOppShots();
  const won = g.winner === myRole;
  $('#resultEyebrow').textContent = won ? 'Victoire' : 'Défaite';
  $('#resultTitle').textContent = won ? 'Flotte adverse anéantie' : 'Votre flotte a été coulée';
  $('#resultSub').textContent = won
    ? "Bien joué, amiral. Le secteur est sécurisé."
    : "L'adversaire a pris le contrôle du secteur.";
  showScreen('screen-result');
}

$('#btnBackToMenu').addEventListener('click', returnToMenu);

function returnToMenu() {
  if (unsubGame) unsubGame();
  if (unsubMyShots) unsubMyShots();
  if (unsubOppShots) unsubOppShots();
  currentGameId = null;
  currentGameData = null;
  myRole = null;
  showScreen('screen-menu');
  listenGameList();
  listenMyGames();
}

// ============================================================
// PWA — enregistrement du service worker
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker non enregistré :', err);
    });
  });
}