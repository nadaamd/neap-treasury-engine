# Moteur quantitatif (L2)

Fonction pure, sans I/O — exécutable dans le handler CRE ou dans un runner local (D9).

- `flows/`  prévision des flux nets par corridor
- `risk/`   volatilité EWMA, covariance Ledoit-Wolf, ES 97.5 % par FHS
- `bands/`  résolution des bandes (Monte-Carlo warm-starté par Miller-Orr)
- `policy/` fonction objectif J et règle de décision
