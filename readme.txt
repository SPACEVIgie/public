=== S-PACE Réservation ===
Contributors: s-pace
Tags: réservation, salles, coworking
Requires at least: 5.5
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.9.4
License: GPLv2 or later

Tunnel de réservation en ligne pour S-PACE Business Center.

== Description ==

Ajoute le shortcode `[space_reservation]` : une salle de réunion ou un bureau peut être
réservé en ligne (recherche de disponibilité, options, devis ou paiement selon le profil
du client). Ajoute aussi `[space_mon_espace]` : l'espace client complet, sur le site
(email → lien reçu → liste des réservations → détail → demande d'annulation, modification
de l'effectif, suppression d'un jour, ajout/retrait d'une pause et modification de
l'aménagement de la salle). Ajoute enfin
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

= 1.9.4 =
* [space_reservation] Six points d'ergonomie releves lors du test complet d'Olivier du 31/08 :
  bandeau "Deja client ?" (une seule formulation, au lieu de "Deja locataire S-PACE ?"/"Vous
  etes deja locataire S-PACE ?") ; note "Les prix integrent les eventuelles remises auxquelles
  vous avez droit." sous le badge a l'etape 1 ; ecran "Aucune disponibilite" reformule (deux
  issues -- une autre date, ou la liste d'attente -- "Modifier la recherche" remonte en
  premier) ; repli automatique vers l'AUTRE type d'espace (bureau ou salle de reunion)
  quand aucun espace du type demande ne convient, annonce au client ("Aucun bureau ne
  convient, mais ces salles de reunion sont libres.") ; horaires particuliers restyles (cases
  a cocher sur une ligne, sans cadre, titre non capitalise -- l'imbrication dans .spr-field
  appliquait par accident le style des champs texte aux cases) ; lien "Gerer mes reservations"
  desormais a TOUTES les etapes du tunnel des qu'un client est identifie, avec son token.

= 1.9.3 =
* [space_reservation] Identite resolue des l'arrivee sur le tunnel quand un lien de
  connexion est utilise, meme si aucune recherche n'a encore ete lancee (cas le plus
  frequent : le bandeau d'identification est au-dessus du formulaire) -- jusqu'ici le
  badge Connecte, la remise fidelite et le tarif prefere restaient invisibles tant que
  le client ne relancait pas une recherche a la main. Reprend le meme appel que l'etape
  Paiement (deja fonctionnel), sans nouveau mecanisme. L'etape Options (3) affiche
  desormais elle aussi le badge, comme les etapes 1, 2 et 4.

= 1.9.2 =
* [space_reservation] La majoration jour férié (appliquée automatiquement depuis le 16/08,
  jamais montrée jusqu'ici) apparaît désormais au récapitulatif : une ligne « Jour férié —
  <nom du férié> (<date>) » avec son montant, comme les autres lignes de prix — non cochable,
  elle découle de la date, comme la remise fidélité découle du statut du client. Le montant
  « estimé » affiché avant l'envoi de la demande l'inclut désormais aussi. Le message expliquant
  pourquoi le paiement en ligne n'est pas proposé ce jour-là porte maintenant le montant.

= 1.9.0 =
* [space_reservation] SIRET dans le tunnel : un nouveau client (absent de PCI) choisit
  explicitement professionnel/particulier ; un professionnel saisit son SIRET (obligatoire,
  14 chiffres), avec un bouton « Remplir depuis le SIRET » (jamais automatique, toujours
  corrigeable) qui interroge recherche-entreprises.api.gouv.fr — raison sociale, adresse de
  facturation, code NAF. Un établissement fermé est signalé (jamais bloquant, avec le
  téléphone) ; un SIRET introuvable ne bloque pas non plus (saisie manuelle).
* Un SIRET déjà connu de Vigie n'ouvre plus de formulaire de création : le tunnel propose de
  recevoir le lien de connexion existant (2 heures, même mécanisme qu'ailleurs) après
  vérification que l'email saisi correspond bien à ce tiers.
* Un nouveau client (professionnel ou particulier, absent de PCI) ne voit plus le paiement en
  ligne, le crédit salle ni la facture fin de mois — seule la demande de devis lui est
  proposée ; un client déjà identifié par lien magique garde tous les modes, inchangé.

= 1.8.2 =
* [space_mon_espace] « Jamais un mur » : chaque geste refusé pour cause de fenêtre (ou pour une
  cause permanente — annulation en cours, tarif non remboursable, tarif figé à la main) se termine
  désormais par une issue explicite — « Appelez-nous au 05 46 50 46 86, on trouvera une solution » —
  au lieu d'un simple renvoi vers « l'équipe ». Même texte partout (API S-RESA et les deux écrans
  client), calculé une seule fois par le module partagé (`window.SresaEspaceClientCore`).
* Le détail d'une réservation affiche désormais le MOTIF au-dessus des boutons « Modifier
  l'effectif »/« Supprimer ce jour » grisés ou absents (annulation en cours, définitif, NANR, tarif
  figé à la main) — jusqu'ici ces boutons se grisaient ou disparaissaient sans un mot pour
  l'expliquer.
* « Supprimer ce jour » tient désormais compte du tarif figé à la main (le bouton disparaissait
  déjà pour un tarif non remboursable, mais pas pour un tarif fixé manuellement — pourtant bloqué
  côté serveur depuis la version 1.8.0).

= 1.8.1 =
* [space_mon_espace] deux nouveaux gestes libre-service, jour par jour, portés par le même module
  partagé que les gestes 1.8.0 : « Ajouter/retirer une pause » et « Modifier l'aménagement de la
  salle ». Aucun paiement en ligne ni montant affiché — une pause ajoutée ou retirée fait l'objet
  d'une facturation complémentaire (ou d'un ajustement) traitée par l'équipe, jamais en ligne.
  L'aménagement n'a aucun effet sur le prix ni sur le statut de la réservation ; sa fenêtre de
  modification reste ouverte plus longtemps que celle des pauses (rien n'y est commandé chez un
  fournisseur). Toutes les règles (fenêtres, tarif figé à la main, tarif non remboursable, stock
  déjà sorti) restent arbitrées côté serveur, jamais devinées ici — comme en 1.8.0.
* Zéro ligne recopiée dans ce plugin pour ces deux gestes : ils viennent du module partagé
  (`window.SresaEspaceClientCore`) déjà chargé depuis la version 1.8.0.

= 1.8.0 =
* [space_mon_espace] deux nouveaux gestes libre-service, jour par jour, jusqu'ici réservés à
  l'espace client S-RESA historique (autre domaine) : « Modifier l'effectif » et « Supprimer un
  jour » (fenêtre, tarif figé à la main, palier de remboursement — toutes les règles restent
  arbitrées côté serveur, jamais devinées ici). Ligne « Participants » ajoutée au détail d'une
  réservation, et le paiement affiché tient désormais compte du mode de règlement (facture, crédit
  salle, gratuit) plutôt que du seul statut technique — une réservation réglée sur facture
  n'affiche plus « En attente » à tort.
* Changement structurel : `[space_mon_espace]` charge désormais un module JS partagé avec l'espace
  client S-RESA historique (même fichier, servi par S-PACE) — c'est lui qui porte ces deux gestes,
  pour que ce plugin n'ait plus à les recopier à chaque évolution (cf. la régression corrigée en
  1.7.5, causée par une telle recopie manquée). URL réglable dans Réglages > S-PACE Réservation. Si
  ce module est indisponible, `[space_mon_espace]` continue de fonctionner normalement (liste,
  détail, annulation) — seuls ces deux gestes sont alors temporairement masqués.

= 1.7.5 =
* [space_mon_espace] correctif régression du 29/08 : la liste « Mes réservations » n'affichait
  plus aucune date (numéro + statut seuls). Cause : le correctif serveur du 29/08 (période réelle
  calculée depuis les jours effectifs plutôt que le premier bloc) a retiré `date_debut`/`date_fin`
  de `GET /client/reservations` au profit de `premier_jour`/`dernier_jour`/`nb_jours` — ce fichier
  n'avait pas suivi. La liste affiche de nouveau la période ("2 septembre 2026", ou "4 journées,
  du 23 novembre au 14 décembre 2026" pour une réservation sur plusieurs jours non consécutifs),
  triée du plus proche au plus lointain ("À venir"), les réservations passées à part.

= 1.7.4 =
* [tunnel de reservation] refonte de l'ecran Options : les six lignes de pause (une par formule)
  sont remplacees par un bouton « + Ajouter une pause » ouvrant une modale (formule, descriptif,
  prix). Plusieurs pauses sont desormais possibles, chacune avec son PROPRE horaire (fini le
  10:30 impose a toutes, sans lien avec le creneau reellement reserve) - l'heure par defaut
  proposee est le milieu du creneau reserve, toujours modifiable. Chaque pause ajoutee apparait
  en ligne recapitulative modifiable et supprimable ; l'ajout/la modification/la suppression sont
  immediats, avec 6 secondes pour annuler (jamais une confirmation avant l'action).
* [tunnel de reservation] les prix HT/TTC de l'ecran Options affichent desormais le TTC en premier
  (« 8,40 EUR TTC (7,00 EUR HT) ») au lieu du HT - coherent avec l'etape Recapitulatif qui suivait
  deja cette convention depuis la 1.7.1.
* [tunnel de reservation] correctif annexe : l'estimation de prix affichee pour une pause au
  forfait (ex. capsules de cafe vendues par lot) ne comptait qu'un seul lot quel que soit le
  nombre saisi - la facturation reelle, cote serveur, etait deja correcte depuis le 28/08 ; seul
  le montant affiche AVANT paiement etait sous-estime.
* Une option tarifaire peut desormais etre marquee « ne sera pas proposee dans le tunnel » (cote
  S-PACE, ecran Parametres) : elle reste utilisable par l'equipe mais disparait du tunnel public -
  aucune option n'est concernee par defaut.

= 1.7.3 =
* [tunnel de reservation] : la proposition d'identification (« Deja locataire S-PACE ? ») est
  desormais visible des l'ecran de recherche et sur l'ecran Choix de la salle, plutot que la
  seule etape Paiement - facultative dans tous les cas, le tunnel reste utilisable sans.
* [tunnel de reservation] correctif : au retour du lien d'identification recu par email, le prix
  affiche restait celui d'AVANT l'identification (remise absente a l'ecran Salle, aux options et
  au recapitulatif) - la recherche de disponibilite n'etait jamais rejouee avec le lien desormais
  connu, seule la sauvegarde locale (anonyme) etait reaffichee. Corrige : la disponibilite est
  desormais toujours rafraichie avec le lien au retour, quelle que soit l'etape ou l'identification
  a ete demandee.
* [tunnel de reservation] : l'option de paiement « Facture fin de mois » affiche desormais le
  meme libelle que le mail de confirmation, fourni par le serveur.

= 1.7.2 =
* [tunnel de reservation] : la remise (statut fidelite, code promo ou tarif non remboursable)
  s'affiche desormais des l'ecran Choix de la salle pour un client deja identifie - jusqu'ici
  elle n'apparaissait qu'a partir du recapitulatif (etape Paiement), le prix affiche a l'ecran
  Salle changeant ensuite en cours de parcours. L'ecran Salle transmet desormais le lien
  d'identification au serveur, comme le reste du tunnel.
* [tunnel de reservation] : la recherche/salle/options en cours ne se perdait plus au retour du
  lien de connexion recu par email QUE si ce lien s'ouvrait dans le meme onglet - un client mail
  ouvre presque toujours ce lien dans un NOUVEL onglet, et repartait alors de l'etape 1. Corrige
  (la sauvegarde survit desormais au changement d'onglet) ; elle est effacee automatiquement une
  fois la reservation ou la demande de devis envoyee, ou si elle date de plus de 2 heures (duree
  du lien lui-meme).

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
