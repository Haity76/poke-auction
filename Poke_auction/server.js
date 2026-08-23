const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = {};
let gameState = 'LOBBY'; // LOBBY, AUCTION, BATTLE
let currentPokemon = null;
let currentBid = { playerId: null, amount: 0 };
let auctionTimer = null;

// Dictionnaire de traduction des couleurs de PokéAPI vers le français
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

// Fonction pour récupérer un Pokémon aléatoire et sa couleur via PokéAPI
async function getRandomPokemon() {
  const id = Math.floor(Math.random() * 898) + 1;
  try {
    const pokeRes = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const speciesRes = await axios.get(`https://pokeapi.co/api/v2/pokemon-species/${id}`);

    // Récupération du nom en français
    const nameFr = speciesRes.data.names.find(n => n.language.name === 'fr')?.name || pokeRes.data.name;

    // Récupération de la couleur principale officielle
    const colorRaw = speciesRes.data.color.name;
    const colorFr = colorTranslations[colorRaw] || colorRaw;

    return {
      id,
      name: nameFr,
      color: colorFr,
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
    socket.emit('playerAssignment', { id: socket.id, budget: 1000 });
  } else {
    socket.emit('errorMsg', 'La partie est complète.');
    return;
  }

  if (Object.keys(players).length === 2 && gameState === 'LOBBY') {
    startAuctionRound();
  }

  // Gestion des enchères
  socket.on('placeBid', (amount) => {
    const player = players[socket.id];
    if (gameState === 'AUCTION' && amount > currentBid.amount && amount <= player.budget) {
      currentBid = { playerId: socket.id, amount };
      io.emit('bidUpdated', currentBid);
    }
  });

  // Gestion des choix d'attaque et de défense
  socket.on('submitAction', (choice) => {
    if (players[socket.id]) {
      players[socket.id].currentChoice = choice; // ex: { stat: 'physique' } ou { stat: 'special' }
      checkBattleTurn();
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    gameState = 'LOBBY';
    io.emit('playerDisconnected');
  });
});

async function startAuctionRound() {
  gameState = 'AUCTION';
  currentBid = { playerId: null, amount: 0 };
  currentPokemon = await getRandomPokemon();

  if (!currentPokemon) {
    // En cas de problème API, réessaie
    return startAuctionRound();
  }

  // On transmet SEULEMENT la couleur (pas d'image/sprite)
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
    // On envoie seulement l'ID du gagnant et le prix, pas le nom !
    io.emit('auctionEnded', { winnerId: currentBid.playerId, price: currentBid.amount });
  } else {
    io.emit('auctionEnded', { winnerId: null });
  }

  const pKeys = Object.keys(players);
  if (players[pKeys[0]].team.length >= 1 && players[pKeys[1]].team.length >= 1) {
    startBattle();
  } else {
    setTimeout(startAuctionRound, 3000);
  }
}

function startBattle() {
  gameState = 'BATTLE';
  const pKeys = Object.keys(players);
  io.emit('startBattle', {
    p1: { id: pKeys[0], pokeName: players[pKeys[0]].team[0].name, stats: players[pKeys[0]].team[0].stats },
    p2: { id: pKeys[1], pokeName: players[pKeys[1]].team[0].name, stats: players[pKeys[1]].team[0].stats }
  });
}

function checkBattleTurn() {
  const pKeys = Object.keys(players);
  const p1 = players[pKeys[0]];
  const p2 = players[pKeys[1]];

  if (p1.currentChoice && p2.currentChoice) {
    const poke1 = p1.team[0];
    const poke2 = p2.team[0];

    // Détermination du joueur le plus rapide
    let attacker = poke1.stats.speed >= poke2.stats.speed 
      ? { player: p1, poke: poke1, defender: p2, defPoke: poke2 } 
      : { player: p2, poke: poke2, defender: p1, defPoke: poke1 };

    const atkStat = attacker.player.currentChoice.stat === 'physique' ? attacker.poke.stats.atk : attacker.poke.stats.atk_spe;
    const defStat = attacker.defender.currentChoice.stat === 'physique' ? attacker.defPoke.stats.def : attacker.defPoke.stats.def_spe;

    let damage = atkStat - defStat;
    if (damage <= 0) damage = 5; // Dégâts minimums pour débloquer le combat

    attacker.defPoke.stats.hp -= damage;

    io.emit('turnResult', {
      attackerId: attacker.player.id,
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

server.listen(3000, () => {
  console.log('Serveur démarré sur http://localhost:3000');
});