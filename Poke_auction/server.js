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
  { id: 'potion', name: 'Potion', type: 'heal', value: 50, price: 50, weight: 15 },
  { id: 'super_potion', name: 'Super Potion', type: 'heal', value: 100, price: 80, weight: 10 },
  { id: 'rappel', name: 'Rappel', type: 'revive', value: 0.5, price: 200, weight: 2 },
  { id: 'sitrus', name: 'Baie Sitrus', type: 'held', price: 100, weight: 12 },
  { id: 'bandeau', name: 'Bandeau Muscle', type: 'held', price: 120, weight: 12 },
  { id: 'lunettes', name: 'Lunettes Choix', type: 'held', price: 120, weight: 12 },
  { id: 'restes', name: 'Restes', type: 'held', price: 150, weight: 8 },
  { id: 'veste', name: 'Veste de Combat', type: 'held', price: 140, weight: 7 },
  { id: 'casque', name: 'Casque Brut', type: 'held', price: 150, weight: 7 },
  { id: 'fuite', name: 'Bouton Fuite', type: 'held', price: 150, weight: 5 },
  { id: 'orbe', name: 'Orbe Vie', type: 'held', price: 180, weight: 3 },
  { id: 'grelot', name: 'Grelot Coque', type: 'held', price: 170, weight: 3 },
  { id: 'ceinture', name: 'Ceinture Force', type: 'held', price: 180, weight: 2 },
  { id: 'poudre', name: 'Poudre Claire', type: 'held', price: 160, weight: 1 },
  { id: 'cartouche', name: 'Cartouche Rouge', type: 'held', price: 250, weight: 1 }
];

const colorTranslations = { black: 'Noir', blue: 'Bleu', brown: 'Brun / Marron', gray: 'Gris', green: 'Vert', pink: 'Rose', purple: 'Violet', red: 'Rouge', white: 'Blanc', yellow: 'Jaune' };

async function getRandomPokemon() {
  const id = Math.floor(Math.random() * 1025) + 1;
  try {
    const pokeRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${id}`);

    const nameFr = speciesRes.data.names.find(n => n.language.name === 'fr')?.name || pokeRes.data.name;
    const colorRaw = speciesRes.data.color.name;
    
    const stats = pokeRes.data.stats.map(s => s.base_stat);
    const bst = stats.reduce((a, b) => a + b, 0);
    
    let rarity = 'Commun';
    if (bst >= 600 || speciesRes.data.is_legendary || speciesRes.data.is_mythical) rarity = 'Légendaire';
    else if (bst >= 500) rarity = 'Épique';
    else if (bst >= 400) rarity = 'Rare';

    return {
      id, name: nameFr, color: colorTranslations[colorRaw] || colorRaw, rarity,
      hp: stats[0], hpMax: stats[0], attack: stats[1], def: stats[2], spAtk: stats[3], spDef: stats[4], speed: stats[5],
      sprite: pokeRes.data.sprites.front_default || pokeRes.data.sprites.other['official-artwork'].front_default,
      spriteBack: pokeRes.data.sprites.back_default || pokeRes.data.sprites.front_default,
      item: null
    };
  } catch (err) {
    console.error("Erreur PokéAPI :", err.message);
    return null;
  }
}

function generateRoomCode() { return 'PKM-' + Math.floor(1000 + Math.random() * 9000); }

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
    const roomCode = generateRoomCode();
    currentRoom = roomCode;
    socket.join(roomCode);

    rooms[roomCode] = {
      code: roomCode, players: {}, host: socket.id, state: 'LOBBY', votes: {}, chosenMode: 'shiny',
      currentAuction: null, auctionTimer: null, battleState: null, rematchVotes: new Set(), shopItems: [],
      disconnectTimeout: null
    };

    rooms[roomCode].players[socket.id] = { id: socket.id, name: userData.name, avatar: userData.avatar, budget: 900, team: [], role: 'player', connected: true, ready: false };
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
      
      io.to(roomCode).emit('playerReconnected', { name });
      socket.emit('roomJoined', { roomCode, role: room.players[socket.id].role });
      
      if(room.state === 'SHOP') socket.emit('enterShop', { shopItems: room.shopItems, players: room.players });
      else if(room.state === 'BATTLE') sendBattleUpdateToSocket(socket.id, roomCode, "Combat repris !");
      return;
    }

    currentRoom = roomCode;
    socket.join(roomCode);
    const activePlayers = Object.values(room.players).filter(p => p.role === 'player').length;
    const role = activePlayers < 2 ? 'player' : 'spectator';
    
    room.players[socket.id] = { id: socket.id, name, avatar, budget: 900, team: [], role, connected: true, ready: false };

    socket.emit('roomJoined', { roomCode, role });
    
    if (role === 'player' && activePlayers + 1 === 2 && room.state === 'LOBBY') {
      room.state = 'VOTING';
      io.to(roomCode).emit('startVotingPhase', { players: room.players });
    } else if (role === 'spectator') {
      // Rattrapage de l'état pour le spectateur
      if (room.state === 'VOTING') socket.emit('startVotingPhase', { players: room.players });
      else if (room.state === 'AUCTION') {
         socket.emit('newAuction', { hint: room.currentAuction?.hint, rarity: room.currentAuction?.pokemon?.rarity, players: room.players });
         if (room.currentAuction) socket.emit('bidUpdated', { highestBid: room.currentAuction.highestBid, highestBidderName: room.currentAuction.highestBidderName, timeLeft: room.currentAuction.timeLeft });
      }
      else if (room.state === 'SHOP') socket.emit('enterShop', { shopItems: room.shopItems, players: room.players });
      else if (room.state === 'BATTLE' || room.state === 'GAME_OVER') sendBattleUpdateToSocket(socket.id, roomCode, "Vous observez le combat.");
    }
  });

  socket.on('voteMode', (mode) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING') return;
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

  socket.on('leaveRoom', () => {
    if(currentRoom && rooms[currentRoom]) {
      if (rooms[currentRoom].players[socket.id] && rooms[currentRoom].players[socket.id].role === 'player') {
        io.to(currentRoom).emit('errorMsg', "L'adversaire a quitté le salon.");
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
            io.to(currentRoom).emit('errorMsg', "L'adversaire s'est déconnecté définitivement.");
            delete rooms[currentRoom];
          }, 20000);
        } else {
          delete room.players[socket.id];
          io.to(currentRoom).emit('shopUpdate', { players: room.players });
        }
      }
    }
  });
});

async function startNextAuction(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.state = 'AUCTION';
  const poke = await getRandomPokemon();
  if (!poke) return setTimeout(() => startNextAuction(roomCode), 1000);

  let hintText = room.chosenMode === 'shiny' ? `Couleur : ${poke.color}` : room.chosenMode === 'pokedex' ? `Pokédex N° : #${poke.id}` : 'Masqué';

  room.currentAuction = { pokemon: poke, highestBid: 0, highestBidder: null, highestBidderName: 'Personne', timeLeft: 12 };
  
  // Inclure la rareté dans les indices cachés pour l'affichage visuel
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
  if (!room) return;
  const players = Object.values(room.players).filter(p => p.role === 'player');
  const p1 = players[0], p2 = players[1];

  if (p1.team.length >= 3 && p2.team.length >= 3) return setTimeout(() => enterShopPhase(roomCode), 2000);

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
  room.state = 'SHOP';
  room.shopItems = getShopItems();
  Object.values(room.players).forEach(p => p.ready = false);
  io.to(roomCode).emit('enterShop', { shopItems: room.shopItems, players: room.players });
}

function getFirstAliveIndex(team) { return team.findIndex(p => p.hp > 0); }

function startBattle(roomCode) {
  const room = rooms[roomCode];
  room.state = 'BATTLE';
  const players = Object.values(room.players).filter(p => p.role === 'player');
  const p1 = players[0], p2 = players[1];

  room.battleState = {
    p1: { id: p1.id, name: p1.name },
    p2: { id: p2.id, name: p2.name },
    p1ActiveIndex: 0,
    p2ActiveIndex: 0,
    attackerId: p1.id,
    defenderId: p2.id,
    attackerAction: null,
    defenderAction: null
  };

  sendBattleUpdate(roomCode, `Le combat commence ! ${p1.name} attaque en premier.`);
}

function resolveTurn(roomCode) {
  const room = rooms[roomCode];
  const b = room.battleState;
  
  const attackerPlayer = room.players[b.attackerId];
  const defenderPlayer = room.players[b.defenderId];
  
  const attackerActiveIdx = b.attackerId === b.p1.id ? b.p1ActiveIndex : b.p2ActiveIndex;
  const defenderActiveIdx = b.defenderId === b.p1.id ? b.p1ActiveIndex : b.p2ActiveIndex;
  
  const atkPoke = attackerPlayer.team[attackerActiveIdx];
  const defPoke = defenderPlayer.team[defenderActiveIdx];

  if (defPoke.item && defPoke.item.id === 'poudre' && Math.random() < 0.15) {
    b.attackerAction = null; b.defenderAction = null;
    return sendBattleUpdate(roomCode, `${defPoke.name} esquive l'attaque grâce à Poudre Claire ! (Changement de tour)`);
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
  let log = `${atkPoke.name} attaque et inflige ${dmg} dégâts à ${defPoke.name} !`;

  defPoke.hp -= dmg;
  if (defPoke.hp <= 0 && defPoke.item && defPoke.item.id === 'ceinture') {
    defPoke.hp = 1; defPoke.item = null;
    log += ` ${defPoke.name} survit grâce à sa Ceinture Force !`;
  }
  if (defPoke.hp < 0) defPoke.hp = 0;

  if (atkPoke.item && atkPoke.item.id === 'orbe') {
    const recoil = Math.floor(atkPoke.hpMax * 0.1);
    atkPoke.hp = Math.max(0, atkPoke.hp - recoil);
    log += ` L'Orbe Vie draine ${recoil} PV.`;
  }
  if (atkPoke.item && atkPoke.item.id === 'grelot') {
    const heal = Math.floor(dmg * 0.2);
    atkPoke.hp = Math.min(atkPoke.hpMax, atkPoke.hp + heal);
    log += ` Le Grelot Coque soigne ${heal} PV.`;
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
  if (defPoke.hp > 0 && defPoke.item && defPoke.item.id === 'fuite') {
    defPoke.item = null; forceSwitchId = b.defenderId; log += ` Bouton Fuite activé !`;
  } else if (defPoke.hp > 0 && atkPoke.item && atkPoke.item.id === 'cartouche') {
    atkPoke.item = null; forceSwitchId = b.defenderId; log += ` Cartouche Rouge force l'adversaire à changer !`;
  }

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
  io.to(roomCode).emit('battleUpdate', {
    battle: b,
    p1Poke: room.players[b.p1.id].team[b.p1ActiveIndex],
    p2Poke: room.players[b.p2.id].team[b.p2ActiveIndex],
    log: logMsg,
    gameState: room.state
  });
}

function sendBattleUpdateToSocket(socketId, roomCode, logMsg) {
  const room = rooms[roomCode];
  const b = room.battleState;
  io.to(socketId).emit('battleUpdate', {
    battle: b,
    p1Poke: room.players[b.p1.id].team[b.p1ActiveIndex],
    p2Poke: room.players[b.p2.id].team[b.p2ActiveIndex],
    log: logMsg,
    gameState: room.state
  });
}

server.listen(process.env.PORT || 3000, () => console.log('Serveur PokeAuc V9 actif !'));