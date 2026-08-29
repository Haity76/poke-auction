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
      impSettings: { maxRounds: 1, wordsPerPlayer: 1 },
      impState: { round: 0, turnOrder: [], currentTurnIdx: 0, currentWordLap: 0, secretPoke: null, imposteurId: null, wordsLog: [], timer: null, timeLeft: 0, votes: {} }
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
      
      if (room.impState.imposteurId === oldId) room.impState.imposteurId = socket.id;
      const idx = room.impState.turnOrder.indexOf(oldId);
      if (idx !== -1) room.impState.turnOrder[idx] = socket.id;
      
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

  socket.on('voteMode', (mode) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING' || room.gameType !== 'pokeauc') return;
    room.votes[socket.id] = mode;
    if (Object.keys(room.votes).length === 2) {
      const v = Object.values(room.votes);
      room.chosenMode = v[0] === v[1] ? v[0] : v[Math.floor(Math.random() * v.length)];
      startNextAuction(currentRoom);
    }
  });

  socket.on('placeBid', () => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'AUCTION' || !room.currentAuction) return;
    const player = room.players[socket.id];
    if (!player || player.role !== 'player' || player.team.length >= 3) return;
    const newBid = room.currentAuction.highestBid + 50;
    if (player.budget >= newBid) {
      room.currentAuction.highestBid = newBid;
      room.currentAuction.highestBidder = socket.id;
      room.currentAuction.highestBidderName = player.name;
      room.currentAuction.timeLeft = 10;
      io.to(currentRoom).emit('bidUpdated', { highestBid: room.currentAuction.highestBid, highestBidderName: player.name, timeLeft: 10 });
    }
  });

  socket.on('buyItem', ({ itemId, pokeIndex }) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'SHOP') return;
    const player = room.players[socket.id];
    const itemDef = SHOP_ITEMS.find(i => i.id === itemId);
    const poke = player.team[pokeIndex];
    if (!itemDef || !poke || player.budget < itemDef.price) return;
    
    if (itemDef.type === 'heal' && poke.hp > 0) poke.hp = Math.min(poke.hpMax, poke.hp + itemDef.value);
    else if (itemDef.type === 'revive' && poke.hp === 0) poke.hp = Math.floor(poke.hpMax * itemDef.value);
    else if (itemDef.type === 'held') poke.item = itemDef;
    else return;
    
    player.budget -= itemDef.price;
    io.to(currentRoom).emit('shopUpdate', { players: room.players });
  });

  socket.on('rerollPokemon', async (pokeIndex) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'SHOP') return;
    const player = room.players[socket.id];
    if (player.budget >= 150 && player.team[pokeIndex]) {
      player.budget -= 150;
      const newPoke = await getRandomPokemon();
      if(newPoke) player.team[pokeIndex] = newPoke;
      io.to(currentRoom).emit('shopUpdate', { players: room.players });
    }
  });

  socket.on('setShopReady', () => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'SHOP') return;
    room.players[socket.id].ready = true;
    const players = Object.values(room.players).filter(p => p.role === 'player');
    if (players.every(p => p.ready)) startBattle(currentRoom);
  });

  socket.on('battleAction', (actionType) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'BATTLE') return;
    const b = room.battleState;
    if (socket.id === b.attackerId) b.attackerAction = actionType;
    if (socket.id === b.defenderId) b.defenderAction = actionType;
    if (b.attackerAction && b.defenderAction) resolveTurn(currentRoom);
  });

  socket.on('requestRematch', () => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'GAME_OVER') return;
    room.rematchVotes.add(socket.id);
    io.to(currentRoom).emit('rematchUpdate', { count: room.rematchVotes.size });
    if (room.rematchVotes.size >= 2) {
      room.rematchVotes.clear();
      Object.values(room.players).filter(p => p.role === 'player').forEach(p => { p.budget = 900; p.team = []; p.ready = false; });
      room.state = 'VOTING';
      room.votes = {};
      io.to(currentRoom).emit('startVotingPhase', { players: room.players });
    }
  });

  socket.on('updateImpSettings', (settings) => {
    const room = rooms[currentRoom];
    if (room && room.host === socket.id && room.gameType === 'imposteur') {
      room.impSettings = settings;
      io.to(currentRoom).emit('impSettingsUpdated', settings);
    }
  });

  socket.on('startImposteurGame', async () => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id || room.gameType !== 'imposteur') return;
    
    Object.values(room.players).forEach(p => p.score = 0);
    room.impState.round = 1;
    await startImposteurRound(currentRoom);
  });

  socket.on('submitImpWord', (word) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'PLAYING') return;
    
    const activePlayerId = room.impState.turnOrder[room.impState.currentTurnIdx];
    if (socket.id !== activePlayerId) return;

    const pokeName = normalizeString(room.impState.secretPoke.name);
    const submittedWord = normalizeString(word);

    if (submittedWord.includes(pokeName) || (pokeName.includes(submittedWord) && submittedWord.length > 3)) {
      room.impState.timeLeft = Math.floor(room.impState.timeLeft / 2);
      socket.emit('impWordRejected', { msg: "Mot interdit ou trop proche du nom !", timeLeft: room.impState.timeLeft });
      if (room.impState.timeLeft <= 0) {
        clearInterval(room.impState.timer);
        handleAutoWord(currentRoom, activePlayerId);
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

async function startNextAuction(roomCode) {
  const room = rooms[roomCode];
  if (!room || (room.state !== 'VOTING' && room.state !== 'AUCTION')) return; 
  room.state = 'AUCTION';
  const poke = await getRandomPokemon();
  if (!poke) return setTimeout(() => startNextAuction(roomCode), 1000);

  let hintText = room.chosenMode === 'shiny' ? `Couleur : ${poke.color}` : room.chosenMode === 'pokedex' ? `Pokédex N° : #${poke.id}` : 'Masqué';
  room.currentAuction = { pokemon: poke, highestBid: 0, highestBidder: null, highestBidderName: 'Personne', timeLeft: 12 };
  io.to(roomCode).emit('newAuction', { hint: hintText, rarity: poke.rarity, players: room.players });

  if (room.auctionTimer) clearInterval(room.auctionTimer);
  room.auctionTimer = setInterval(() => {
    room.currentAuction.timeLeft--;
    io.to(roomCode).emit('timerTick', room.currentAuction.timeLeft);
    if (room.currentAuction.timeLeft <= 0) {
      clearInterval(room.auctionTimer);
      endAuction(roomCode);
    }
  }, 1000);
}

function endAuction(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const winnerId = room.currentAuction.highestBidder;
  if (winnerId && room.players[winnerId]) {
    room.players[winnerId].budget -= room.currentAuction.highestBid;
    room.players[winnerId].team.push(room.currentAuction.pokemon);
  }
  io.to(roomCode).emit('auctionEnded', { players: room.players, winnerName: winnerId ? room.players[winnerId].name : null, pokemon: room.currentAuction.pokemon.name });
  checkAndFillTeams(roomCode);
}

async function checkAndFillTeams(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'AUCTION') return;
  
  const players = Object.values(room.players).filter(p => p.role === 'player');
  if (players.length < 2) return; 
  const p1 = players[0], p2 = players[1];

  if (p1.team.length >= 3 && p2.team.length >= 3) {
    room.state = 'TRANSITIONING_TO_SHOP'; 
    return setTimeout(() => enterShopPhase(roomCode), 2000);
  }

  let needsAutoFill = null;
  if (p1.team.length >= 3 && p2.team.length < 3) needsAutoFill = p2;
  else if (p2.team.length >= 3 && p1.team.length < 3) needsAutoFill = p1;
  else if (p1.budget < 50 && p2.budget < 50) {
    if (p1.team.length < 3) needsAutoFill = p1;
    else if (p2.team.length < 3) needsAutoFill = p2;
  }

  if (needsAutoFill) {
    const poke = await getRandomPokemon();
    if (poke) {
      needsAutoFill.team.push(poke);
      io.to(roomCode).emit('auctionEnded', { players: room.players, winnerName: "Système", pokemon: `${poke.name} (Auto-Fill)` });
    }
    setTimeout(() => checkAndFillTeams(roomCode), 1500);
  } else {
    setTimeout(() => startNextAuction(roomCode), 2000);
  }
}

function enterShopPhase(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state === 'SHOP') return; 
  room.state = 'SHOP';
  room.shopItems = getShopItems();
  Object.values(room.players).forEach(p => p.ready = false);
  io.to(roomCode).emit('enterShop', { shopItems: room.shopItems, players: room.players });
}

function getFirstAliveIndex(team) { return team.findIndex(p => p.hp > 0); }

function startBattle(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state === 'BATTLE') return;
  room.state = 'BATTLE';
  const players = Object.values(room.players).filter(p => p.role === 'player');
  const p1 = players[0], p2 = players[1];

  room.battleState = { 
    arena: ARENA_TYPES[Math.floor(Math.random() * ARENA_TYPES.length)],
    lastDamage: null,
    p1: { id: p1.id, name: p1.name }, p2: { id: p2.id, name: p2.name }, 
    p1ActiveIndex: 0, p2ActiveIndex: 0, attackerId: p1.id, defenderId: p2.id, 
    attackerAction: null, defenderAction: null 
  };
  sendBattleUpdate(roomCode, `L'arène est sélectionnée. Le combat commence ! ${p1.name} attaque en premier.`);
}

function resolveTurn(roomCode) {
  const room = rooms[roomCode];
  const b = room.battleState;
  b.lastDamage = null;
  
  const attackerPlayer = room.players[b.attackerId];
  const defenderPlayer = room.players[b.defenderId];
  const attackerActiveIdx = b.attackerId === b.p1.id ? b.p1ActiveIndex : b.p2ActiveIndex;
  const defenderActiveIdx = b.defenderId === b.p1.id ? b.p1ActiveIndex : b.p2ActiveIndex;
  
  const atkPoke = attackerPlayer.team[attackerActiveIdx];
  const defPoke = defenderPlayer.team[defenderActiveIdx];

  if (defPoke.item && defPoke.item.id === 'poudre' && Math.random() < 0.15) {
    b.attackerAction = null; b.defenderAction = null;
    return sendBattleUpdate(roomCode, `${defPoke.name} esquive l'attaque grâce à Poudre Claire !`);
  }

  let rawAtk = b.attackerAction === 'special' ? atkPoke.spAtk : atkPoke.attack;
  let rawDef = b.defenderAction === 'specialDef' ? defPoke.spDef : defPoke.def;

  if (atkPoke.item && atkPoke.item.id === 'bandeau' && b.attackerAction === 'physique') rawAtk *= 1.2;
  if (atkPoke.item && atkPoke.item.id === 'lunettes' && b.attackerAction === 'special') rawAtk *= 1.2;
  if (atkPoke.item && atkPoke.item.id === 'orbe') rawAtk *= 1.3;
  if (defPoke.item && defPoke.item.id === 'veste') {
    if (b.defenderAction === 'specialDef') rawDef *= 1.3;
    if (b.defenderAction === 'physiqueDef') rawDef *= 0.9;
  }

  let dmg = Math.max(5, Math.floor(rawAtk - (rawDef / 3)));
  b.lastDamage = { targetId: b.defenderId, amount: dmg };
  let log = `${atkPoke.name} attaque et inflige ${dmg} dégâts à ${defPoke.name} !`;

  defPoke.hp -= dmg;
  if (defPoke.hp <= 0 && defPoke.item && defPoke.item.id === 'ceinture') { defPoke.hp = 1; defPoke.item = null; log += ` ${defPoke.name} survit grâce à sa Ceinture Force !`; }
  if (defPoke.hp < 0) defPoke.hp = 0;

  if (atkPoke.item && atkPoke.item.id === 'orbe') {
    const recoil = Math.floor(atkPoke.hpMax * 0.1);
    atkPoke.hp = Math.max(0, atkPoke.hp - recoil);
    log += ` L'Orbe Vie draine ${recoil} PV.`;
  }
  if (atkPoke.item && atkPoke.item.id === 'grelot') {
    const heal = Math.floor(dmg * 0.2);
    atkPoke.hp = Math.min(atkPoke.hpMax, atkPoke.hp + heal);
    log += ` Grelot Coque soigne ${heal} PV.`;
  }
  if (defPoke.item && defPoke.item.id === 'casque' && b.attackerAction === 'physique' && defPoke.hp > 0) {
    atkPoke.hp = Math.max(0, atkPoke.hp - 15);
    log += ` Casque Brut inflige 15 PV de recul !`;
  }
  if (defPoke.item && defPoke.item.id === 'sitrus' && defPoke.hp > 0 && defPoke.hp <= defPoke.hpMax / 2) {
    defPoke.hp = Math.min(defPoke.hpMax, defPoke.hp + 30); defPoke.item = null;
    log += ` Baie Sitrus restaure 30 PV !`;
  }

  let forceSwitchId = null;
  if (defPoke.hp > 0 && defPoke.item && defPoke.item.id === 'fuite') { defPoke.item = null; forceSwitchId = b.defenderId; log += ` Bouton Fuite activé !`; } 
  else if (defPoke.hp > 0 && atkPoke.item && atkPoke.item.id === 'cartouche') { atkPoke.item = null; forceSwitchId = b.defenderId; log += ` Cartouche Rouge activée !`; }

  const nextAtkIdx = getFirstAliveIndex(attackerPlayer.team);
  const nextDefIdx = forceSwitchId === b.defenderId ? getFirstAliveIndex(defenderPlayer.team.filter((p,i)=> i!==defenderActiveIdx && p.hp>0)) : getFirstAliveIndex(defenderPlayer.team);
  let trueNextDefIdx = forceSwitchId === b.defenderId && defenderPlayer.team.findIndex((p,i)=> i!==defenderActiveIdx && p.hp>0) !== -1 ? defenderPlayer.team.findIndex((p,i)=> i!==defenderActiveIdx && p.hp>0) : getFirstAliveIndex(defenderPlayer.team);

  if (nextAtkIdx === -1 || trueNextDefIdx === -1) {
    room.state = 'GAME_OVER';
    log += nextAtkIdx === -1 ? ` ${defenderPlayer.name} gagne !` : ` ${attackerPlayer.name} gagne !`;
  } else {
    if (atkPoke.hp > 0 && atkPoke.item && atkPoke.item.id === 'restes') atkPoke.hp = Math.min(atkPoke.hpMax, atkPoke.hp + 10);
    if (defPoke.hp > 0 && defPoke.item && defPoke.item.id === 'restes') defPoke.hp = Math.min(defPoke.hpMax, defPoke.hp + 10);

    if (b.attackerId === b.p1.id) { b.p1ActiveIndex = nextAtkIdx; b.p2ActiveIndex = trueNextDefIdx; }
    else { b.p2ActiveIndex = nextAtkIdx; b.p1ActiveIndex = trueNextDefIdx; }

    const temp = b.attackerId; b.attackerId = b.defenderId; b.defenderId = temp;
  }

  b.attackerAction = null; b.defenderAction = null;
  sendBattleUpdate(roomCode, log);
}

function sendBattleUpdate(roomCode, logMsg) {
  const room = rooms[roomCode];
  const b = room.battleState;
  io.to(roomCode).emit('battleUpdate', { battle: b, players: room.players, log: logMsg, gameState: room.state });
}

function sendBattleUpdateToSocket(socketId, roomCode, logMsg) {
  const room = rooms[roomCode];
  const b = room.battleState;
  io.to(socketId).emit('battleUpdate', { battle: b, players: room.players, log: logMsg, gameState: room.state });
}

// CORRECTION MINEURE : Sécurité anti-crash pour l'API Pokémon ajoutée ici
async function startImposteurRound(roomCode) {
  const room = rooms[roomCode];
  room.state = 'PLAYING';
  
  let poke = await getRandomPokemon();
  let failSafe = 0;
  while(!poke && failSafe < 5) {
    poke = await getRandomPokemon();
    failSafe++;
  }
  
  if (!poke) {
    io.to(roomCode).emit('errorMsg', "Erreur de connexion à l'API Pokémon. Veuillez relancer la partie.");
    room.state = 'LOBBY';
    return;
  }
  
  room.impState.secretPoke = poke;
  room.impState.wordsLog = [];
  room.impState.votes = {};
  room.impState.currentWordLap = 1;

  const playerIds = Object.keys(room.players).filter(id => room.players[id].connected);
  room.impState.turnOrder = playerIds.sort(() => Math.random() - 0.5);
  room.impState.currentTurnIdx = 0;
  room.impState.imposteurId = playerIds[Math.floor(Math.random() * playerIds.length)];

  playerIds.forEach(id => {
    const isImp = (id === room.impState.imposteurId);
    io.to(id).emit('impRoundStarted', {
      isImposteur: isImp,
      pokemon: isImp ? null : { name: poke.name, sprite: poke.sprite },
      turnOrder: room.impState.turnOrder,
      players: room.players
    });
  });

  startImposteurTurn(roomCode);
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
      handleAutoWord(roomCode, activePlayerId);
    }
  }, 1000);
}

function handleAutoWord(roomCode, playerId) {
  const room = rooms[roomCode];
  const p = room.impState.secretPoke;
  const hints = [`Type: ${p.types}`, `Couleur: ${p.color}`, `Taille: ${p.height/10}m`, `Poids: ${p.weight/10}kg`];
  const randomHint = hints[Math.floor(Math.random() * hints.length)] + " (Auto)";
  acceptWordAndNextTurn(roomCode, playerId, randomHint, true);
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
      return startImposteurVoting(roomCode);
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
  
  let accusedId = null;
  let maxVotes = 0;
  for (const [id, count] of Object.entries(counts)) {
    if (count > maxVotes) { maxVotes = count; accusedId = id; }
  }

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
    if (counterAttackSuccess) {
      winners = [impId]; 
    } else if (guess !== null) {
      winners = Object.keys(room.players).filter(id => id !== impId); 
    } else {
      winners = [impId]; 
    }
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