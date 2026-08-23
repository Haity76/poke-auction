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

// Variables pour le combat tour par tour
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
      budget: players[id].budget,
      team: players[id].team
    };
  }
  return result;
}

io.on('connection', (socket) => {
  const playerIds = Object.keys(players);
  if (playerIds.length < 2) {
    const pName = playerIds.length === 0 ? 'Joueur 1' : 'Joueur 2';
    players[socket.id] = {
      id: socket.id,
      name: pName,
      budget: 900,
      team: [],
      currentChoice: null,
      activePokemonIndex: 0
    };
    socket.emit('roleAssignment', { role: 'player', id: socket.id, name: pName });
  } else {
    socket.emit('roleAssignment', { role: 'spectator', id: socket.id });
  }

  io.emit('updateGameState', { gameState, players: getSanitizedPlayers() });

  if (Object.keys(players).length === 2 && gameState === 'LOBBY') {
    startAuctionRound();
  }

  socket.on('placeBid', () => {
    const player = players[socket.id];
    if (!player || gameState !== 'AUCTION') return;
    
    // Un joueur avec 3 Pokémon ne participe plus
    if (player.team.length >= 3) return;

    const newAmount = currentBid.amount + 50;
    if (newAmount <= player.budget) {
      currentBid = { playerId: socket.id, amount: newAmount, playerName: player.name };
      timeLeft = 15; // Reset du timer à chaque mise
      io.emit('bidUpdated', { currentBid, timeLeft });
    }
  });

  socket.on('submitBattleAction', (choice) => {
    if (players[socket.id] && gameState === 'BATTLE') {
      players[socket.id].currentChoice = choice;
      checkBattleTurn();
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      gameState = 'LOBBY';
      clearInterval(auctionTimer);
      io.emit('playerDisconnected');
      io.emit('updateGameState', { gameState, players: getSanitizedPlayers() });
    }
  });
});

async function startAuctionRound() {
  const pKeys = Object.keys(players);
  if (pKeys.length < 2) return;

  const p1 = players[pKeys[0]];
  const p2 = players[pKeys[1]];

  // Si les deux ont 3 Pokémon -> Début du combat
  if (p1.team.length >= 3 && p2.team.length >= 3) {
    return startBattle();
  }

  // Si l'un des joueurs a déjà 3 Pokémon, l’enchère s'arrête et l'autre prend automatiquement les restants
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
  
  // Pile ou face pour le premier attaquant
  const firstAttackerIndex = Math.random() < 0.5 ? 0 : 1;
  battleState.attackerId = pKeys[firstAttackerIndex];
  battleState.defenderId = pKeys[firstAttackerIndex === 0 ? 1 : 0];
  battleState.turn = 1;

  broadcastBattleState("Le combat commence ! Pile ou face : " + players[battleState.attackerId].name + " attaque en premier !");
}

function broadcastBattleState(logMessage) {
  const pKeys = Object.keys(players);
  const p1 = players[pKeys[0]];
  const p2 = players[pKeys[1]];

  const activePoke1 = p1.team[p1.activePokemonIndex];
  const activePoke2 = p2.team[p2.activePokemonIndex];

  io.emit('battleUpdate', {
    p1: { name: p1.name, poke: activePoke1, teamLeft: p1.team.filter(p => p.stats.hp > 0).length },
    p2: { name: p2.name, poke: activePoke2, teamLeft: p2.team.filter(p => p.stats.hp > 0).length },
    attackerId: battleState.attackerId,
    defenderId: battleState.defenderId,
    log: logMessage
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

    // Si le Pokémon adverse est K.O.
    if (defPoke.stats.hp <= 0) {
      log += ` ${defender.name} : ${defPoke.name} est K.O. !`;
      defender.activePokemonIndex++;

      // Vérifier si défaite totale
      if (defender.activePokemonIndex >= defender.team.length) {
        log += ` 🎉 ${attacker.name} a remporté la victoire finale !`;
        gameState = 'GAME_OVER';
        io.emit('gameOver', { winnerName: attacker.name });
        return broadcastBattleState(log);
      }
    }

    // Inversion des rôles pour le prochain tour
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