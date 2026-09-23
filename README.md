# Table de pairing 40K

Aide à la décision pour le **pairing des matchs par équipes de Warhammer 40,000** (3 à 8 joueurs), selon le *Warhammer 40,000 Teams Event Companion v1.0* de Games Workshop.

À partir de votre matrice d'estimations (BP attendus pour chaque matchup, éventuellement par layout A/B/C, avec une incertitude), l'outil vous dit à chaque étape du pairing :

- quel défenseur poser, quels attaquants envoyer, quel attaquant accepter et quel layout déclarer ;
- quand il faut **varier au hasard** (stratégie mixte) plutôt que jouer un choix fixe prévisible ;
- le **pire cas** de chaque option (si l'adversaire lit votre choix) et la meilleure réponse à une lecture de l'adversaire ;
- la projection du match : P(victoire / nul / défaite), BP attendus, points d'équipe attendus.

## Utilisation

Ouvrez `dist/index.html` dans un navigateur. Le fichier est autonome et fonctionne hors ligne. Les données restent dans votre navigateur.

1. **Matrice** : taille d'équipe, ronde, objectif, puis saisissez ou collez la matrice depuis Google Sheets (copier/coller des cellules, noms compris).
2. **Pairing** : suivez les étapes. À chaque étape, saisissez les choix révélés. L'outil recalcule à partir de la situation réelle.

Formats de cellule acceptés : `12`, `12,5`, `12±4` (valeur ± incertitude en BP), `12 (4)`. Une autre échelle (par exemple -2 à +2) peut être convertie linéairement en BP dans les paramètres.

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
