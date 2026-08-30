const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

const SHOP_ITEMS = [
  { id: 'potion', name: 'Potion', type: 'heal', value: 50, price: 50, weight: 15, desc: 'Rend 50 PV à un Pokémon.' },
  { id: 'super_potion', name: 'Super Potion', type: 'heal', value: 100, price: 80, weight: 10, desc: 'Rend 100 PV à un Pokémon.' },
  { id: 'rappel', name: 'Rappel', type: 'revive', value: 0.5, price: 200, weight: 2, desc: 'Réanime un Pokémon K.O. avec 50% de ses PV.' },
  { id: 'sitrus', name: 'Baie Sitrus', type: 'held', price: 100, weight: 12, desc: 'Restaure 30 PV si les PV tombent sous 50%.' },
  { id: 'bandeau', name: 'Bandeau Muscle', type: 'held', price: 120, weight: 12, desc: '+20% de dégâts sur les Attaques Physiques.' },
  { id: 'lunettes', name: 'Lunettes Choix', type: 'held', price: 120, weight: 12, desc: '+20% de dégâts sur les Attaques Spéciales.' },
  { id: 'restes', name: 'Restes', type: 'held', price: 150, weight: 8, desc: 'Régénère 10 PV à la fin de chaque tour.' },
  { id: 'veste', name: 'Veste de Combat', type: 'held', price: 140, weight: 7, desc: 'Déf. Spéciale +30%, mais Déf. Physique -10%.' },
  { id: 'casque', name: 'Casque Brut', type: 'held', price: 150, weight: 7, desc: 'Inflige 15 dégâts de recul sur une Attaque Physique.' },
  { id: 'fuite', name: 'Bouton Fuite', type: 'held', price: 150, weight: 5, desc: 'Rappelle ce Pokémon au milieu du tour.' },
  { id: 'orbe', name: 'Orbe Vie', type: 'held', price: 180, weight: 3, desc: '+30% de dégâts, mais perd 10% de ses PV Max par coup.' },
  { id: 'grelot', name: 'Grelot Coque', type: 'held', price: 170, weight: 3, desc: 'Soigne 20% des dégâts infligés (Vol de Vie).' },
  { id: 'ceinture', name: 'Ceinture Force', type: 'held', price: 180, weight: 2, desc: 'Survit avec 1 PV à une attaque mortelle (1 usage).' },
  { id: 'poudre', name: 'Poudre Claire', type: 'held', price: 160, weight: 1, desc: "15% de chances d'esquiver totalement une attaque." },
  { id: 'cartouche', name: 'Cartouche Rouge', type: 'held', price: 250, weight: 1, desc: "Force l'adversaire à changer de Pokémon actif." }
];

const colorTranslations = { black: 'Noir', blue: 'Bleu', brown: 'Brun / Marron', gray: 'Gris', green: 'Vert', pink: 'Rose', purple: 'Violet', red: 'Rouge', white: 'Blanc', yellow: 'Jaune' };
const ARENA_TYPES = ['stadium', 'forest', 'volcano', 'ocean'];

function generateRoomCode(gameType) {
  let prefix = gameType === 'guess' ? 'GUE-' : gameType === 'imposteur' ? 'IMP-' : 'PKM-';
  return prefix + Math.floor(1000 + Math.random() * 9000);
}

function normalizeString(str) {
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

async function getRandomPokemon() {
  const id = Math.floor(Math.random() * 1025) + 1;
  try {
    const pokeRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${id}`);
    
    const nameFr = speciesRes.data.names.find(n => n.language.name === 'fr')?.name || pokeRes.data.name;
    const colorRaw = speciesRes.data.color.name;
    const colorFr = colorTranslations[colorRaw] || colorRaw;
    
    const types = pokeRes.data.types.map(t => t.type.name).join(' / ');
    const stats = pokeRes.data.stats.map(s => s.base_stat);
    const bst = stats.reduce((a, b) => a + b, 0);
    
    let rarity = 'Commun';
    if (bst >= 600 || speciesRes.data.is_legendary || speciesRes.data.is_mythical) rarity = 'Légendaire';
    else if (bst >= 500) rarity = 'Épique';
    else if (bst >= 400) rarity = 'Rare';

    return {
      id, name: nameFr, color: colorFr, rarity, types,
      height: pokeRes.data.height, weight: pokeRes.data.weight,
      hp: stats[0], hpMax: stats[0], attack: stats[1], def: stats[2], spAtk: stats[3], spDef: stats[4], speed: stats[5],
      sprite: pokeRes.data.sprites.front_default || pokeRes.data.sprites.other['official-artwork'].front_default,
      spriteBack: pokeRes.data.sprites.back_default || pokeRes.data.sprites.front_default,
      item: null
    };
  } catch (err) { return null; }
}

function getShopItems() {
  const items = [];
  for (let i = 0; i < 5; i++) {
    const rand = Math.random() * 100;
    let sum = 0;
    for (let item of SHOP_ITEMS) {
      sum += item.weight;
      if (rand <= sum) { items.push(item); break; }
    }
  }
  return items;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createRoom', (userData) => {
    const gameType = userData.gameType || 'pokeauc';
    const roomCode = generateRoomCode(gameType);
    currentRoom = roomCode;
    socket.join(roomCode);
    
    rooms[roomCode] = { 
      code: roomCode, gameType: gameType, players: {}, host: socket.id, state: 'LOBBY', disconnectTimeout: null,
      votes: {}, chosenMode: 'shiny', currentAuction: null, auctionTimer: null, battleState: null, rematchVotes: new Set(), shopItems: [],
      // NOUVEAU : On intègre le mode de jeu (classic ou undercover)
      impSettings: { maxRounds: 1, wordsPerPlayer: 2, mode: 'classic' }, 
      impState: { round: 0, turnOrder: [], currentTurnIdx: 0, currentWordLap: 0, secretPoke: null, undercoverPoke: null, imposteurId: null, wordsLog: [], timer: null, timeLeft: 0, votes: {} }
    };
    
    rooms[roomCode].players[socket.id] = { id: socket.id, name: userData.name, avatar: userData.avatar, role: 'player', connected: true, ready: false, budget: 900, team: [], score: 0 };
    socket.emit('roomCreated', { roomCode, role: 'player' });
  });

  socket.on('joinRoom', ({ roomCode, name, avatar }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('errorMsg', 'Code de salon invalide.');

    const disconnectedPlayer = Object.values(room.players).find(p => p.name === name && !p.connected);
    if (disconnectedPlayer) {
      clearTimeout(room.disconnectTimeout);
      const oldId = disconnectedPlayer.id;
      room.players[socket.id] = disconnectedPlayer;
      room.players[socket.id].id = socket.id;
      room.players[socket.id].connected = true;
      delete room.players[oldId];
      currentRoom = roomCode;
      socket.join(roomCode);
      
      if (room.host === oldId) room.host = socket.id;
      if (room.currentAuction && room.currentAuction.highestBidder === oldId) room.currentAuction.highestBidder = socket.id;
      if (room.battleState) {
        if (room.battleState.p1.id === oldId) room.battleState.p1.id = socket.id;
        if (room.battleState.p2.id === oldId) room.battleState.p2.id = socket.id;
        if (room.battleState.attackerId === oldId) room.battleState.attackerId = socket.id;
        if (room.battleState.defenderId === oldId) room.battleState.defenderId = socket.id;
      }
      
      if (room.impState && room.impState.imposteurId === oldId) room.impState.imposteurId = socket.id;
      if (room.impState && room.impState.turnOrder) {
        const idx = room.impState.turnOrder.indexOf(oldId);
        if (idx !== -1) room.impState.turnOrder[idx] = socket.id;
      }
      
      io.to(roomCode).emit('playerReconnected', { name });
      socket.emit('roomJoined', { roomCode, role: room.players[socket.id].role, gameType: room.gameType });
      
      if (room.gameType === 'pokeauc') {
        if(room.state === 'SHOP') socket.emit('enterShop', { shopItems: room.shopItems, players: room.players });
        else if(room.state === 'BATTLE') sendBattleUpdateToSocket(socket.id, roomCode, "Combat repris !");
      } else if (room.gameType === 'imposteur') {
        io.to(roomCode).emit('lobbyUpdate', { players: room.players, host: room.host });
      }
      return;
    }

    currentRoom = roomCode;
    socket.join(roomCode);
    const activePlayers = Object.values(room.players).filter(p => p.role === 'player').length;
    const role = (room.gameType === 'pokeauc' && activePlayers >= 2) ? 'spectator' : 'player';
    
    room.players[socket.id] = { id: socket.id, name, avatar, role, connected: true, ready: false, budget: 900, team: [], score: 0 };
    socket.emit('roomJoined', { roomCode, role, gameType: room.gameType });
    
    if (room.gameType === 'pokeauc') {
      if (role === 'player' && activePlayers + 1 === 2 && room.state === 'LOBBY') {
        room.state = 'VOTING';
        io.to(roomCode).emit('startVotingPhase', { players: room.players });
      } else if (role === 'spectator') {
        if (room.state === 'VOTING') socket.emit('startVotingPhase', { players: room.players });
        else if (room.state === 'AUCTION') {
           socket.emit('newAuction', { hint: room.currentAuction?.hint, rarity: room.currentAuction?.pokemon?.rarity, players: room.players });
           if (room.currentAuction) socket.emit('bidUpdated', { highestBid: room.currentAuction.highestBid, highestBidderName: room.currentAuction.highestBidderName, timeLeft: room.currentAuction.timeLeft });
        }
        else if (room.state === 'SHOP') socket.emit('enterShop', { shopItems: room.shopItems, players: room.players });
        else if (room.state === 'BATTLE' || room.state === 'GAME_OVER') sendBattleUpdateToSocket(socket.id, roomCode, "Vous observez le combat.");
      }
    } else if (room.gameType === 'imposteur') {
      io.to(roomCode).emit('lobbyUpdate', { players: room.players, host: room.host });
    }
  });

  socket.on('leaveRoom', () => {
    if(currentRoom && rooms[currentRoom]) {
      if (rooms[currentRoom].players[socket.id] && rooms[currentRoom].players[socket.id].role === 'player') {
        io.to(currentRoom).emit('errorMsg', "Un joueur a quitté le salon.");
        delete rooms[currentRoom];
      }
      socket.leave(currentRoom);
      currentRoom = null;
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      if (room.players[socket.id]) {
        const isPlayer = room.players[socket.id].role === 'player';
        room.players[socket.id].connected = false;
        
        if (isPlayer) {
          io.to(currentRoom).emit('playerDisconnectedCount', { time: 20 });
          room.disconnectTimeout = setTimeout(() => {
            io.to(currentRoom).emit('errorMsg', "Un joueur s'est déconnecté définitivement.");
            delete rooms[currentRoom];
          }, 20000);
        } else {
          delete room.players[socket.id];
          if (room.gameType === 'pokeauc') io.to(currentRoom).emit('shopUpdate', { players: room.players });
          else if (room.gameType === 'imposteur') io.to(currentRoom).emit('lobbyUpdate', { players: room.players, host: room.host });
        }
      }
    }
  });

  // === POKEAUC EVENTS ===
  socket.on('voteMode', (mode) => { const r = rooms[currentRoom]; if(r && r.state === 'VOTING') { r.votes[socket.id] = mode; if(Object.keys(r.votes).length === 2) { const v = Object.values(r.votes); r.chosenMode = v[0] === v[1] ? v[0] : v[Math.floor(Math.random() * v.length)]; startNextAuction(currentRoom); } } });
  socket.on('placeBid', () => { const r = rooms[currentRoom]; if(!r || r.state !== 'AUCTION') return; const p = r.players[socket.id]; if(p && p.team.length < 3 && p.budget >= r.currentAuction.highestBid + 50) { r.currentAuction.highestBid += 50; r.currentAuction.highestBidder = socket.id; r.currentAuction.highestBidderName = p.name; r.currentAuction.timeLeft = 10; io.to(currentRoom).emit('bidUpdated', { highestBid: r.currentAuction.highestBid, highestBidderName: p.name, timeLeft: 10 }); } });
  socket.on('buyItem', ({ itemId, pokeIndex }) => { const r = rooms[currentRoom]; if(!r || r.state !== 'SHOP') return; const p = r.players[socket.id]; const i = SHOP_ITEMS.find(x => x.id === itemId); const pk = p.team[pokeIndex]; if(i && pk && p.budget >= i.price) { if(i.type === 'heal' && pk.hp > 0) pk.hp = Math.min(pk.hpMax, pk.hp + i.value); else if(i.type === 'revive' && pk.hp === 0) pk.hp = Math.floor(pk.hpMax * i.value); else if(i.type === 'held') pk.item = i; else return; p.budget -= i.price; io.to(currentRoom).emit('shopUpdate', { players: r.players }); } });
  socket.on('rerollPokemon', async (pokeIndex) => { const r = rooms[currentRoom]; if(!r || r.state !== 'SHOP') return; const p = r.players[socket.id]; if(p.budget >= 150 && p.team[pokeIndex]) { p.budget -= 150; const nPk = await getRandomPokemon(); if(nPk) p.team[pokeIndex] = nPk; io.to(currentRoom).emit('shopUpdate', { players: r.players }); } });
  socket.on('setShopReady', () => { const r = rooms[currentRoom]; if(!r || r.state !== 'SHOP') return; r.players[socket.id].ready = true; if(Object.values(r.players).filter(x => x.role === 'player').every(x => x.ready)) startBattle(currentRoom); });
  socket.on('battleAction', (act) => { const r = rooms[currentRoom]; if(!r || r.state !== 'BATTLE') return; const b = r.battleState; if(socket.id === b.attackerId) b.attackerAction = act; if(socket.id === b.defenderId) b.defenderAction = act; if(b.attackerAction && b.defenderAction) resolveTurn(currentRoom); });
  socket.on('requestRematch', () => { const r = rooms[currentRoom]; if(!r || r.state !== 'GAME_OVER') return; r.rematchVotes.add(socket.id); io.to(currentRoom).emit('rematchUpdate', { count: r.rematchVotes.size }); if(r.rematchVotes.size >= 2) { r.rematchVotes.clear(); Object.values(r.players).filter(x => x.role === 'player').forEach(x => { x.budget = 900; x.team = []; x.ready = false; }); r.state = 'VOTING'; r.votes = {}; io.to(currentRoom).emit('startVotingPhase', { players: r.players }); } });

  // === IMPOSTEUR EVENTS ===
  socket.on('updateImpSettings', (settings) => {
    const room = rooms[currentRoom];
    if (room && room.host === socket.id && room.gameType === 'imposteur') {
      room.impSettings = settings;
      io.to(currentRoom).emit('impSettingsUpdated', settings);
    }
  });

  socket.on('startImposteurGame', async (settings) => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id || room.gameType !== 'imposteur') return;
    
    if (settings) room.impSettings = settings;
    
    Object.values(room.players).forEach(p => p.score = 0);
    room.impState.round = 1;
    await startImposteurRound(currentRoom);
  });

  socket.on('submitImpWord', (word) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'PLAYING') return;
    
    const activePlayerId = room.impState.turnOrder[room.impState.currentTurnIdx];
    if (socket.id !== activePlayerId) return;

    const submittedWord = normalizeString(word);
    
    // ANTI-TRICHE DYNAMIQUE (Vérifie le bon Pokémon selon le rôle et le mode)
    let forbiddenName = normalizeString(room.impState.secretPoke.name);
    if (room.impSettings.mode === 'undercover' && socket.id === room.impState.imposteurId) {
        forbiddenName = normalizeString(room.impState.undercoverPoke.name);
    }

    if (submittedWord.includes(forbiddenName) || (forbiddenName.includes(submittedWord) && submittedWord.length > 3)) {
      room.impState.timeLeft = Math.floor(room.impState.timeLeft / 2);
      socket.emit('impWordRejected', { msg: "Mot interdit ou trop proche du nom !", timeLeft: room.impState.timeLeft });
      if (room.impState.timeLeft <= 0) {
        clearInterval(room.impState.timer);
        acceptWordAndNextTurn(currentRoom, activePlayerId, "⏳ (Temps écoulé)", true);
      }
      return;
    }

    clearInterval(room.impState.timer);
    acceptWordAndNextTurn(currentRoom, activePlayerId, word, false);
  });

  socket.on('submitImpVote', (suspectId) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING') return;
    
    room.impState.votes[socket.id] = suspectId;
    const totalPlayers = Object.keys(room.players).filter(id => room.players[id].connected).length;
    if (Object.keys(room.impState.votes).length >= totalPlayers) {
      resolveVoting(currentRoom);
    }
  });

  socket.on('submitImpCounterAttack', (guess) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'COUNTER_ATTACK' || socket.id !== room.impState.imposteurId) return;
    
    clearTimeout(room.impState.timer);
    const pokeName = normalizeString(room.impState.secretPoke.name);
    const theGuess = normalizeString(guess);
    const success = (pokeName === theGuess);
    finishImposteurRound(currentRoom, success, guess);
  });
});

// === FONCTIONS POKEAUC ===
async function startNextAuction(roomCode) { const r = rooms[roomCode]; if(!r || (r.state !== 'VOTING' && r.state !== 'AUCTION')) return; r.state = 'AUCTION'; const p = await getRandomPokemon(); if(!p) return setTimeout(() => startNextAuction(roomCode), 1000); let h = r.chosenMode === 'shiny' ? `Couleur : ${p.color}` : r.chosenMode === 'pokedex' ? `Pokédex N° : #${p.id}` : 'Masqué'; r.currentAuction = { pokemon: p, highestBid: 0, highestBidder: null, highestBidderName: 'Personne', timeLeft: 12 }; io.to(roomCode).emit('newAuction', { hint: h, rarity: p.rarity, players: r.players }); if(r.auctionTimer) clearInterval(r.auctionTimer); r.auctionTimer = setInterval(() => { r.currentAuction.timeLeft--; io.to(roomCode).emit('timerTick', r.currentAuction.timeLeft); if(r.currentAuction.timeLeft <= 0) { clearInterval(r.auctionTimer); endAuction(roomCode); } }, 1000); }
function endAuction(roomCode) { const r = rooms[roomCode]; if(!r) return; const w = r.currentAuction.highestBidder; if(w && r.players[w]) { r.players[w].budget -= r.currentAuction.highestBid; r.players[w].team.push(r.currentAuction.pokemon); } io.to(roomCode).emit('auctionEnded', { players: r.players, winnerName: w ? r.players[w].name : null, pokemon: r.currentAuction.pokemon.name }); checkAndFillTeams(roomCode); }
async function checkAndFillTeams(roomCode) { const r = rooms[roomCode]; if(!r || r.state !== 'AUCTION') return; const p = Object.values(r.players).filter(x => x.role === 'player'); if(p.length < 2) return; const p1 = p[0], p2 = p[1]; if(p1.team.length >= 3 && p2.team.length >= 3) { r.state = 'TRANSITIONING_TO_SHOP'; return setTimeout(() => enterShopPhase(roomCode), 2000); } let n = null; if(p1.team.length >= 3 && p2.team.length < 3) n = p2; else if(p2.team.length >= 3 && p1.team.length < 3) n = p1; else if(p1.budget < 50 && p2.budget < 50) { if(p1.team.length < 3) n = p1; else if(p2.team.length < 3) n = p2; } if(n) { const pk = await getRandomPokemon(); if(pk) n.team.push(pk); io.to(roomCode).emit('auctionEnded', { players: r.players, winnerName: "Système", pokemon: `${pk?.name} (Auto-Fill)` }); setTimeout(() => checkAndFillTeams(roomCode), 1500); } else { setTimeout(() => startNextAuction(roomCode), 2000); } }
function enterShopPhase(roomCode) { const r = rooms[roomCode]; if(!r || r.state === 'SHOP') return; r.state = 'SHOP'; r.shopItems = getShopItems(); Object.values(r.players).forEach(x => x.ready = false); io.to(roomCode).emit('enterShop', { shopItems: r.shopItems, players: r.players }); }
function getFirstAliveIndex(team) { return team.findIndex(p => p.hp > 0); }
function startBattle(roomCode) { const r = rooms[roomCode]; if(!r || r.state === 'BATTLE') return; r.state = 'BATTLE'; const p = Object.values(r.players).filter(x => x.role === 'player'); const p1 = p[0], p2 = p[1]; r.battleState = { arena: ARENA_TYPES[Math.floor(Math.random() * ARENA_TYPES.length)], lastDamage: null, p1: { id: p1.id, name: p1.name }, p2: { id: p2.id, name: p2.name }, p1ActiveIndex: 0, p2ActiveIndex: 0, attackerId: p1.id, defenderId: p2.id, attackerAction: null, defenderAction: null }; sendBattleUpdate(roomCode, `L'arène est sélectionnée. Le combat commence ! ${p1.name} attaque en premier.`); }
function resolveTurn(roomCode) { const r = rooms[roomCode]; const b = r.battleState; b.lastDamage = null; const aP = r.players[b.attackerId]; const dP = r.players[b.defenderId]; const aIdx = b.attackerId === b.p1.id ? b.p1ActiveIndex : b.p2ActiveIndex; const dIdx = b.defenderId === b.p1.id ? b.p1ActiveIndex : b.p2ActiveIndex; const aPk = aP.team[aIdx]; const dPk = dP.team[dIdx]; if(dPk.item && dPk.item.id === 'poudre' && Math.random() < 0.15) { b.attackerAction = null; b.defenderAction = null; return sendBattleUpdate(roomCode, `${dPk.name} esquive l'attaque grâce à Poudre Claire !`); } let rA = b.attackerAction === 'special' ? aPk.spAtk : aPk.attack; let rD = b.defenderAction === 'specialDef' ? dPk.spDef : dPk.def; if(aPk.item && aPk.item.id === 'bandeau' && b.attackerAction === 'physique') rA *= 1.2; if(aPk.item && aPk.item.id === 'lunettes' && b.attackerAction === 'special') rA *= 1.2; if(aPk.item && aPk.item.id === 'orbe') rA *= 1.3; if(dPk.item && dPk.item.id === 'veste') { if(b.defenderAction === 'specialDef') rD *= 1.3; if(b.defenderAction === 'physiqueDef') rD *= 0.9; } let dmg = Math.max(5, Math.floor(rA - (rD / 3))); b.lastDamage = { targetId: b.defenderId, amount: dmg }; let log = `${aPk.name} inflige ${dmg} dégâts !`; dPk.hp -= dmg; if(dPk.hp <= 0 && dPk.item && dPk.item.id === 'ceinture') { dPk.hp = 1; dPk.item = null; log += ` Survit grâce à Ceinture Force !`; } if(dPk.hp < 0) dPk.hp = 0; if(aPk.item && aPk.item.id === 'orbe') { const rc = Math.floor(aPk.hpMax * 0.1); aPk.hp = Math.max(0, aPk.hp - rc); log += ` Orbe Vie draine ${rc} PV.`; } if(aPk.item && aPk.item.id === 'grelot') { const hl = Math.floor(dmg * 0.2); aPk.hp = Math.min(aPk.hpMax, aPk.hp + hl); log += ` Grelot soigne ${hl} PV.`; } if(dPk.item && dPk.item.id === 'casque' && b.attackerAction === 'physique' && dPk.hp > 0) { aPk.hp = Math.max(0, aPk.hp - 15); log += ` Casque Brut inflige 15 PV !`; } if(dPk.item && dPk.item.id === 'sitrus' && dPk.hp > 0 && dPk.hp <= dPk.hpMax / 2) { dPk.hp = Math.min(dPk.hpMax, dPk.hp + 30); dPk.item = null; log += ` Baie Sitrus restaure 30 PV !`; } let fS = null; if(dPk.hp > 0 && dPk.item && dPk.item.id === 'fuite') { dPk.item = null; fS = b.defenderId; log += ` Bouton Fuite activé !`; } else if(dPk.hp > 0 && aPk.item && aPk.item.id === 'cartouche') { aPk.item = null; fS = b.defenderId; log += ` Cartouche Rouge activée !`; } const nA = getFirstAliveIndex(aP.team); const nD = fS === b.defenderId ? getFirstAliveIndex(dP.team.filter((x,i)=> i!==dIdx && x.hp>0)) : getFirstAliveIndex(dP.team); let tNd = fS === b.defenderId && dP.team.findIndex((x,i)=> i!==dIdx && x.hp>0) !== -1 ? dP.team.findIndex((x,i)=> i!==dIdx && x.hp>0) : getFirstAliveIndex(dP.team); if(nA === -1 || tNd === -1) { r.state = 'GAME_OVER'; log += nA === -1 ? ` ${dP.name} gagne !` : ` ${aP.name} gagne !`; } else { if(aPk.hp > 0 && aPk.item && aPk.item.id === 'restes') aPk.hp = Math.min(aPk.hpMax, aPk.hp + 10); if(dPk.hp > 0 && dPk.item && dPk.item.id === 'restes') dPk.hp = Math.min(dPk.hpMax, dPk.hp + 10); if(b.attackerId === b.p1.id) { b.p1ActiveIndex = nA; b.p2ActiveIndex = tNd; } else { b.p2ActiveIndex = nA; b.p1ActiveIndex = tNd; } const t = b.attackerId; b.attackerId = b.defenderId; b.defenderId = t; } b.attackerAction = null; b.defenderAction = null; sendBattleUpdate(roomCode, log); }
function sendBattleUpdate(roomCode, logMsg) { const r = rooms[roomCode]; io.to(roomCode).emit('battleUpdate', { battle: r.battleState, players: r.players, log: logMsg, gameState: r.state }); }
function sendBattleUpdateToSocket(sId, roomCode, logMsg) { const r = rooms[roomCode]; io.to(sId).emit('battleUpdate', { battle: r.battleState, players: r.players, log: logMsg, gameState: r.state }); }

// === FONCTIONS IMPOSTEUR ===
async function startImposteurRound(roomCode) {
  const room = rooms[roomCode];
  room.state = 'PLAYING';
  
  let poke = await getRandomPokemon();
  let failSafe = 0;
  while(!poke && failSafe < 5) { poke = await getRandomPokemon(); failSafe++; }
  
  // NOUVEAU : On charge un 2ème Pokémon si on est en mode Undercover
  let poke2 = null;
  if (room.impSettings.mode === 'undercover') {
    poke2 = await getRandomPokemon();
    failSafe = 0;
    while((!poke2 || poke2.id === poke.id) && failSafe < 5) { poke2 = await getRandomPokemon(); failSafe++; }
  }
  
  if (!poke || (room.impSettings.mode === 'undercover' && !poke2)) { 
      io.to(roomCode).emit('errorMsg', "Erreur API Pokémon. Relancez."); 
      room.state = 'LOBBY'; 
      return; 
  }
  
  room.impState.secretPoke = poke;
  room.impState.undercoverPoke = poke2;
  room.impState.wordsLog = [];
  room.impState.votes = {};
  room.impState.currentWordLap = 1;

  const playerIds = Object.keys(room.players).filter(id => room.players[id].connected);
  room.impState.turnOrder = playerIds.sort(() => Math.random() - 0.5);
  room.impState.currentTurnIdx = 0;
  room.impState.imposteurId = playerIds[Math.floor(Math.random() * playerIds.length)];

  playerIds.forEach(id => {
    const isImp = (id === room.impState.imposteurId);
    
    let sentPoke = poke;
    let flagImp = isImp;

    // En Undercover, l'imposteur ne sait pas qu'il est l'imposteur !
    if (room.impSettings.mode === 'undercover') {
        flagImp = false; 
        sentPoke = isImp ? poke2 : poke;
    } else {
        sentPoke = isImp ? null : poke;
    }

    io.to(id).emit('impRoundStarted', {
      isImposteur: flagImp, 
      pokemon: sentPoke ? { name: sentPoke.name, sprite: sentPoke.sprite } : null, 
      turnOrder: room.impState.turnOrder, 
      players: room.players,
      mode: room.impSettings.mode
    });
  });
  
  // LE SERVEUR OUVRE LE BAL
  const hints = [`Type: ${poke.types}`, `Couleur: ${poke.color}`, `Taille: ${poke.height/10}m`, `Poids: ${poke.weight/10}kg`];
  const sysHint = hints[Math.floor(Math.random() * hints.length)] + " (Indice Système)";
  
  room.impState.wordsLog.push({ playerId: 'system', word: sysHint, isAuto: true });
  io.to(roomCode).emit('impWordAccepted', { playerId: 'system', word: sysHint, isAuto: true, log: room.impState.wordsLog });

  setTimeout(() => startImposteurTurn(roomCode), 2000);
}

function startImposteurTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const activePlayerId = room.impState.turnOrder[room.impState.currentTurnIdx];
  room.impState.timeLeft = 60;
  
  io.to(roomCode).emit('impNewTurn', { activePlayerId, timeLeft: 60, lap: room.impState.currentWordLap });
  if (room.impState.timer) clearInterval(room.impState.timer);
  
  room.impState.timer = setInterval(() => {
    room.impState.timeLeft--;
    io.to(roomCode).emit('impTimerUpdate', room.impState.timeLeft);
    if (room.impState.timeLeft <= 0) {
      clearInterval(room.impState.timer);
      acceptWordAndNextTurn(roomCode, activePlayerId, "⏳ (Temps écoulé)", true);
    }
  }, 1000);
}

function acceptWordAndNextTurn(roomCode, playerId, word, isAuto) {
  const room = rooms[roomCode];
  room.impState.wordsLog.push({ playerId, word, isAuto });
  io.to(roomCode).emit('impWordAccepted', { playerId, word, isAuto, log: room.impState.wordsLog });

  room.impState.currentTurnIdx++;
  
  if (room.impState.currentTurnIdx >= room.impState.turnOrder.length) {
    room.impState.currentTurnIdx = 0;
    room.impState.currentWordLap++;
    
    if (room.impState.currentWordLap > room.impSettings.wordsPerPlayer) {
      io.to(roomCode).emit('impWaitBeforeVote', { delay: 10 });
      setTimeout(() => startImposteurVoting(roomCode), 10000);
      return;
    }
  }
  setTimeout(() => startImposteurTurn(roomCode), 2000);
}

function startImposteurVoting(roomCode) {
  const room = rooms[roomCode];
  room.state = 'VOTING';
  io.to(roomCode).emit('impStartVoting', { log: room.impState.wordsLog });
}

function resolveVoting(roomCode) {
  const room = rooms[roomCode];
  room.state = 'RESOLUTION';
  
  const counts = {};
  Object.values(room.impState.votes).forEach(id => counts[id] = (counts[id] || 0) + 1);
  let accusedId = null; let maxVotes = 0;
  for (const [id, count] of Object.entries(counts)) { if (count > maxVotes) { maxVotes = count; accusedId = id; } }

  const impId = room.impState.imposteurId;
  const imposteurCaught = (accusedId === impId);

  io.to(roomCode).emit('impVoteResult', { votes: room.impState.votes, accusedId, imposteurCaught, realImposteurId: impId });

  if (imposteurCaught) {
    room.state = 'COUNTER_ATTACK';
    io.to(roomCode).emit('impCounterAttackPhase', { imposteurId: impId });
    room.impState.timer = setTimeout(() => { finishImposteurRound(roomCode, false); }, 45000);
  } else {
    finishImposteurRound(roomCode, false);
  }
}

function finishImposteurRound(roomCode, counterAttackSuccess, guess = null) {
  const room = rooms[roomCode];
  room.state = 'ROUND_END';
  let winners = [];
  const impId = room.impState.imposteurId;

  if (room.state === 'RESOLUTION' || (room.state === 'ROUND_END' && !counterAttackSuccess)) {
    if (counterAttackSuccess) { winners = [impId]; } 
    else if (guess !== null) { winners = Object.keys(room.players).filter(id => id !== impId); } 
    else { winners = [impId]; }
  }

  winners.forEach(id => { if (room.players[id]) room.players[id].score++; });
  io.to(roomCode).emit('impRoundEnd', { secretPoke: room.impState.secretPoke, winners, scores: room.players, guess });

  setTimeout(() => {
    if (room.impState.round < room.impSettings.maxRounds) {
      room.impState.round++;
      startImposteurRound(roomCode);
    } else {
      room.state = 'LOBBY';
      io.to(roomCode).emit('impGameOver', { scores: room.players });
    }
  }, 10000);
}

server.listen(process.env.PORT || 3000, () => console.log('Poké Game Center V10 Actif !'));