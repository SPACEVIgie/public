=== S-PACE Réservation ===
Contributors: s-pace
Tags: réservation, salles, coworking
Requires at least: 5.5
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.7.1
License: GPLv2 or later

Tunnel de réservation en ligne pour S-PACE Business Center.

== Description ==

Ajoute le shortcode `[space_reservation]` : une salle de réunion ou un bureau peut être
réservé en ligne (recherche de disponibilité, options, devis ou paiement selon le profil
du client). Ajoute aussi `[space_mon_espace]` : l'espace client complet, sur le site
(email → lien reçu → liste des réservations → détail → demande d'annulation). Ajoute enfin
`[space_disponibilite]` : sur la page d'une salle, la prochaine date libre pour une durée
choisie. Le plugin ne stocke aucune donnée — tout transite directement, depuis le
navigateur du visiteur, vers l'API S-RESA.

== Installation ==

1. Installer et activer le plugin.
2. Réglages > S-PACE Réservation : vérifier l'URL de l'API S-RESA (par défaut
   `https://portail.s-pace.fr/sresa/api`) et renseigner la clé d'API si S-PACE vous en a
   communiqué une (facultatif dans un premier temps).
3. Placer le shortcode `[space_reservation]` sur la page de réservation du site.
4. Placer le shortcode `[space_mon_espace]` sur une page dédiée (ex. « Mon espace »), et
   ajouter cette page au menu du site. Renseigner ensuite « URL de l'espace client » dans
   les réglages du plugin avec l'URL de CETTE page (sinon le lien « Déjà client ? » du
   tunnel renvoie vers l'ancien espace client, sur un autre domaine).
5. Optionnel : placer `[space_disponibilite salle="CODE"]` sur la page d'une salle — le
   `CODE` et le shortcode prêt à copier de chaque salle réservable sont listés dans les
   réglages du plugin, section « Salles réservables ». Avec l'attribut `tunnel="URL"`
   pointant vers la page du shortcode `[space_reservation]`, le bouton « Réserver cette
   date » fonctionne.
6. Renseigner « URL de la page de réservation » dans les réglages avec l'URL de la page du
   shortcode `[space_reservation]` : le bouton « + Nouvelle réservation » de
   `[space_mon_espace]` s'affiche alors et y renvoie le client, identifié.

== Limites de la version actuelle ==

* Réservation sur une seule journée / demi-journée / plage horaire à la fois (pas de
  réservation multi-jours depuis le tunnel public — une telle demande passe par l'équipe,
  sans paiement en ligne).
* Prêt de matériel non proposé en ligne (nécessite une vérification côté S-PACE).
* `[space_disponibilite]` ne propose jamais un jour férié (même partiellement ouvert) : une
  réservation posée sur un férié n'est de toute façon jamais confirmée automatiquement. Ce
  shortcode ne vérifie pas non plus les occupations Outlook/S-EDL — comme le reste du
  tunnel, ce contrôle n'a lieu qu'à la confirmation, pas à la recherche.

== Changelog ==

= 1.7.1 =
* [tunnel de reservation] : tarif non remboursable (NANR) propose au client, sous forme d'une
  case a cocher optionnelle (jamais cochee par defaut) a l'etape Paiement - remise de 25%,
  proposee uniquement si la reservation demarre a 21 jours calendaires minimum. Le serveur
  reste seul decisionnaire (une case cochee a tort n'obtient jamais la remise). Rappel affiche :
  non remboursable, non modifiable en ligne en cas d'annulation ou de changement.
* [tunnel de reservation] : la remise qui s'applique (statut fidelite, code promo ou tarif non
  remboursable) est desormais annoncee au client, en note discrete pres du prix (etapes Salle,
  Recapitulatif et Paiement) - jusqu'ici invisible, une remise silencieuse ne fidelisait
  personne. Rien ne s'affiche si aucune remise ne s'applique.

= 1.7.0 =
* `[space_disponibilite]` : les durées proposées (journée / demi-journée / heures précises)
  sont désormais UNIQUEMENT celles que la salle accepte réellement (réglage S-RESA, ex.
  certaines salles n'acceptent pas la réservation à l'heure) — le widget ne proposait
  jusqu'ici aucun filtre et laissait choisir une durée que la salle refuse. Une seule durée
  acceptée → elle est annoncée, sans sélecteur à un seul choix.
* `[space_disponibilite]` : le bouton « Réserver cette date » s'affiche désormais aussi sans
  l'attribut `tunnel` sur le shortcode, en reprenant le réglage global « URL de la page de
  réservation » (posé en 1.6.0) — jusqu'ici ce réglage n'était lu que par
  `[space_mon_espace]`. Toujours aucune destination devinée si rien n'est réglé nulle part.
* `[space_disponibilite]` : « Voir une autre date » ouvre désormais un mini calendrier du
  mois (dates disponibles et indisponibles visibles, fermetures et jours fériés compris),
  plutôt que de faire défiler les dates une par une.
* `[space_disponibilite]` : le prix affiché porte désormais le HT et le TTC (jusqu'ici seul
  le TTC apparaissait).
* Correctif serveur associé (API S-RESA, hors ce plugin) : le tunnel refuse désormais
  explicitement une réservation sur une durée que la salle n'accepte pas, au lieu de
  dépendre d'un effet de bord de la grille tarifaire.

= 1.6.0 =
* Réglages : nouvelle section « Salles réservables » — nom, code et shortcode
  `[space_disponibilite salle="CODE"]` prêt à copier pour chaque salle, lus EN DIRECT sur
  l'API S-RESA (jamais saisis à la main : une salle réservable aujourd'hui peut ne plus
  l'être demain). Si l'API ne répond pas, l'écran le dit explicitement (« Liste
  indisponible, vérifiez la connexion ») — jamais une liste vide silencieuse.
* `[space_mon_espace]` : nouveau bouton « + Nouvelle réservation » sur l'écran « Mes
  réservations », vers la page qui porte `[space_reservation]` (nouveau réglage « URL de la
  page de réservation »). Le client y arrive identifié — le même lien de connexion (valable
  2 heures) est repassé au tunnel, qui le reconnaît sans lui redemander son email. Réglage
  vide → le bouton ne s'affiche pas (pas de destination devinée).

= 1.5.0 =
* « Ce qui se passe sur le site reste sur le site. » `[space_mon_espace]` devient l'espace
  client COMPLET, sur le site du client : formulaire email, lien reçu qui ramène sur CETTE
  page (au lieu de l'espace client historique, sur un autre domaine), liste des
  réservations, détail (dates, statut, paiement, montant TTC), demande d'annulation. Même
  mécanisme d'identification que le tunnel (lien magique par email, aucune donnée stockée
  par le plugin), mêmes routes API que l'ancien espace client — rien de dupliqué.
* Le lien « Déjà client ? Retrouvez vos réservations » de l'étape 1 du tunnel pointe
  désormais vers la page qui porte `[space_mon_espace]` (nouveau réglage « URL de l'espace
  client »), au lieu de l'espace client historique.
* Nouveau réglage « URL de retour du lien magique » : où le lien reçu par email ramène le
  client. Vide par défaut (repli sur la page qui contient le shortcode — cas normal).
* Nouveau shortcode `[space_disponibilite salle="CODE" tunnel="URL"]` : sur la page d'une
  salle, le visiteur choisit une durée (journée / demi-journée / heures précises — les
  mêmes que le tunnel), la prochaine date libre s'affiche avec son tarif, avec la
  possibilité d'en voir une autre. Le bouton « Réserver cette date » bascule vers le tunnel
  préempli (salle, date, durée). Une salle retirée de la réservation en ligne est refusée
  par le serveur, quel que soit ce que dit le shortcode ; l'absence de disponibilité se dit
  explicitement (jamais un formulaire vide).
* Réglages : tableau des shortcodes disponibles, avec ce que fait chacun.
* Tunnel : lit désormais un préremplissage optionnel dans l'URL (salle, date, durée) posé
  par `[space_disponibilite]` — sans effet sur une utilisation normale du tunnel.

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
