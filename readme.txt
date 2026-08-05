=== S-PACE Réservation ===
Contributors: s-pace
Tags: réservation, salles, coworking
Requires at least: 5.5
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
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
   `https://portail.s-pace.fr/sresa/api`).
3. Placer le shortcode `[space_reservation]` sur la page de réservation du site.

== Limites de la version 1.0 ==

* Réservation sur une seule journée / demi-journée / plage horaire à la fois (pas de
  réservation multi-jours depuis le tunnel public).
* Le paiement en ligne par carte (PayZen) n'est pas encore disponible — seuls le devis,
  le crédit salle et la facturation fin de mois (pour les clients identifiés) le sont.
* Prêt de matériel non proposé en ligne (nécessite une vérification côté S-PACE).
