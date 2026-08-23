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

const colorTranslations = {
  black: 'Noir',
  blue: 'Bleu',
  brown: 'Brun / Marron',
  gray: 'Gris',
  green: 'Vert',
  pink: 'Rose',
  purple: 'Violet',
  red: 'Rouge',
  white: 'Blanc',
  yellow: 'Jaune'
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
    console.error('Erreur PokéAPI:', err.message);
    return null;
  }
}

io.on('connection', (socket) => {
  if (Object.keys(players).length < 2) {
    players[socket.id] = { id: socket.id, budget: 1000, team: [], currentChoice: null };
    socket.emit('roleAssignment', { role: 'player', id: socket.id });
  } else {
    socket.emit('roleAssignment', { role: 'spectator', id: socket.id });
  }

  if (Object.keys(players).length === 2 && gameState === 'LOBBY') {
    startAuctionRound();
  }

  socket.on('placeBid', (amount) => {
    const player = players[socket.id];
    if (player && gameState === 'AUCTION' && amount > currentBid.amount && amount <= player.budget) {
      currentBid = { playerId: socket.id, amount };
      io.emit('bidUpdated', currentBid);
    }
  });

  socket.on('submitAction', (choice) => {
    if (players[socket.id]) {
      players[socket.id].currentChoice = choice;
      checkBattleTurn();
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      gameState = 'LOBBY';
      io.emit('playerDisconnected');
    }
  });
});

async function startAuctionRound() {
  gameState = 'AUCTION';
  currentBid = { playerId: null, amount: 0 };
  currentPokemon = await getRandomPokemon();

  if (!currentPokemon) return startAuctionRound();

  io.emit('newAuction', { color: currentPokemon.color });

  let timeLeft = 10;
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
    io.emit('auctionEnded', { winnerId: currentBid.playerId, price: currentBid.amount });
  } else {
    io.emit('auctionEnded', { winnerId: null });
  }

  const pKeys = Object.keys(players);
  if (pKeys.length === 2 && players[pKeys[0]].team.length >= 1 && players[pKeys[1]].team.length >= 1) {
    startBattle();
  } else {
    setTimeout(startAuctionRound, 3000);
  }
}

function startBattle() {
  gameState = 'BATTLE';
  const pKeys = Object.keys(players);
  io.emit('startBattle', {
    p1Name: players[pKeys[0]].team[0].name,
    p2Name: players[pKeys[1]].team[0].name
  });
}

function checkBattleTurn() {
  const pKeys = Object.keys(players);
  const p1 = players[pKeys[0]];
  const p2 = players[pKeys[1]];

  if (p1.currentChoice && p2.currentChoice) {
    const poke1 = p1.team[0];
    const poke2 = p2.team[0];

    let attacker = poke1.stats.speed >= poke2.stats.speed 
      ? { player: p1, poke: poke1, defender: p2, defPoke: poke2 } 
      : { player: p2, poke: poke2, defender: p1, defPoke: poke1 };

    const atkStat = attacker.player.currentChoice.stat === 'physique' ? attacker.poke.stats.atk : attacker.poke.stats.atk_spe;
    const defStat = attacker.defender.currentChoice.stat === 'physique' ? attacker.defPoke.stats.def : attacker.defPoke.stats.def_spe;

    let damage = atkStat - defStat;
    if (damage <= 0) damage = 5;

    attacker.defPoke.stats.hp -= damage;

    io.emit('turnResult', {
      attackerPoke: attacker.poke.name,
      defenderPoke: attacker.defPoke.name,
      damage,
      p1Hp: Math.max(0, p1.team[0].stats.hp),
      p2Hp: Math.max(0, p2.team[0].stats.hp)
    });

    p1.currentChoice = null;
    p2.currentChoice = null;
  }
}

// Configuration dynamique du port pour hébergement (Render, Heroku, etc.)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});