# S-PACE Réservation — plugin WordPress

Tunnel de réservation en ligne pour **S-PACE Business Center** — trois shortcodes :
`[space_reservation]` (le tunnel), `[space_mon_espace]` (l'espace client complet, sur le site) et
`[space_disponibilite]` (la prochaine date libre d'une salle). Le plugin ne stocke aucune donnée :
tout transite depuis le navigateur du visiteur vers l API publique S-RESA
(`https://portail.s-pace.fr/sresa/api`).

## Installation
Téléverser le zip de la dernière [release](../../releases) dans **Extensions → Ajouter → Téléverser une extension**,
puis activer. Réglages → S-PACE Réservation pour vérifier l URL de l API, et renseigner l URL de la
page qui porte `[space_mon_espace]` (sinon le lien « Déjà client ? » du tunnel renvoie vers l ancien
espace client, sur un autre domaine). Placer `[space_reservation]` sur une page.

## Mises à jour automatiques
Le plugin embarque un vérificateur de mises à jour : chaque nouvelle **release** (ou tag `vX.Y.Z`) de ce dépôt
apparaît comme mise à jour dans l administration WordPress (Extensions), installable en un clic.

## Licence
GPLv2 or later.
