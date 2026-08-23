const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = {};
let gameState = 'LOBBY';
let currentPokemon = null;
let currentBid = { playerId: null, amount: 0 };
let auctionTimer = null;
let timeLeft = 15;
let rematchVotes = new Set();

let battleState = {
  attackerId: null,
  defenderId: null,
  turn: 1
};

const colorTranslations = {
  black: 'Noir', blue: 'Bleu', brown: 'Brun / Marron', gray: 'Gris',
  green: 'Vert', pink: 'Rose', purple: 'Violet', red: 'Rouge', white: 'Blanc', yellow: 'Jaune'
};

async function getRandomPokemon() {
  const id = Math.floor(Math.random() * 898) + 1;
  try {
    const pokeRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${id}`);

    const nameFr = speciesRes.data.names.find(n => n.language.name === 'fr')?.name || pokeRes.data.name;
    const colorRaw = speciesRes.data.color.name;

    return {
      id,
      name: nameFr,
      color: colorTranslations[colorRaw] || colorRaw,
      sprite: pokeRes.data.sprites.front_default,
      stats: {
        hp: pokeRes.data.stats[0].base_stat,
        maxHp: pokeRes.data.stats[0].base_stat,
        atk: pokeRes.data.stats[1].base_stat,
        def: pokeRes.data.stats[2].base_stat,
        atk_spe: pokeRes.data.stats[3].base_stat,
        def_spe: pokeRes.data.stats[4].base_stat,
        speed: pokeRes.data.stats[5].base_stat,
      }
    };
  } catch (err) {
    return null;
  }
}

function getSanitizedPlayers() {
  const result = {};
  for (let id in players) {
    result[id] = {
      id: players[id].id,
      name: players[id].name,
      avatar: players[id].avatar,
      ready: players[id].ready,
      budget: players[id].budget,
      team: players[id].team
    };
  }
  return result;
}

io.on('connection', (socket) => {
  if (Object.keys(players).length < 2) {
    players[socket.id] = {
      id: socket.id,
      name: 'Dresseur',
      avatar: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/trainers/1.png',
      ready: false,
      budget: 900,
      team: [],
      currentChoice: null,
      activePokemonIndex: 0
    };
    socket.emit('roleAssignment', { role: 'player', id: socket.id });
  } else {
    socket.emit('roleAssignment', { role: 'spectator', id: socket.id });
  }

  io.emit('updateGameState', { gameState, players: getSanitizedPlayers() });

  socket.on('setProfile', (data) => {
    if (players[socket.id]) {
      players[socket.id].name = data.name || 'Dresseur';
      players[socket.id].avatar = data.avatar;
      players[socket.id].ready = true;

      const pKeys = Object.keys(players);
      if (pKeys.length === 2 && players[pKeys[0]].ready && players[pKeys[1]].ready && gameState === 'LOBBY') {
        startAuctionRound();
      } else {
        io.emit('updateGameState', { gameState, players: getSanitizedPlayers() });
      }
    }
  });

  socket.on('placeBid', () => {
    const player = players[socket.id];
    if (!player || gameState !== 'AUCTION' || player.team.length >= 3) return;

    const newAmount = currentBid.amount + 50;
    if (newAmount <= player.budget) {
      currentBid = { playerId: socket.id, amount: newAmount, playerName: player.name };
      timeLeft = 15;
      io.emit('bidUpdated', { currentBid, timeLeft });
    }
  });

  socket.on('submitBattleAction', (choice) => {
    if (players[socket.id] && gameState === 'BATTLE') {
      players[socket.id].currentChoice = choice;
      checkBattleTurn();
    }
  });

  socket.on('requestRematch', () => {
    if (players[socket.id] && gameState === 'GAME_OVER') {
      rematchVotes.add(socket.id);
      io.emit('rematchStatus', { count: rematchVotes.size });

      if (rematchVotes.size === 2) {
        resetGame();
      }
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      rematchVotes.delete(socket.id);
      gameState = 'LOBBY';
      clearInterval(auctionTimer);
      io.emit('playerDisconnected');
      io.emit('updateGameState', { gameState, players: getSanitizedPlayers() });
    }
  });
});

function resetGame() {
  rematchVotes.clear();
  for (let id in players) {
    players[id].budget = 900;
    players[id].team = [];
    players[id].activePokemonIndex = 0;
    players[id].currentChoice = null;
  }
  startAuctionRound();
}

async function startAuctionRound() {
  const pKeys = Object.keys(players);
  if (pKeys.length < 2) return;

  const p1 = players[pKeys[0]];
  const p2 = players[pKeys[1]];

  if (p1.team.length >= 3 && p2.team.length >= 3) {
    return startBattle();
  }

  if (p1.team.length >= 3 || p2.team.length >= 3) {
    const needyPlayer = p1.team.length < 3 ? p1 : p2;
    const poke = await getRandomPokemon();
    if (poke) {
      needyPlayer.team.push(poke);
      io.emit('autoAssigned', { playerName: needyPlayer.name, pokeName: poke.name });
      io.emit('updateGameState', { gameState: 'AUCTION', players: getSanitizedPlayers() });
    }
    return setTimeout(startAuctionRound, 2000);
  }

  gameState = 'AUCTION';
  currentBid = { playerId: null, amount: 0, playerName: 'Personne' };
  currentPokemon = await getRandomPokemon();

  if (!currentPokemon) return startAuctionRound();

  timeLeft = 15;
  io.emit('newAuction', { color: currentPokemon.color, players: getSanitizedPlayers() });

  clearInterval(auctionTimer);
  auctionTimer = setInterval(() => {
    io.emit('timerTick', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(auctionTimer);
      resolveAuction();
    }
    timeLeft--;
  }, 1000);
}

function resolveAuction() {
  if (currentBid.playerId) {
    const winner = players[currentBid.playerId];
    winner.budget -= currentBid.amount;
    winner.team.push(currentPokemon);
    io.emit('auctionEnded', { winnerName: winner.name, price: currentBid.amount, pokeName: currentPokemon.name });
  } else {
    io.emit('auctionEnded', { winnerName: null });
  }

  io.emit('updateGameState', { gameState, players: getSanitizedPlayers() });
  setTimeout(startAuctionRound, 3000);
}

function startBattle() {
  gameState = 'BATTLE';
  const pKeys = Object.keys(players);
  
  const firstIndex = Math.random() < 0.5 ? 0 : 1;
  battleState.attackerId = pKeys[firstIndex];
  battleState.defenderId = pKeys[firstIndex === 0 ? 1 : 0];
  battleState.turn = 1;

  broadcastBattleState(`Le combat commence ! Pile ou face : ${players[battleState.attackerId].name} attaque en premier !`);
}

function broadcastBattleState(logMessage) {
  const pKeys = Object.keys(players);
  const p1 = players[pKeys[0]];
  const p2 = players[pKeys[1]];

  const activePoke1 = p1.team[p1.activePokemonIndex];
  const activePoke2 = p2.team[p2.activePokemonIndex];

  io.emit('battleUpdate', {
    p1: { name: p1.name, avatar: p1.avatar, poke: activePoke1 },
    p2: { name: p2.name, avatar: p2.avatar, poke: activePoke2 },
    attackerId: battleState.attackerId,
    defenderId: battleState.defenderId,
    log: logMessage,
    gameState
  });
}

function checkBattleTurn() {
  const attacker = players[battleState.attackerId];
  const defender = players[battleState.defenderId];

  if (attacker.currentChoice && defender.currentChoice) {
    const atkPoke = attacker.team[attacker.activePokemonIndex];
    const defPoke = defender.team[defender.activePokemonIndex];

    const isPhysicalAtk = attacker.currentChoice === 'physique';
    const isPhysicalDef = defender.currentChoice === 'physique';

    const atkStat = isPhysicalAtk ? atkPoke.stats.atk : atkPoke.stats.atk_spe;
    const defStat = isPhysicalDef ? defPoke.stats.def : defPoke.stats.def_spe;

    let damage = Math.max(10, atkStat - Math.floor(defStat / 2));
    defPoke.stats.hp = Math.max(0, defPoke.stats.hp - damage);

    let log = `${attacker.name} (${atkPoke.name}) lance une attaque ${attacker.currentChoice} ! ${damage} dégâts infligés.`;

    if (defPoke.stats.hp <= 0) {
      log += ` ${defender.name} : ${defPoke.name} est K.O. !`;
      defender.activePokemonIndex++;

      if (defender.activePokemonIndex >= defender.team.length) {
        log += ` 🎉 ${attacker.name} a remporté la victoire finale !`;
        gameState = 'GAME_OVER';
        return broadcastBattleState(log);
      }
    }

    const temp = battleState.attackerId;
    battleState.attackerId = battleState.defenderId;
    battleState.defenderId = temp;

    attacker.currentChoice = null;
    defender.currentChoice = null;

    broadcastBattleState(log);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur prêt sur le port ${PORT}`);
});