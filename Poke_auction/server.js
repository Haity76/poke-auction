const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

// Liste de Pokémon de test avec IDs et stats
const POKEMON_POOL = [
  { id: 6, name: 'Dracaufeu', type: 'Feu', color: 'Orange', hp: 156, attack: 84, spAtk: 109, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/6.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/6.png' },
  { id: 9, name: 'Tortank', type: 'Eau', color: 'Bleu', hp: 158, attack: 83, spAtk: 85, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/9.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/9.png' },
  { id: 3, name: 'Florizarre', type: 'Plante', color: 'Vert', hp: 160, attack: 82, spAtk: 100, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/3.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/3.png' },
  { id: 150, name: 'Mewtwo', type: 'Psy', color: 'Violet', hp: 166, attack: 110, spAtk: 154, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/150.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/150.png' },
  { id: 212, name: 'Cizayox', type: 'Insecte', color: 'Rouge', hp: 145, attack: 130, spAtk: 55, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/212.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/212.png' },
  { id: 448, name: 'Lucario', type: 'Combat', color: 'Bleu', hp: 145, attack: 110, spAtk: 115, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/448.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/448.png' },
  { id: 623, name: 'Golemastoc', type: 'Sol', color: 'Vert-Gris', hp: 158, attack: 124, spAtk: 55, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/623.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/623.png' },
  { id: 131, name: 'Lokhlass', type: 'Eau', color: 'Bleu', hp: 190, attack: 85, spAtk: 85, sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/131.png', spriteBack: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/131.png' }
];

function generateRoomCode() {
  return 'PKM-' + Math.floor(1000 + Math.random() * 9000);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  // Création de Salon
  socket.on('createRoom', (userData) => {
    const roomCode = generateRoomCode();
    currentRoom = roomCode;
    socket.join(roomCode);

    rooms[roomCode] = {
      code: roomCode,
      players: {},
      host: socket.id,
      state: 'LOBBY', // LOBBY, VOTING, AUCTION, BATTLE
      votes: {},
      chosenMode: 'shiny',
      currentAuction: null,
      auctionTimer: null,
      battleState: null
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

  // Rejoindre un Salon
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

    // Si 2 joueurs sont là, passage à la phase de vote
    if (Object.keys(room.players).filter(id => room.players[id].role === 'player').length === 2 && room.state === 'LOBBY') {
      room.state = 'VOTING';
      io.to(roomCode).emit('startVotingPhase', { players: room.players });
    }
  });

  // Gestion des Votes de règles
  socket.on('voteMode', (mode) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING') return;

    room.votes[socket.id] = mode;
    const playerIds = Object.keys(room.players).filter(id => room.players[id].role === 'player');

    if (Object.keys(room.votes).length === 2) {
      const votesArr = Object.values(room.votes);
      if (votesArr[0] === votesArr[1]) {
        room.chosenMode = votesArr[0];
      } else {
        room.chosenMode = votesArr[Math.floor(Math.random() * votesArr.length)];
      }

      startNextAuction(currentRoom);
    }
  });

  // Enchères
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
      room.currentAuction.timeLeft = 10; // Reset le chrono à 10s

      io.to(currentRoom).emit('bidUpdated', {
        highestBid: room.currentAuction.highestBid,
        highestBidderName: player.name,
        timeLeft: 10
      });
    }
  });

  // Combat : Choix d'action
  socket.on('battleAction', (actionType) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'BATTLE') return;

    const b = room.battleState;
    if (socket.id === b.p1.id) b.p1Action = actionType;
    if (socket.id === b.p2.id) b.p2Action = actionType;

    if (b.p1Action && b.p2Action) {
      resolveTurn(currentRoom);
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

function startNextAuction(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.state = 'AUCTION';
  const poke = POKEMON_POOL[Math.floor(Math.random() * POKEMON_POOL.length)];

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

    io.to(roomCode).emit('auctionEnded', {
      winnerName: winner.name,
      pokemon: room.currentAuction.pokemon.name
    });
  }

  // Si chaque joueur a 1 Pokémon, lancer le combat
  const players = Object.values(room.players).filter(p => p.role === 'player');
  const ready = players.every(p => p.team.length >= 1);

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

  const poke1 = { ...p1.team[0], hpMax: p1.team[0].hp };
  const poke2 = { ...p2.team[0], hpMax: p2.team[0].hp };

  room.battleState = {
    p1: { id: p1.id, name: p1.name, poke: poke1 },
    p2: { id: p2.id, name: p2.name, poke: poke2 },
    p1Action: null,
    p2Action: null
  };

  sendBattleUpdate(roomCode, 'Le combat commence ! Choisissez votre attaque.');
}

function resolveTurn(roomCode) {
  const room = rooms[roomCode];
  const b = room.battleState;

  let dmg1 = b.p1Action === 'special' ? b.p1.poke.spAtk : b.p1.poke.attack;
  let dmg2 = b.p2Action === 'special' ? b.p2.poke.spAtk : b.p2.poke.attack;

  b.p2.poke.hp = Math.max(0, b.p2.poke.hp - Math.floor(dmg1 / 2));
  b.p1.poke.hp = Math.max(0, b.p1.poke.hp - Math.floor(dmg2 / 2));

  let log = `${b.p1.poke.name} et ${b.p2.poke.name} s'attaquent !`;

  if (b.p1.poke.hp === 0 || b.p2.poke.hp === 0) {
    room.state = 'GAME_OVER';
    if (b.p1.poke.hp === 0 && b.p2.poke.hp === 0) log = 'Égalité parfaite !';
    else if (b.p1.poke.hp > 0) log = `${b.p1.name} remporte la victoire !`;
    else log = `${b.p2.name} remporte la victoire !`;
  }

  b.p1Action = null;
  b.p2Action = null;

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
server.listen(PORT, () => console.log(`Serveur prêt sur http://localhost:${PORT}`));