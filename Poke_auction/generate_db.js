const axios = require('axios');
const fs = require('fs');

async function buildPokedex() {
    const pokedex = [];
    const MAX_POKEMON = 1025; // On peut monter à 1025 plus tard

    console.log("Début de la génération de la base de données...");

    for (let i = 1; i <= MAX_POKEMON; i++) {
        try {
            const res = await axios.get(`https://pokeapi.co/api/v2/pokemon/${i}`);
            const data = res.data;

            // Extraction des statistiques
            const stats = {
                hp: data.stats.find(s => s.stat.name === 'hp').base_stat,
                atk: data.stats.find(s => s.stat.name === 'attack').base_stat,
                def: data.stats.find(s => s.stat.name === 'defense').base_stat,
                spa: data.stats.find(s => s.stat.name === 'special-attack').base_stat,
                spd: data.stats.find(s => s.stat.name === 'special-defense').base_stat,
                spe: data.stats.find(s => s.stat.name === 'speed').base_stat,
            };

            const bst = stats.hp + stats.atk + stats.def + stats.spa + stats.spd + stats.spe;

            // Attribution automatique de la rareté
            let rarity = "Commun";
            if (bst >= 400) rarity = "Rare";
            if (bst >= 500) rarity = "Épique";
            if (bst >= 600) rarity = "Légendaire";

            // Déduction de l'Intelligence Artificielle (Le Rôle)
            let role = "Soutien"; 
            if ((stats.hp + stats.def + stats.spd) > (bst * 0.55)) {
                role = "Tank"; // Grosse majorité de stats défensives
            } else if (stats.spe > 100 && (stats.atk > 90 || stats.spa > 90)) {
                role = "Sniper"; // Rapide et tape fort
            } else if (stats.atk > 100 || stats.spa > 100) {
                role = "DPS"; // Dégâts lourds, moins rapide
            }

            pokedex.push({
                id: data.id,
                name: data.name,
                types: data.types.map(t => t.type.name),
                sprite: data.sprites.front_default, // ou le lien vers les sprites Showdown
                stats: stats,
                bst: bst,
                rarity: rarity,
                role: role
            });

            console.log(`Ajouté : ${data.name} (${role} - ${rarity})`);
        } catch (error) {
            console.error(`Erreur sur le Pokémon ${i}`);
        }
    }

    fs.writeFileSync('./pokedex.json', JSON.stringify(pokedex, null, 2));
    console.log("pokedex.json généré avec succès !");
}

buildPokedex();