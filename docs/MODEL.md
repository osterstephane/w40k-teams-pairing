# Modèle de décision

## Source des règles

*Warhammer 40,000 Teams Event Companion*, version 1.0 (Games Workshop) :

- section 2 « Pairing System » : modules Initial Skirmish, Main Engagement, Champion System, et leur usage selon la taille des équipes ;
- section 14 « Team Scoring » : barème VP → BP (somme 20 par partie), écart minimum pour gagner (4/6/6/8/10/12 BP de 3 à 8 joueurs), points d'équipe 3/2/1.

Les données sont dans `src/rules.js` et testées dans `test/rules.test.js`.

## Déroulé d'un module (Initial Skirmish / Main Engagement)

1. Chaque équipe choisit secrètement un défenseur. Révélation simultanée.
2. Chaque équipe choisit secrètement deux attaquants contre le défenseur adverse. Révélation simultanée.
3. Chaque équipe choisit secrètement lequel des deux attaquants adverses son défenseur affronte. Révélation simultanée : deux matchs.
4. Chaque défenseur déclare le layout de sa partie.
5. Initial Skirmish : les attaquants refusés retournent dans le groupe. Main Engagement : les attaquants refusés jouent l'un contre l'autre, sur le layout imposé par la ronde (A, B, C, puis on recommence).

Champion System : le dernier joueur de chaque équipe, même layout que les refusés.

## Modélisation

- `mu[l][a][b]` : BP attendus pour notre joueur `a` contre leur joueur `b` sur le layout `l`.
- `sd[l][a][b]` : écart-type de ce résultat (incertitude de l'estimation plus variance des dés).
- Les parties sont supposées indépendantes, donc le total de l'équipe suit approximativement N(Σmu, Σsd²). Avec 8 parties bornées à 0–20, l'approximation normale est raisonnable.
- Victoire si notre total ≥ 10n + Y/2, défaite si ≤ 10n − Y/2, nul sinon (Y = écart requis). Une correction de continuité de 0,5 BP est appliquée, car les BP sont entiers.

## Référentiel des estimés

Les codes de la matrice d'équipe sont convertis en (centre, écart-type) en BP. Centres : ceux du tableur de l'équipe. Écarts-types par défaut : **proposition de l'outil**, à ajuster dans l'onglet Matrice. Ils traduisent les mentions du tableur (« faible risque », « variance faible », « forte variance ») :

| Code | Plage BP | Centre | Écart-type par défaut |
|---|---|---|---|
| FACILE | 15–20 | 17 | 3 |
| WIN | 13–15 | 14 | 3 |
| p_WIN | 11–13 | 12 | 3 |
| DRAW | 9–11 | 10 | 2,5 |
| p_LOSE | 7–9 | 8 | 3 |
| LOSE | 5–7 | 6 | 3 |
| ALED | 0–5 | 3 | 3 |
| GAMBLE | 5–15 | 10 | 5 |

`SAIS-PÔ` (estimation manquante) est compté comme DRAW (10 BP, incertitude par défaut) et signalé dans l'interface.

### Punir / se faire punir

Un joueur peut indiquer qu'un résultat est stable, mais qu'un scénario plus rare change tout :

- `p_WIN!` : p_WIN stable, avec une chance de **punir** une erreur adverse et d'aller chercher un gros score ;
- `WIN?` : WIN, avec un risque de **se faire punir** ;
- `p_WIN!40` : même chose avec une chance explicite de 40 %.

Réglages par défaut (onglet Matrice) : 25 % de chances, 18 ± 2 BP quand on punit, 3 ± 2 BP quand on se fait punir. Ce sont des **choix de l'outil**, à ajuster par l'équipe.

La partie a alors deux issues : le résultat du code (probabilité 1 − p) ou le scénario (probabilité p). Le moteur la représente par sa moyenne et son écart-type exacts :

```
moyenne = (1 − p)·c + p·h
variance = (1 − p)(s² + c²) + p(sh² + h²) − moyenne²
```

Exemple : `p_WIN!` = 12 ± 3 à 75 %, 18 ± 2 à 25 %, soit 13,5 BP de moyenne, avec un écart-type plus large.

Cette approximation est précise au niveau du match : la victoire dépend de la somme des 6 à 8 parties. Sur un match à 8 joueurs, l'écart entre la probabilité de victoire exacte et celle du moteur reste sous 0,5 point (test `a punish swing is well approximated…`). Ignorer ce potentiel, en notant un simple p_WIN, sous-estimerait la probabilité de victoire de 6 à 8 points dans ce même exemple.

## Objectif

```
obj = (1 − w_marge) × (P(V) + v_nul × P(N)) + w_marge × E[BP] / (20n)
```

- `w_marge = 0`, `v_nul = 0,5` : maximise les points d'équipe attendus (E[TP] = 1 + 2·obj).
- `w_marge = 1` : maximise les BP attendus. L'objectif est alors linéaire.

Chaque choix simultané est résolu comme un **jeu à somme nulle** : nous maximisons `obj`, l'adversaire le minimise. Pour `v_nul = 0,5`, c'est exactement un jeu à somme nulle (ses points d'équipe valent 4 − les nôtres). Pour les autres valeurs, la stratégie calculée est notre stratégie de sécurité (ce qu'on garantit face à l'adversaire le plus défavorable).

La résolution se fait par récurrence arrière sur tout l'arbre :

- étape 3 : jeu 2×2 (solution fermée) ;
- étape 2 : jeu C(k−1,2) × C(k−1,2), jusqu'à 21×21 à 8 joueurs (simplexe) ;
- étape 1 : jeu k×k.

Les stratégies mixtes sont réelles : quand un choix fixe se fait contrer, la bonne décision est de tirer au sort selon les proportions indiquées.

## Simplifications

1. **Layout dans l'anticipation** : pour les modules futurs, chaque défenseur est supposé choisir le layout qui maximise l'espérance de BP de son camp. À l'étape réelle des layouts, l'outil évalue nos trois layouts sur l'objectif complet, et le layout réellement déclaré est utilisé ensuite.
2. **Grille de mémoïsation** : au début de chaque module, la moyenne et la variance cumulées sont arrondies (0,5 BP et 4 BP² en standard, 1 BP et 8 BP² en mode rapide) pour réutiliser les sous-arbres. L'erreur mesurée sur le score est inférieure à 1 point sur 100. Les tests comparent le moteur à une recherche exhaustive sans arrondi sur 3, 4 et 5 joueurs.
3. **Indépendance des parties** : pas de corrélation (par exemple, toute l'équipe sous-estimée d'un coup).

## Performance

Pairing complet (Node 22, un cœur) :

- 6 joueurs : environ 0,1 s ;
- 8 joueurs : environ 20 s en standard, environ 12 s en mode rapide (compter jusqu'à 40 s dans un navigateur).

Le calcul n'a lieu qu'une fois par matrice. Les étapes suivantes réutilisent le cache.
