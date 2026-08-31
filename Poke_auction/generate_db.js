const axios = require('axios');
const fs = require('fs');

const colorTranslations = { black: 'Noir', blue: 'Bleu', brown: 'Brun / Marron', gray: 'Gris', green: 'Vert', pink: 'Rose', purple: 'Violet', red: 'Rouge', white: 'Blanc', yellow: 'Jaune' };
const typeTranslations = { normal: 'Normal', fighting: 'Combat', flying: 'Vol', poison: 'Poison', ground: 'Sol', rock: 'Roche', bug: 'Insecte', ghost: 'Spectre', steel: 'Acier', fire: 'Feu', water: 'Eau', grass: 'Plante', electric: 'Électrik', psychic: 'Psy', ice: 'Glace', dragon: 'Dragon', dark: 'Ténèbres', fairy: 'Fée' };

const MAX_POKEMON = 1025; // Mets 1025 si tu veux toutes les générations !

async function generatePokedex() {
  const pokedex = [];
  console.log(`Début du téléchargement de ${MAX_POKEMON} Pokémon...`);

  for (let id = 1; id <= MAX_POKEMON; id++) {
    try {
      const [pokeRes, speciesRes] = await Promise.all([
        axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`),
        axios.get(`https://pokeapi.co/api/v2/pokemon-species/${id}`)
      ]);

      const nameFr = speciesRes.data.names.find(n => n.language.name === 'fr')?.name || pokeRes.data.name;
      const colorRaw = speciesRes.data.color.name;
      const colorFr = colorTranslations[colorRaw] || colorRaw;
      
      const typesRaw = pokeRes.data.types.map(t => t.type.name);
      const typesFr = typesRaw.map(t => typeTranslations[t] || t);

      const sprite = pokeRes.data.sprites.other['official-artwork'].front_default || pokeRes.data.sprites.front_default;
      
      // AJOUT DE LA TAILLE ET DU POIDS (Format brut de l'API)
      const height = pokeRes.data.height; 
      const weight = pokeRes.data.weight;

      pokedex.push({
        id: id,
        name: nameFr,
        color: colorFr,
        types: typesFr,
        height: height,
        weight: weight,
        sprite: sprite
      });

      console.log(`[${id}/${MAX_POKEMON}] ${nameFr} enregistré !`);
      
      await new Promise(resolve => setTimeout(resolve, 50));

    } catch (err) {
      console.error(`❌ Erreur lors du téléchargement du Pokémon ${id}:`, err.message);
    }
  }

  fs.writeFileSync('./pokedex.json', JSON.stringify(pokedex, null, 2), 'utf-8');
  console.log('\n✅ Fichier pokedex.json généré avec succès ! Le fichier est prêt.');
}

generatePokedex();