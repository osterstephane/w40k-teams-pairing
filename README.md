# Table de pairing 40K

Aide à la décision pour le **pairing des matchs par équipes de Warhammer 40,000** (3 à 8 joueurs), selon le *Warhammer 40,000 Teams Event Companion v1.0* de Games Workshop.

À partir de votre matrice d'estimations (BP attendus pour chaque matchup, éventuellement par layout A/B/C, avec une incertitude), l'outil vous dit à chaque étape du pairing :

- quel défenseur poser, quels attaquants envoyer, quel attaquant accepter et quel layout déclarer ;
- quand il faut **varier au hasard** (stratégie mixte) plutôt que jouer un choix fixe prévisible ;
- le **pire cas** de chaque option (si l'adversaire lit votre choix) et la meilleure réponse à une lecture de l'adversaire ;
- la projection du match : P(victoire / nul / défaite), BP attendus, points d'équipe attendus.

## Utilisation

En ligne (une fois GitHub Pages activé) : https://osterstephane.github.io/w40k-teams-pairing/

Sans connexion : ouvrez `dist/index.html` dans un navigateur. Le fichier est autonome et fonctionne hors ligne. Les données restent dans votre navigateur.

1. **Matrice** : taille d'équipe, ronde, objectif, puis saisissez ou collez la matrice depuis Google Sheets (copier/coller des cellules, noms compris). Une fois importée, la matrice reste modifiable : cliquez sur une case pour choisir le code et le scénario (stable, peut punir, peut se faire punir, chance, score) avec des boutons, sur un layout ou les trois.
2. **Pairing** : suivez les étapes. À chaque étape, saisissez les choix révélés. L'outil recalcule à partir de la situation réelle.

Formats de cellule acceptés :

- codes du **référentiel des estimés** : `FACILE`, `WIN`, `p_WIN`, `DRAW`, `p_LOSE`, `LOSE`, `ALED`, `GAMBLE`. `SAIS-PÔ` compte comme une estimation manquante. Le centre et l'écart-type de chaque code sont modifiables dans l'onglet Matrice. Un code peut porter un scénario : `p_WIN!` (« p_WIN stable, mais je peux punir une erreur adverse et aller chercher un gros score »), `WIN?` (« WIN, mais je peux me faire punir »), `p_WIN!40` (chance explicite de 40 %), `p_WIN!40_20` (40 % de chances de mettre un 20-0), `p_LOSE?50_3` (50 % de risque de ne marquer que 3 BP). Il peut aussi recevoir son propre écart-type : `p_WIN±5` ;
- BP : `12`, `12,5`, `12±4` (valeur ± incertitude en BP), `12 (4)`. Une autre échelle (par exemple -2 à +2) peut être convertie linéairement en BP dans les paramètres.

Import depuis Google Sheets par copier-coller, deux formats reconnus :

- **Matrice globale** : une ligne par joueur et par layout, avec une colonne « Layout » (Layout A / B / C) et les adversaires en colonnes. On peut coller tout l'onglet, titre compris ; les cellules sur deux lignes (« Joueur 1 / À renseigner ») sont gérées ;
- grille carrée simple (nos joueurs en lignes, les leurs en colonnes).

## Pairing par taille d'équipe (Teams Event Companion, section 2)

| Joueurs | Modules | Écart pour gagner |
|---|---|---|
| 3 | Main Engagement | 4 BP |
| 4 | Main Engagement + Champion | 6 BP |
| 5 | Initial Skirmish + Main Engagement | 6 BP |
| 6 | Initial Skirmish + Main Engagement + Champion | 8 BP |
| 7 | Initial Skirmish ×2 + Main Engagement | 10 BP |
| 8 | Initial Skirmish ×2 + Main Engagement + Champion | 12 BP |

Le format 6 joueurs est prévu par le document officiel : c'est le 8 joueurs avec une Initial Skirmish en moins.

## Choisir le « meilleur chemin »

Le critère est réglable dans l'onglet Matrice :

- **Gagner le match** (curseur à 0 %) : maximise P(victoire) + valeur du nul × P(nul). Avec le barème 3/2/1 (nul = 0,5), cela revient à maximiser les points d'équipe attendus. Ce critère gère le risque tout seul : favori, il cherche la sécurité ; outsider, il cherche la variance.
- **Maximiser l'écart** (curseur à 100 %) : maximise les BP attendus (utile pour les départages aux BP).
- **Valeur d'un nul** : 0 si seule la victoire compte (il faut gagner pour rester en tête), 1 si un nul suffit.

Détails du modèle et simplifications : [docs/MODEL.md](docs/MODEL.md).

## Publication GitHub Pages

Settings → Pages → *Build and deployment* : Source « Deploy from a branch », branche `main`, dossier `/ (root)`. Le site sert `index.html` et les modules de `src/` directement, sans étape de build.

## Développement

```sh
npm test          # tests (node >= 20, aucune dépendance)
npm run build     # régénère dist/index.html et dist/artifact.html
npm run bench     # temps de calcul du pairing complet à 8 joueurs
```

Pour développer sur les sources (`index.html` + `src/*.js`), servez le dossier en HTTP (par exemple `python3 -m http.server`), car les modules ES ne se chargent pas en `file://`.

| Fichier | Rôle |
|---|---|
| `src/rules.js` | Données des règles (modules, barème BP, seuils, layouts par ronde) |
| `src/matrixgame.js` | Résolution des jeux matriciels à somme nulle (simplexe) |
| `src/engine.js` | Arbre de pairing, objectif, mémoïsation |
| `src/pairing.js` | Machine d'états du pairing réel |
| `src/advisor.js` | Recommandations pour l'étape en cours |
| `src/matrix.js` | Import de matrice depuis un tableur |
| `src/ui.js`, `index.html` | Interface |
| `src/worker.js` | Calcul en arrière-plan (Web Worker) |
