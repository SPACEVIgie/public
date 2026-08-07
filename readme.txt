=== S-PACE Réservation ===
Contributors: s-pace
Tags: réservation, salles, coworking
Requires at least: 5.5
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPLv2 or later

Tunnel de réservation en ligne pour S-PACE Business Center.

== Description ==

Ajoute le shortcode `[space_reservation]` : une salle de réunion ou un bureau peut être
réservé en ligne (recherche de disponibilité, options, devis ou paiement selon le profil
du client). Le plugin ne stocke aucune donnée — tout transite directement, depuis le
navigateur du visiteur, vers l'API S-RESA.

== Installation ==

1. Installer et activer le plugin.
2. Réglages > S-PACE Réservation : vérifier l'URL de l'API S-RESA (par défaut
   `https://portail.s-pace.fr/sresa/api`) et renseigner la clé d'API si S-PACE vous en a
   communiqué une (facultatif dans un premier temps).
3. Placer le shortcode `[space_reservation]` sur la page de réservation du site.

== Limites de la version actuelle ==

* Réservation sur une seule journée / demi-journée / plage horaire à la fois (pas de
  réservation multi-jours depuis le tunnel public — une telle demande passe par l'équipe,
  sans paiement en ligne).
* Prêt de matériel non proposé en ligne (nécessite une vérification côté S-PACE).

== Changelog ==

= 1.2.0 =
* Tarif affiché PAR SALLE : chaque espace proposé montre son propre prix, qui se recalcule à la
  sélection. Le surclassement (salle plus grande que le besoin) est signalé avec son tarif. Le prix
  affiché est le prix facturé (facturation ancrée côté serveur sur la taille réelle de la salle).
* Paiement en ligne par carte (Stripe) : proposé dès l'étape de choix lorsque le serveur l'autorise
  (réservation d'un seul jour, encaissement configuré). Parcours de paiement sécurisé intégré au
  tunnel. La disponibilité du paiement en ligne est décidée par le serveur, jamais figée dans le plugin.
* Message de prise en compte : si un conflit d'agenda est détecté à la confirmation, la demande est
  prise en compte et validée par l'équipe (plus jamais de refus sec en fin de parcours).
* Clé d'API par installation (réglage dédié) : identifie l'installation et protège l'API contre les
  usages abusifs. Facultative pendant la transition.

= 1.1.0 =
* Recherche et réservation : le créneau (matin / après-midi / journée / heures précises) est
  désormais transmis au backend. Les horaires de la journée et de la demi-journée ne sont plus
  codés en dur dans le tunnel : la grille horaire S-RESA (paramétrée côté serveur) fait foi.
* Nouveaux horaires alignés sur la grille S-RESA (journée 08:30–18:00, matin 08:30–12:30,
  après-midi 14:00–18:00) — récupérés du serveur (endpoint public /tunnel/creneaux) et affichés.
* Ajout du lien « Voir la salle » (nouvel onglet) sur chaque espace proposé, lorsqu'une fiche
  est renseignée.

= 1.0.1 =
* Transmission du créneau matin/après-midi lors de la réservation d'une demi-journée.

= 1.0.0 =
* Version initiale : tunnel de réservation + mises à jour automatiques depuis GitHub.
