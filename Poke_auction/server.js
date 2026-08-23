const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios'); // <-- Indispensable pour récupérer tout le Pokédex !

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

// Dictionnaire pour traduire les couleurs officielles en français
const colorTranslations = {
  black: 'Noir', blue: 'Bleu', brown: 'Brun / Marron', gray: 'Gris',
  green: 'Vert', pink: 'Rose', purple: 'Violet', red: 'Rouge', white: 'Blanc', yellow: 'Jaune'
};

// Nouvelle fonction pour piocher un Pokémon au hasard parmi les 1025 !
async function getRandomPokemon() {
  const id = Math.floor(Math.random() * 1025) + 1; // Jusqu'à la 9G
  try {
    const pokeRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${id}`);

    const nameFr = speciesRes.data.names.find(n => n.language.name === 'fr')?.name || pokeRes.data.name;
    const colorRaw = speciesRes.data.color.name;

    return {
      id: id,
      name: nameFr,
      color: colorTranslations[colorRaw] || colorRaw,
      hp: pokeRes.data.stats[0].base_stat,
      hpMax: pokeRes.data.stats[0].base_stat,
      attack: pokeRes.data.stats[1].base_stat,
      def: pokeRes.data.stats[2].base_stat,
      spAtk: pokeRes.data.stats[3].base_stat,
      spDef: pokeRes.data.stats[4].base_stat,
      speed: pokeRes.data.stats[5].base_stat,
      sprite: pokeRes.data.sprites.front_default || pokeRes.data.sprites.other['official-artwork'].front_default,
      spriteBack: pokeRes.data.sprites.back_default || pokeRes.data.sprites.front_default // Si pas de dos dispo, met la face
    };
  } catch (err) {
    console.error("Erreur de récupération API :", err.message);
    return null;
  }
}

function generateRoomCode() {
  return 'PKM-' + Math.floor(1000 + Math.random() * 9000);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createRoom', (userData) => {
    const roomCode = generateRoomCode();
    currentRoom = roomCode;
    socket.join(roomCode);

    rooms[roomCode] = {
      code: roomCode,
      players: {},
      host: socket.id,
      state: 'LOBBY',
      votes: {},
      chosenMode: 'shiny',
      currentAuction: null,
      auctionTimer: null,
      battleState: null,
      rematchVotes: new Set()
    };

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: userData.name,
      avatar: userData.avatar,
      budget: 900,
      team: [],
      role: 'player'
    };

    socket.emit('roomCreated', { roomCode, role: 'player' });
  });

  socket.on('joinRoom', ({ roomCode, name, avatar }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMsg', 'Code de salon invalide.');
      return;
    }

    currentRoom = roomCode;
    socket.join(roomCode);

    const playerKeys = Object.keys(room.players);
    const role = playerKeys.length < 2 ? 'player' : 'spectator';

    room.players[socket.id] = {
      id: socket.id,
      name,
      avatar,
      budget: 900,
      team: [],
      role
    };

    socket.emit('roomJoined', { roomCode, role });

    if (Object.keys(room.players).filter(id => room.players[id].role === 'player').length === 2 && room.state === 'LOBBY') {
      room.state = 'VOTING';
      io.to(roomCode).emit('startVotingPhase', { players: room.players });
    }
  });

  socket.on('voteMode', (mode) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING') return;

    room.votes[socket.id] = mode;
    if (Object.keys(room.votes).length === 2) {
      const votesArr = Object.values(room.votes);
      room.chosenMode = votesArr[0] === votesArr[1] ? votesArr[0] : votesArr[Math.floor(Math.random() * votesArr.length)];
      startNextAuction(currentRoom);
    }
  });

  socket.on('placeBid', () => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'AUCTION' || !room.currentAuction) return;

    const player = room.players[socket.id];
    if (!player || player.role !== 'player') return;

    const newBid = room.currentAuction.highestBid + 50;
    if (player.budget >= newBid) {
      room.currentAuction.highestBid = newBid;
      room.currentAuction.highestBidder = socket.id;
      room.currentAuction.highestBidderName = player.name;
      room.currentAuction.timeLeft = 10; // Remet à 10s

      io.to(currentRoom).emit('bidUpdated', {
        highestBid: room.currentAuction.highestBid,
        highestBidderName: player.name,
        timeLeft: 10
      });
    }
  });

  socket.on('battleAction', (actionType) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'BATTLE') return;

    const b = room.battleState;
    if (socket.id === b.attackerId) b.attackerAction = actionType;
    if (socket.id === b.defenderId) b.defenderAction = actionType;

    if (b.attackerAction && b.defenderAction) {
      resolveTurn(currentRoom);
    }
  });

  socket.on('requestRematch', () => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'GAME_OVER') return;

    room.rematchVotes.add(socket.id);
    io.to(currentRoom).emit('rematchUpdate', { count: room.rematchVotes.size });

    if (room.rematchVotes.size >= 2) {
      room.rematchVotes.clear();
      Object.values(room.players).forEach(p => {
        p.budget = 900;
        p.team = [];
      });
      room.state = 'VOTING';
      room.votes = {};
      io.to(currentRoom).emit('startVotingPhase', { players: room.players });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        delete rooms[currentRoom];
      }
    }
  });
});

// Le "async" est ajouté pour pouvoir attendre la réponse de la PokéAPI
async function startNextAuction(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.state = 'AUCTION';
  
  let poke = await getRandomPokemon();
  if (!poke) {
    // Si l'API bug un instant, on relance dans 1s
    setTimeout(() => startNextAuction(roomCode), 1000);
    return;
  }

  let hintText = '';
  if (room.chosenMode === 'shiny') hintText = `Couleur : ${poke.color}`;
  else if (room.chosenMode === 'pokedex') hintText = `Pokédex N° : #${poke.id}`;
  else hintText = 'Masqué (Aucun indice)';

  room.currentAuction = {
    pokemon: poke,
    highestBid: 0,
    highestBidder: null,
    highestBidderName: 'Personne',
    timeLeft: 12
  };

  io.to(roomCode).emit('newAuction', {
    hint: hintText,
    players: room.players
  });

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
    const winner = room.players[winnerId];
    winner.budget -= room.currentAuction.highestBid;
    winner.team.push(room.currentAuction.pokemon);
  }

  io.to(roomCode).emit('auctionEnded', {
    players: room.players,
    winnerName: winnerId ? room.players[winnerId].name : null,
    pokemon: room.currentAuction.pokemon.name
  });

  const players = Object.values(room.players).filter(p => p.role === 'player');
  // Les joueurs doivent avoir chacun 3 Pokémon pour combattre (modifiable)
  const ready = players.every(p => p.team.length >= 3); 

  // Pour la démo ou les tests rapides, on peut mettre >= 1. 
  // J'ai remis à 3 pour avoir de vraies équipes !
  if (ready) {
    setTimeout(() => startBattle(roomCode), 2000);
  } else {
    setTimeout(() => startNextAuction(roomCode), 2000);
  }
}

function startBattle(roomCode) {
  const room = rooms[roomCode];
  room.state = 'BATTLE';

  const players = Object.values(room.players).filter(p => p.role === 'player');
  const p1 = players[0];
  const p2 = players[1];

  // Sélectionne le dernier Pokémon capturé par chaque joueur
  const poke1 = { ...p1.team[p1.team.length - 1] };
  const poke2 = { ...p2.team[p2.team.length - 1] };

  room.battleState = {
    p1: { id: p1.id, name: p1.name, poke: poke1 },
    p2: { id: p2.id, name: p2.name, poke: poke2 },
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

  const attacker = (b.attackerId === b.p1.id) ? b.p1 : b.p2;
  const defender = (b.defenderId === b.p1.id) ? b.p1 : b.p2;

  let rawDmg = b.attackerAction === 'special' ? attacker.poke.spAtk : attacker.poke.attack;
  let defStat = b.defenderAction === 'specialDef' ? defender.poke.spDef : defender.poke.def;

  let finalDmg = Math.max(5, Math.floor(rawDmg - (defStat / 3)));
  defender.poke.hp = Math.max(0, defender.poke.hp - finalDmg);

  let log = `${attacker.poke.name} attaque et inflige ${finalDmg} dégâts à ${defender.poke.name} !`;

  if (defender.poke.hp === 0) {
    room.state = 'GAME_OVER';
    log = `${attacker.name} remporte la victoire !`;
  } else {
    // Changement de tour
    const temp = b.attackerId;
    b.attackerId = b.defenderId;
    b.defenderId = temp;
  }

  b.attackerAction = null;
  b.defenderAction = null;

  sendBattleUpdate(roomCode, log);
}

function sendBattleUpdate(roomCode, logMsg) {
  const room = rooms[roomCode];
  io.to(roomCode).emit('battleUpdate', {
    battle: room.battleState,
    log: logMsg,
    gameState: room.state
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur V6 actif sur le port ${PORT}`));