// ============================================================
// BATTLESHIP — application logic (pure front-end)
// Firebase Firestore = database + real-time "server".
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

// ---------- Game constants ----------
const SIZE = 10;
const COLS = ['A','B','C','D','E','F','G','H','I','J'];
const FLEET = [
  { id: 1, name: 'Carrier',    size: 5 },
  { id: 2, name: 'Battleship', size: 4 },
  { id: 3, name: 'Cruiser',    size: 3 },
  { id: 4, name: 'Submarine',  size: 3 },
  { id: 5, name: 'Destroyer',  size: 2 },
];

// ---------- Local state ----------
let uid = null;
let playerName = localStorage.getItem('bn_name') || '';
let currentGameId = null;
let currentGameData = null;   // latest snapshot of games/{id}
let myRole = null;            // 'host' | 'guest'
let unsubGame = null, unsubMyShots = null, unsubOppShots = null, unsubList = null;

// placement state
let placementOrientation = 'H'; // H | V
let selectedShipId = null;
let placedShips = {};   // shipId -> {cells:[[r,c]...]}
let placementGrid = emptyGrid();

// tracking boards for battle
let myShotsGrid = emptyGrid();     // my shots against the opponent (0/miss/hit/sunk)
let incomingGrid = emptyGrid();    // shots received on my fleet (0/miss/hit/sunk)
let myFleetState = null;           // ships + hits (copy of my private doc)

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

// ---------- Firestore-safe conversion ----------
// Firestore does not support nested arrays (array of arrays).
// So 10x10 grids are stored as a flat array (100 items), and ship
// cell coordinates as {r,c} objects instead of [r,c] pairs.
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
function cellsFromObj(cells) {
  return cells.map(({ r, c }) => [r, c]);
}

// ---------- DOM utilities ----------
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
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// ============================================================
// AUTHENTICATION (anonymous) — each browser/device gets a stable uid
// ============================================================
onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    boot();
  }
});
signInAnonymously(auth).catch(err => {
  console.error(err);
  toast("Couldn't connect to Firebase — check js/firebase-config.js", true);
});

function boot() {
  if (playerName) {
    renderPilotBadge();
    showScreen('screen-menu');
    listenGameList();
    listenMyGames();
  } else {
    showScreen('screen-name');
  }
}

// ============================================================
// SCREEN: CALL SIGN
// ============================================================
$('#formName').addEventListener('submit', (e) => {
  e.preventDefault();
  const val = $('#inputName').value.trim();
  if (!val) return;
  playerName = val.slice(0, 18);
  localStorage.setItem('bn_name', playerName);
  renderPilotBadge();
  showScreen('screen-menu');
  listenGameList();
  listenMyGames();
});

// ============================================================
// TOPBAR: click-to-rename pilot badge
// ============================================================
function renderPilotBadge() {
  const badge = $('#pilotBadge');
  badge.innerHTML = `
    <span class="pilot-label">CAPTAIN</span>
    <button type="button" id="pilotNameBtn" class="pilot-name-btn">${escapeHtml(playerName)} <span class="edit-hint">✎</span></button>
  `;
  $('#pilotNameBtn').addEventListener('click', startRename);
}

function startRename() {
  const badge = $('#pilotBadge');
  badge.innerHTML = `
    <span class="pilot-label">CAPTAIN</span>
    <input type="text" id="renameInput" maxlength="18" value="${escapeHtml(playerName)}" autocomplete="off">
  `;
  const input = $('#renameInput');
  input.focus();
  input.select();
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (val && val !== playerName) {
      await applyRename(val.slice(0, 18));
    }
    renderPilotBadge();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') { done = true; renderPilotBadge(); }
  });
  input.addEventListener('blur', finish);
}

async function applyRename(newName) {
  playerName = newName;
  localStorage.setItem('bn_name', playerName);
  toast('Name updated');
  // Propagate the new name to any of my active games so the opponent sees it.
  const updates = [];
  myGamesMap.forEach(g => {
    if (g.status === 'finished') return;
    if (g.hostUid === uid) updates.push(updateDoc(doc(db, 'games', g.id), { hostName: playerName }).catch(() => {}));
    if (g.guestUid === uid) updates.push(updateDoc(doc(db, 'games', g.id), { guestName: playerName }).catch(() => {}));
  });
  await Promise.all(updates);
}

// ============================================================
// SCREEN: MENU — "My games" (resume/delete) + open games list
// ============================================================
let unsubMyGamesHost = null, unsubMyGamesGuest = null;
let myGamesMap = new Map();       // gameId -> data (merged from both queries below)
let myGamesTurnState = new Map(); // gameId -> was it my turn last time we checked?

function computeIsMyTurn(g) {
  if (g.status !== 'playing') return false;
  const role = g.hostUid === uid ? 'host' : 'guest';
  return g.turn === role;
}

function listenMyGames() {
  if (unsubMyGamesHost) unsubMyGamesHost();
  if (unsubMyGamesGuest) unsubMyGamesGuest();
  myGamesMap = new Map();
  myGamesTurnState = new Map();

  const makeHandler = (isFirstRef) => (snap) => {
    snap.docChanges().forEach(change => {
      const id = change.doc.id;
      if (change.type === 'removed') {
        myGamesMap.delete(id);
        myGamesTurnState.delete(id);
        return;
      }
      const data = { id, ...change.doc.data() };
      myGamesMap.set(id, data);

      // Resolve incoming shots in the background, even for games I'm not
      // currently looking at — otherwise the defender would only see the
      // result (and the turn would only flip) once they reopen that game.
      if (data.status === 'playing' && data.pendingShot && data.pendingShot.by !== uid) {
        const role = data.hostUid === uid ? 'host' : 'guest';
        resolveIncomingShot(id, role, data).catch(err => console.error('resolveIncomingShot (background):', err));
      }

      const nowMyTurn = computeIsMyTurn(data);
      const wasMyTurn = myGamesTurnState.get(id);
      if (!isFirstRef.value && wasMyTurn === false && nowMyTurn === true) {
        notifyMyTurn(data);
      }
      myGamesTurnState.set(id, nowMyTurn);
    });
    isFirstRef.value = false;
    renderMyGames();
  };

  unsubMyGamesHost = onSnapshot(query(collection(db, 'games'), where('hostUid', '==', uid)), makeHandler({ value: true }), (err) => console.error(err));
  unsubMyGamesGuest = onSnapshot(query(collection(db, 'games'), where('guestUid', '==', uid)), makeHandler({ value: true }), (err) => console.error(err));
}

// Buzz + toast the moment it becomes your turn in ANY of your games —
// even if you're not currently looking at that game's screen.
// This is what lets you run several games at once without missing a turn.
function notifyMyTurn(g) {
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  const opp = g.hostUid === uid ? g.guestName : g.hostName;
  toast(`Your turn against ${escapeHtml(opp ?? 'opponent')}!`);
}

const STATUS_LABEL = { waiting: 'Waiting', placing: 'Placing fleet', playing: 'In progress', finished: 'Finished' };

function renderMyGames() {
  const list = $('#myGamesList');
  const rows = Array.from(myGamesMap.values()).sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
  if (!rows.length) {
    list.innerHTML = '<p class="empty-hint">No games created or joined yet.</p>';
    return;
  }
  list.innerHTML = '';
  rows.forEach(g => {
    const isHost = g.hostUid === uid;
    const role = isHost ? 'Host' : 'Guest';
    const opponent = isHost ? (g.guestName ?? 'waiting…') : g.hostName;

    let badgeClass = g.status;
    let badgeLabel = STATUS_LABEL[g.status] ?? g.status;
    if (g.status === 'playing') {
      const myTurn = computeIsMyTurn(g);
      badgeClass = myTurn ? 'your-turn' : 'opp-turn';
      badgeLabel = myTurn ? 'Your turn' : "Opponent's turn";
    }

    const row = document.createElement('div');
    row.className = 'game-row';
    row.innerHTML = `
      <div class="game-row-info">
        <span class="status-badge ${badgeClass}">${badgeLabel}</span>
        <span class="game-row-host">${role} · vs ${escapeHtml(opponent)}</span>
        <span class="game-row-meta">Sector ${g.id.slice(0,6).toUpperCase()}</span>
      </div>
      <div class="row-actions"></div>
    `;
    const actions = row.querySelector('.row-actions');
    if (g.status !== 'finished') {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'btn btn-primary';
      resumeBtn.textContent = 'Resume';
      resumeBtn.addEventListener('click', () => resumeGame(g));
      actions.appendChild(resumeBtn);
    }
    const deleteSlot = document.createElement('div');
    deleteSlot.className = 'row-actions'; // same style, independent container
    actions.appendChild(deleteSlot);
    renderDeleteControls(deleteSlot, g);
    list.appendChild(row);
  });
}

async function resumeGame(g) {
  currentGameId = g.id;
  myRole = g.hostUid === uid ? 'host' : 'guest';
  if (g.status === 'playing' || g.status === 'finished') {
    await enterGame(g);
  } else {
    await enterPlacement();
  }
}

function renderDeleteControls(container, g) {
  container.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost';
  btn.textContent = 'Delete';
  btn.addEventListener('click', () => {
    container.innerHTML = `
      <div class="confirm-row">
        <span class="confirm-text">Delete permanently?</span>
        <button class="btn btn-ghost" data-act="cancel">Cancel</button>
        <button class="btn btn-danger" data-act="confirm">Yes, delete</button>
      </div>
    `;
    container.querySelector('[data-act="cancel"]').addEventListener('click', () => renderDeleteControls(container, g));
    container.querySelector('[data-act="confirm"]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Deleting…';
      await deleteGame(g);
    });
  });
  container.appendChild(btn);
}

async function deleteGame(g) {
  try {
    // Best-effort cleanup of subcollections (may partially fail under
    // security rules if the other player never wrote anything).
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
    toast('Game deleted');

    // If I was currently playing that game, return to the menu.
    if (currentGameId === g.id) {
      returnToMenu();
    }
  } catch (err) {
    console.error(err);
    toast("Couldn't delete this game", true);
  }
}

// ============================================================
// SCREEN: MENU — open games list + create game
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
      list.innerHTML = '<p class="empty-hint">No open games. Create one!</p>';
      return;
    }
    list.innerHTML = '';
    snap.forEach(docSnap => {
      const g = docSnap.data();
      if (g.hostUid === uid) return; // don't list my own game here
      const row = document.createElement('div');
      row.className = 'game-row';
      row.innerHTML = `
        <div class="game-row-info">
          <span class="game-row-host">${escapeHtml(g.hostName)}</span>
          <span class="game-row-meta">Sector ${docSnap.id.slice(0,6).toUpperCase()}</span>
        </div>
        <button class="btn btn-primary">Join</button>
      `;
      row.querySelector('button').addEventListener('click', () => joinGame(docSnap.id));
      list.appendChild(row);
    });
    if (!list.children.length) {
      list.innerHTML = '<p class="empty-hint">No open games. Create one!</p>';
    }
  }, (err) => {
    console.error(err);
    toast("Firestore read error — check your security rules", true);
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
  await enterPlacement();
});

async function joinGame(gameId) {
  const ref = doc(db, 'games', gameId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().status !== 'waiting') {
    toast('This game is no longer available', true);
    return;
  }
  await updateDoc(ref, {
    guestUid: uid,
    guestName: playerName,
    status: 'placing',
  });
  currentGameId = gameId;
  myRole = 'guest';
  await enterPlacement();
}

// ============================================================
// SCREEN: FLEET PLACEMENT
// ============================================================
$('#btnMenuFromPlacement').addEventListener('click', returnToMenu);
$('#btnMenuFromGame').addEventListener('click', returnToMenu);

async function enterPlacement() {
  if (unsubList) unsubList();
  $('#placementGameCode').textContent = currentGameId.slice(0,6).toUpperCase();
  $('#placementStatus').dataset.waiting = '';
  showScreen('screen-placement');

  // Resume: if I already saved my fleet for this game (e.g. I'm coming
  // back after leaving), reload it instead of starting from a blank board.
  const myPrivSnap = await getDoc(doc(db, 'games', currentGameId, 'private', uid));
  const already = myPrivSnap.exists() && myPrivSnap.data().ready;

  if (already) {
    const data = myPrivSnap.data();
    placementGrid = flatToGrid(data.grid);
    placedShips = {};
    data.ships.forEach(s => { placedShips[s.id] = { cells: cellsFromObj(s.cells) }; });
    selectedShipId = null;
    myFleetState = { ships: data.ships, grid: placementGrid };
    renderFleetList();
    renderPlacementBoard();
    $('#btnReady').disabled = true;
    $('#placementStatus').textContent = 'Fleet already saved. Waiting for opponent…';
    $('#placementStatus').dataset.waiting = '1';
  } else {
    placementGrid = emptyGrid();
    placedShips = {};
    selectedShipId = FLEET[0].id;
    placementOrientation = 'H';
    renderFleetList();
    renderPlacementBoard();
    $('#btnReady').disabled = true;
    $('#placementStatus').textContent = '';
  }

  if (myRole === 'host') {
    // host waits for an opponent to join to move from 'waiting' to 'placing'
    unsubGame = onSnapshot(doc(db, 'games', currentGameId), (snap) => {
      if (!snap.exists()) { toast('This game was deleted', true); returnToMenu(); return; }
      const g = snap.data();
      currentGameData = g;
      if (g.status === 'placing' && $('#placementStatus').dataset.waiting !== '1') {
        toast(`${g.guestName} joined the sector!`);
      }
      handlePostPlacementTransition(g);
    });
  } else {
    unsubGame = onSnapshot(doc(db, 'games', currentGameId), (snap) => {
      if (!snap.exists()) { toast('This game was deleted', true); returnToMenu(); return; }
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
  toast(`Orientation: ${placementOrientation === 'H' ? 'Horizontal' : 'Vertical'}`);
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
    toast("Can't place a ship here", true);
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
  $('#placementStatus').textContent = 'Fleet saved. Waiting for opponent…';
  $('#placementStatus').dataset.waiting = '1';
  myFleetState = { ships, grid: placementGrid };

  // Signal readiness via a PUBLIC field (both players can read/write it) —
  // we can't read the opponent's "ready" flag from their private board,
  // which stays protected by security rules.
  await updateDoc(doc(db, 'games', currentGameId), {
    [`${myRole}Ready`]: true,
  });
});

// The public games/{id} doc already has hostReady/guestReady.
// Once both are true, start the game. Either client triggering this is
// safe — both would write the same values.
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
// SCREEN: GAME (real-time)
// ============================================================
async function enterGame(g) {
  if (unsubGame) unsubGame();
  currentGameData = g;

  const oppUid = myRole === 'host' ? g.guestUid : g.hostUid;
  const oppName = myRole === 'host' ? g.guestName : g.hostName;
  $('#gameCode').textContent = currentGameId.slice(0,6).toUpperCase();
  $('#opponentName').textContent = oppName;

  // reload my private fleet state if needed (e.g. reconnecting)
  const mySnap = await getDoc(doc(db, 'games', currentGameId, 'private', uid));
  const myData = mySnap.data();
  myFleetState = { ...myData, grid: flatToGrid(myData.grid) };

  showScreen('screen-game');
  renderAttackBoard();
  renderDefenseBoard();
  updateHud(g);

  unsubGame = onSnapshot(doc(db, 'games', currentGameId), async (snap) => {
    if (!snap.exists()) { toast('This game was deleted', true); returnToMenu(); return; }
    const data = snap.data();
    currentGameData = data;
    updateHud(data);

    if (data.status === 'finished') {
      showResult(data);
      return;
    }

    // If a shot is pending AND it targets me (I'm the defender), resolve it.
    if (data.pendingShot && data.pendingShot.by !== uid) {
      await resolveIncomingShot(currentGameId, myRole, data);
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
  $('#turnValue').textContent = isMyTurn ? 'Your shot' : 'Opponent';
  $('#gameStatus').textContent = isMyTurn
    ? 'Select a cell on the enemy grid to open fire.'
    : "Waiting for the opponent's shot…";
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

// ---------- Fire a shot (I'm the attacker) ----------
async function fireShot(r, c) {
  const gameRef = doc(db, 'games', currentGameId);
  const fresh = await getDoc(gameRef);
  const g = fresh.data();
  if (g.pendingShot) { toast('A shot is already being resolved', true); return; }
  const isMyTurn = (myRole === 'host' && g.turn === 'host') || (myRole === 'guest' && g.turn === 'guest');
  if (!isMyTurn) return;

  await updateDoc(gameRef, {
    pendingShot: { by: uid, row: r, col: c },
  });
}

// ---------- Resolve an incoming shot (I'm the defender) ----------
// Parameterized by gameId/role so it can also run in the background for
// games I'm not currently looking at (see listenMyGames below) — otherwise
// a shot would only get resolved once the defender reopens that game.
const resolvingGames = new Set();

async function resolveIncomingShot(gameId, myRoleForGame, g) {
  if (resolvingGames.has(gameId)) return; // avoid resolving twice at once
  resolvingGames.add(gameId);
  try {
    const { by, row, col } = g.pendingShot;
    const attackerUid = by;
    const attackerRole = myRoleForGame === 'host' ? 'guest' : 'host';

    const myBoardRef = doc(db, 'games', gameId, 'private', uid);
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

    const attackerShotsRef = doc(db, 'games', gameId, 'shots', attackerUid);
    const attackerShotsSnap = await getDoc(attackerShotsRef);
    const attackerFlat = attackerShotsSnap.data()?.grid;
    const attackerGrid = attackerFlat ? flatToGrid(attackerFlat) : emptyGrid();

    if (result === 'sunk') {
      // reveal the whole sunk ship on the attacker's grid
      const ship = updatedShips.find(s => s.id === shipId);
      ship.cells.forEach(({ r: rr, c: cc }) => { attackerGrid[rr][cc] = 'sunk'; });
    } else {
      attackerGrid[row][col] = result;
    }

    const batch = writeBatch(db);
    batch.update(myBoardRef, { ships: updatedShips });
    batch.set(attackerShotsRef, { grid: gridToFlat(attackerGrid) }, { merge: true });

    const gameRef = doc(db, 'games', gameId);
    if (allSunk) {
      batch.update(gameRef, {
        pendingShot: null,
        status: 'finished',
        winner: attackerRole,
      });
    } else {
      batch.update(gameRef, {
        pendingShot: null,
        turn: myRoleForGame, // it's now the defender's (my) turn to shoot
      });
    }
    await batch.commit();
  } finally {
    resolvingGames.delete(gameId);
  }
}

// ============================================================
// GAME OVER
// ============================================================
function showResult(g) {
  if (unsubGame) unsubGame();
  if (unsubMyShots) unsubMyShots();
  if (unsubOppShots) unsubOppShots();
  const won = g.winner === myRole;
  $('#resultEyebrow').textContent = won ? 'Victory' : 'Defeat';
  $('#resultTitle').textContent = won ? 'Enemy fleet destroyed' : 'Your fleet was sunk';
  $('#resultSub').textContent = won
    ? 'Well played, captain. The sector is secured.'
    : 'The opponent has taken control of the sector.';
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
// PWA — service worker registration
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  });
}