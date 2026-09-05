class AutoBattler {
    constructor(playerTeam, stage) {
        this.stage = stage; // Ex: { world: 1, level: 10, isBoss: true }
        
        // On clone l'équipe du joueur pour ne pas modifier la base de données
        // Chaque unité commence avec 0 en Jauge d'Action
        this.playerTeam = playerTeam.map(p => ({ ...p, currentHp: p.hpMax, actionGauge: 0 }));
        
        // On génère la vague ennemie selon le niveau du Stage
        this.enemyTeam = this.generateWave(stage);
        
        this.combatLog = [];
        this.state = 'PLAYING'; // PLAYING, VICTORY, DEFEAT
    }

    generateWave(stage) {
        // Logique de génération. Si c'est un niveau multiple de 10, c'est un Boss !
        if (stage.level % 10 === 0) {
            return [{
                id: 'boss_1', name: 'Dracaufeu Corrompu', role: 'Boss', position: 'front',
                currentHp: 5000, hpMax: 5000, attack: 150, defense: 80, speed: 90, actionGauge: 0
            }];
        } else {
            // Vague standard (ex: 2 petits ennemis)
            const multiplier = 1 + (stage.world * 0.2) + (stage.level * 0.1);
            return [
                { id: 'mob_1', name: 'Rattata Sauvage', role: 'DPS', position: 'front', currentHp: 200 * multiplier, hpMax: 200 * multiplier, attack: 30 * multiplier, defense: 10, speed: 110, actionGauge: 0 },
                { id: 'mob_2', name: 'Roucool Sauvage', role: 'DPS', position: 'back', currentHp: 150 * multiplier, hpMax: 150 * multiplier, attack: 40 * multiplier, defense: 5, speed: 130, actionGauge: 0 }
            ];
        }
    }

    // Le "Tick" est appelé par le serveur toutes les X millisecondes (ex: toutes les 1 seconde)
    tick() {
        if (this.state !== 'PLAYING') return this.state;

        const allFighters = [...this.playerTeam, ...this.enemyTeam].filter(f => f.currentHp > 0);

        // 1. Remplissage des Jauges d'Action selon la Vitesse
        allFighters.forEach(fighter => {
            // Un Pokémon avec 100 de vitesse gagnera 20 points de jauge par tick.
            fighter.actionGauge += (fighter.speed / 5); 
        });

        // 2. On trie pour voir qui a la jauge la plus remplie (>= 100)
        const readyFighters = allFighters.filter(f => f.actionGauge >= 100).sort((a, b) => b.actionGauge - a.actionGauge);

        // 3. Résolution des attaques
        readyFighters.forEach(attacker => {
            if (attacker.currentHp <= 0 || this.state !== 'PLAYING') return; // S'il est mort pendant ce même tick, il n'attaque pas

            const isPlayer = this.playerTeam.includes(attacker);
            const targetTeam = isPlayer ? this.enemyTeam : this.playerTeam;
            
            // Ciblage : On cherche d'abord en "front", sinon en "back"
            let target = targetTeam.find(t => t.currentHp > 0 && t.position === 'front');
            if (!target) target = targetTeam.find(t => t.currentHp > 0 && t.position === 'back');

            if (target) {
                // Formule de dégâts JRPG classique
                let damage = Math.max(1, Math.floor(attacker.attack - (target.defense * 0.5)));
                target.currentHp -= damage;
                
                this.combatLog.push(`${attacker.name} attaque ${target.name} et inflige ${damage} dégâts !`);

                // Reset de la jauge après l'attaque
                attacker.actionGauge = 0; 
            }

            this.checkWinCondition();
        });

        return {
            state: this.state,
            playerTeam: this.playerTeam,
            enemyTeam: this.enemyTeam,
            log: this.combatLog
        };
    }

    checkWinCondition() {
        const isPlayerDead = this.playerTeam.every(p => p.currentHp <= 0);
        const isEnemyDead = this.enemyTeam.every(e => e.currentHp <= 0);

        if (isEnemyDead) {
            this.state = 'VICTORY';
            this.combatLog.push(`Victoire ! Le Stage ${this.stage.world}-${this.stage.level} est nettoyé.`);
        } else if (isPlayerDead) {
            this.state = 'DEFEAT';
            this.combatLog.push(`Défaite... L'équipe a été anéantie.`);
        }
    }
}

module.exports = AutoBattler;