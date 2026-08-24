=== S-PACE Réservation ===
Contributors: s-pace
Tags: réservation, salles, coworking
Requires at least: 5.5
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.4.0
License: GPLv2 or later

Tunnel de réservation en ligne pour S-PACE Business Center.

== Description ==

Ajoute le shortcode `[space_reservation]` : une salle de réunion ou un bureau peut être
réservé en ligne (recherche de disponibilité, options, devis ou paiement selon le profil
du client). Ajoute aussi `[space_mon_espace]` : une carte d'accès à l'espace client
(retrouver ses réservations, sans intention de réserver). Le plugin ne stocke aucune
donnée — tout transite directement, depuis le navigateur du visiteur, vers l'API S-RESA.

== Installation ==

1. Installer et activer le plugin.
2. Réglages > S-PACE Réservation : vérifier l'URL de l'API S-RESA (par défaut
   `https://portail.s-pace.fr/sresa/api`) et renseigner la clé d'API si S-PACE vous en a
   communiqué une (facultatif dans un premier temps).
3. Placer le shortcode `[space_reservation]` sur la page de réservation du site.
4. Placer le shortcode `[space_mon_espace]` sur une page dédiée (ex. « Mon espace »), et
   ajouter cette page au menu du site si elle doit être visible en dehors du tunnel de
   réservation.

== Limites de la version actuelle ==

* Réservation sur une seule journée / demi-journée / plage horaire à la fois (pas de
  réservation multi-jours depuis le tunnel public — une telle demande passe par l'équipe,
  sans paiement en ligne).
* Prêt de matériel non proposé en ligne (nécessite une vérification côté S-PACE).

== Changelog ==

= 1.4.0 =
* Nouveau shortcode `[space_mon_espace]` : carte d'accès à l'espace client (« Mon espace »),
  destinée à une page dédiée du site — visible sans intention de réserver. Même mécanisme
  d'identification que le tunnel (email → lien de connexion valable 2 heures, aucun mot de
  passe) : un simple lien vers l'espace client S-RESA existant, aucune logique dupliquée.
* Tunnel : lien « Déjà client ? Retrouvez vos réservations » ajouté dès l'étape 1 (Recherche)
  — jusqu'ici l'identification n'était proposée qu'à l'étape 4 (Paiement).

= 1.3.1 =
* Correctif — le montant affiché au récapitulatif et à l'étape de paiement par carte ne portait que
  la salle : les options choisies (pauses, restauration, aménagement) n'étaient jamais ajoutées à
  l'écran, alors que le serveur les facture bien (Stripe débite déjà salle + options). Le client
  voyait donc un total plus bas que ce qui était réellement débité sur sa carte. Corrigé : le total
  affiché inclut désormais les options, avec le détail des deux lignes (Salle / Options) au
  récapitulatif dès qu'une option est sélectionnée.

= 1.3.0 =
* Règles horaires servies par le serveur (aucune valeur en dur dans le plugin) : le pas des créneaux
  « heures précises » suit le réglage S-RESA (par défaut 15 minutes) ; modifier ce réglage se propage
  sans redéployer le plugin.
* Le POURQUOI du paiement, dès le choix : lorsque le paiement en ligne n'est pas proposé (créneau
  hors horaires d'accueil, départ à moins du délai minimum, créneau déjà retenu, réservation
  multi-jours), le motif décidé par le serveur est affiché immédiatement à l'étape du choix — plus de
  découverte en fin de parcours. Créneau hors horaires : le message d'accès autonome et le supplément
  estimé sont indiqués ; départ trop proche : message avec le numéro de téléphone. Hors-horaires ET
  délai court se combinent en une seule phrase cohérente.
* Formulaire de paiement par carte prérempli : nom, email et téléphone déjà saisis à l'étape
  précédente sont repris dans le module Stripe, pour éviter une double saisie.

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
