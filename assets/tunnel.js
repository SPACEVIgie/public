(function () {
  'use strict';

  var cfg = window.SpaceReservationConfig || {};
  var API_URL = (cfg.apiUrl || 'https://portail.s-pace.fr/sresa/api').replace(/\/$/, '');
  var PAGE_URL = cfg.pageUrl || window.location.href.split('?')[0];
  var API_KEY = cfg.apiKey || '';
  // (24/08, réglé en 1.5.0) Lien « Déjà client ? » à l'étape 1 — ouvre l'espace client. Depuis la
  // 1.5.0, c'est normalement la page du site qui porte [space_mon_espace] (réglage « URL de
  // l'espace client », cf. s-pace-reservation.php) — le client reste sur s-pace.fr. Repli sur
  // l'espace client S-RESA historique (autre domaine) si ce réglage est vide.
  var ESPACE_CLIENT_URL = cfg.espaceClientUrl || 'https://portail.s-pace.fr/sresa/espace-client/';
  var SNAPSHOT_KEY = 'spr_pending_snapshot';
  // (1.7.2) sessionStorage -> localStorage : sessionStorage est isole par ONGLET, or le lien
  // d'identification recu par email ouvre presque toujours un NOUVEL onglet -> la sauvegarde
  // devenait invisible au retour, le tunnel repartait de l'etape 1. localStorage survit au
  // changement d'onglet, mais PERSISTE (contrairement a sessionStorage) : on horodate donc la
  // sauvegarde (savedAt) et on ecarte tout ce qui date de plus de SNAPSHOT_TTL_MS, alignee sur
  // la duree du lien lui-meme (token_connexion / vigie_client_sessions, `now() + interval
  // '2 hours'`, routes/espaceClient.js cote S-RESA — PAS 30 minutes, chiffre initialement
  // avance mais non retrouve en code au diagnostic du 29/08). Une sauvegarde plus vieille que
  // le lien qui la ramene n'a de toute facon plus aucun sens.
  var SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;
  var STRIPE_JS = 'https://js.stripe.com/v3/';
  // (02/11, `1.624`) CGPS — l'adresse du texte que le client accepte. C'est la MEME que celle que
  // l'API renvoie dans `cgps_url` quand elle refuse (routes/sresa/tunnel.js, motif
  // 'cgps_non_acceptees') : deux ecritures d'une seule adresse, a garder alignees. Ce n'est
  // volontairement PAS un reglage du plugin — le lien doit mener au texte que le serveur nomme,
  // jamais a une page choisie installation par installation.
  var CGPS_URL = 'https://s-pace.fr/conditions-generales-de-prestations-de-services/';

  var root = document.getElementById('space-reservation-app');
  if (!root) return;

  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  // (29/08, refonte modale pause) — minuteur du bandeau « Annulé » après ajout/modification d'une
  // pause (~6 s). Hors de `state` comme _amenagementTimer côté assistant interne (app.js) : un
  // setTimeout ne doit pas être recréé à chaque render(), qui réécrit tout le DOM.
  var _pauseUndoTimer = null;
  var _pauseKeySeq = 0;
  // (01/09, lot D court -- devis multi-dates) -- compteur d'identifiants client pour les dates
  // supplementaires, meme motif que _pauseKeySeq.
  var _dateSuppKeySeq = 0;

  var state = {
    step: 1,
    config: null,
    search: { date: '', unite: 'journee', demiPeriode: 'matin', heureDebut: '', heureFin: '', typeReservation: 'salle_reunion', capaciteMin: '' },
    disponibilite: null,
    // (01/09, lot D court) -- dates AU-DELA de state.search.date : {key, date, unite, demiPeriode}.
    // Vide par defaut -> tunnel strictement mono-date, aucun changement de comportement (§ mono-date
    // inchange). Des qu'une entree est ajoutee, le tunnel bascule en mode devis multi-dates (voir
    // doRechercheMulti, joursRecherche, dispoActive ci-dessous).
    datesSupp: [],
    // Resultat de la recherche multi-dates (intersection des salles libres sur TOUTES les dates) --
    // distinct de `disponibilite` (mono-date) pour ne jamais melanger les deux formes.
    disponibiliteMulti: null,
    selectedEspaceId: null,
    optionsCatalogue: null,
    // (29/08, refonte modale pause) — remplace l'ancien `selectedPauses` (map qty par formule,
    // horaire fixe '10:30' pour toutes). Chaque pause ajoutée est désormais sa PROPRE ligne,
    // avec son horaire propre : {key, formule_id, nombre_personnes, heure_pause}. `key` est un
    // identifiant client (compteur local, jamais envoyé au serveur) qui permet de modifier/
    // supprimer une ligne précise, y compris deux pauses de la même formule à deux horaires.
    pauses: [],
    // Modale d'ajout/modification ouverte : {editKey: null|key, formule_id, nombre_personnes,
    // heure_pause} — null quand fermée. Jamais restaurée par le snapshot localStorage (une
    // modale ouverte au moment de partir s'identifier n'a pas de sens au retour).
    pauseModal: null,
    // Bandeau « Annulé » (cran ②, même motif que l'assistant interne) — jamais une confirmation
    // AVANT l'ajout, seulement une possibilité de revenir en arrière juste après.
    pauseUndo: null, // {key, libelle}
    selectedRestauration: 0,
    selectedAmenagementId: null,
    token: null,
    identifie: false,
    identiteInfo: null,
    optionsPaiement: null,
    modePaiement: 'devis',
    nonRemboursable: false, // NANR (29/08) : opt-in, jamais coche par defaut
    // (TEMPS 2, 01/09 soir) — vrai UNIQUEMENT juste apres qu'un nouveau lancement de recherche a
    // decoche un NANR precedemment coche (jamais mis a true si la case etait deja decochee, pour
    // ne pas afficher une bannière quand il n'y a rien a signaler). Lu une seule fois par
    // renderStepSalle() ; remis a false des que l'utilisateur retouche la case ou relance une
    // recherche. Sert uniquement a DIRE le decochage a l'ecran (§ piege « decochage silencieux »),
    // jamais a la logique de calcul elle-meme.
    nanrResetNotice: false,
    // (25/09, SRESA-PLUGIN-CODE-PROMO) — CODE PROMO. L'API l'accepte depuis le 18/09
    // (GET /tunnel/verifier-code, &code= sur /tunnel/disponibilite, `code`/`sans_code` sur
    // POST /tunnel/reserver) ; aucun écran ne le saisissait. Le plugin ne VALIDE rien : il
    // transporte le code et affiche ce que le serveur en dit — une seconde logique de validation
    // côté navigateur finirait par mentir (dates de validité, plafond, code réservé à un client,
    // non-cumul avec la remise fidélité).
    //   codePromoSaisie  : ce que le client tape (survit aux render(), qui réécrivent le DOM) ;
    //   codePromo        : le code RETENU (vérifié valide) — le seul qui voyage vers le serveur ;
    //   codePromoVerdict : réponse de /tunnel/verifier-code telle quelle — {valide:true, code,
    //                      libelle, note} ou {valide:false, motif, message} (message affiché TEL
    //                      QUEL : c'est lui qui dit quoi faire) ;
    //   codeRefusEnvoi   : 409 nommé reçu À L'ENVOI (code_refuse / code_plafond_atteint) — le code
    //                      ne vaut plus au moment de confirmer : jamais un échec muet, un choix ;
    //   sansCode         : le client a choisi de réserver quand même, au prix sans le code.
    codePromoSaisie: '',
    codePromo: null,
    codePromoVerdict: null,
    codePromoLoading: false,
    codeRefusEnvoi: null,
    sansCode: false,
    // (02/11, `1.624`, decision d'Olivier du 02/11) CGPS — l'acceptation est un GESTE, jamais un
    // etat par defaut : `false` au depart, et aucune reservation ne part sans elle (doReserver).
    // Elle ne voyage PAS dans la sauvegarde localStorage (saveSnapshot en porte la liste
    // explicite, plus bas) : une acceptation restauree par le navigateur serait une case cochee
    // que personne n'a cochee — exactement la preuve fabriquee que l'API refuse de fabriquer.
    //   cgpsAcceptees : ce que le client a coche a l'ecran de recapitulatif ;
    //   cgpsManquante : il a clique « Envoyer » sans cocher — on le DIT, et rien ne part ;
    //   cgpsRefus     : la phrase de l'API recue en 422 `cgps_non_acceptees`, affichee TELLE
    //                   QUELLE (c'est le serveur qui dit ce qui lui manque, pas le plugin).
    cgpsAcceptees: false,
    cgpsManquante: false,
    cgpsRefus: null,
    contact: { type: '', raison_sociale: '', nom: '', email: '', telephone: '', siret: '', adresse_facturation: '' },
    // (30/08, chantier SIRET dans le tunnel) — un champ, pas une deduction (§1) : contact.type
    // vaut '' tant que le client n'a rien choisi, 'professionnel' ou 'particulier' ensuite.
    // siretLookup : reponse de GET /tunnel/siret/:siret (etat_administratif etablissement,
    // deja_client, a_contact...) — null tant qu'aucune recherche n'a abouti.
    siretLookup: null,
    siretLookupLoading: false,
    // Instantane CAPTURE au moment du prereplissage (bouton), garde MEME SI le client corrige
    // ensuite raison_sociale/adresse/naf — sert a batir "l'API disait / il a saisi" cote mail
    // equipe (§5), jamais affiche au client.
    siretApiSnapshot: null,
    // Flot "SIRET deja connu" (§3) : reutilise POST /client/demander-lien (existant, meme lien a
    // 2h) apres verification que l'email correspond bien A CE tiers (POST /verifier-email-siret).
    siretConnuEmail: '',
    siretConnuMessage: null, // {type:'succes'|'erreur'|'aucun_contact', text}
    siretConnuLoading: false,
    commentaire: '',
    // (30/08 soir, correctif post-test Olivier) — une DEMANDE, jamais un accord : rien n'est ecrit
    // dans sresa_jours.heure_ouverture_anticipee/heure_fermeture_tardive par ce parcours (colonnes
    // posees PAR LE STAFF apres accord). Repart avec le commentaire, l'equipe est alertee par mail
    // (notificationEquipeTunnel.js), le client lit "nous reviendrons vers vous" — sans promesse.
    horaireAnticipe: { avant: false, avantHeure: '', apres: false, apresHeure: '' },
    loading: false,
    error: null,
    resultat: null,
    // Paiement en ligne (Stripe) — remplis quand mode_paiement === 'en_ligne'.
    stripeClientSecret: null,
    reservationId: null,
    stripeMounted: false,   // garde-fou : ne monter le Payment Element qu'une fois (render() réécrit le DOM)
    stripe: null,
    stripeElements: null,
    // Prise en compte (§17.14) : conflit d'agenda détecté à la confirmation → demande basculée en
    // validation équipe, message de « prise en compte » plutôt qu'une confirmation/paiement.
    aRevoir: false,
    messageClient: null,
  };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    // §17.15 — clé d'API par installation (optionnelle pendant la transition). Le serveur accepte
    // l'absence de clé mais la journalise ; une clé inconnue est refusée (403). La clé identifie
    // l'installation (elle n'authentifie pas : un tunnel public l'expose forcément côté navigateur).
    if (API_KEY) headers['X-Space-Api-Key'] = API_KEY;
    return fetch(API_URL + path, Object.assign({ headers: headers, cache: 'no-store' }, opts))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            // (25/09, code promo au plugin) — un refus NOMMÉ porte plus que `error` : motif, prix
            // sans code, choix proposé (routes/tunnel.js, ErreurReservation.extra). Jusqu'ici seul
            // le message survivait, impossible donc de proposer « Réserver sans le code » sans
            // relire le corps. On accroche le statut HTTP et le corps entier à l'erreur — les
            // appelants existants ne lisent que err.message, comportement inchangé pour eux.
            var erreur = new Error(data.error || 'Erreur serveur');
            erreur.status = res.status;
            erreur.data = data;
            throw erreur;
          }
          return data;
        });
      });
  }

  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function h(strings) {
    var args = Array.prototype.slice.call(arguments, 1);
    return strings.reduce(function (acc, s, i) { return acc + s + (args[i] !== undefined ? args[i] : ''); }, '');
  }

  // Montant TTC formaté « 216.00 € TTC » (cohérent avec le style existant du tunnel), ou null.
  function fmtTtc(tarif) {
    if (!tarif || tarif.erreur || tarif.tarif_ttc == null) return null;
    return Number(tarif.tarif_ttc).toFixed(2) + ' € TTC';
  }

  // (25/08, §4 « HT et TTC partout ») — pendant HT de fmtTtc(), toujours à partir de la même donnée
  // serveur (tarif.tarif_ht_net, lib/tarification.js calculerTarif) : jamais déduit du TTC ici, ce
  // serait faux dès qu'une réduction ou une TVA différente s'applique.
  function fmtHt(tarif) {
    if (!tarif || tarif.erreur || tarif.tarif_ht_net == null) return null;
    return Number(tarif.tarif_ht_net).toFixed(2) + ' € HT';
  }

  // Montant TTC formaté à partir d'un simple nombre (plutôt que d'un objet tarif), pour afficher un
  // total qui a déjà reçu l'addition des options — cf. fmtMontantTotal ci-dessous.
  function fmtMontant(n) {
    return n == null ? null : Number(n).toFixed(2) + ' € TTC';
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // ===================== SÉLECTION / TARIF PAR SALLE (§17.17.4, release v1.2.0) =====================
  // Chaque salle proposée porte SON PROPRE tarif (e.tarif, calculé à sa taille réelle côté serveur).
  // Le montant affiché suit la salle SÉLECTIONNÉE et se recalcule à chaque changement de choix. La
  // facturation est ancrée côté serveur sur la même taille réelle → prix affiché = prix facturé.
  // (01/09, lot D court) -- source de disponibilite active : la recherche multi-dates des
  // qu'au moins une date supplementaire existe, sinon EXACTEMENT `state.disponibilite` comme avant
  // ce chantier (aucun changement de comportement mono-date).
  function dispoActive() {
    return state.datesSupp.length ? state.disponibiliteMulti : state.disponibilite;
  }

  function espaceSelectionne() {
    var d = dispoActive();
    if (!d || !d.espaces) return null;
    var id = state.selectedEspaceId;
    return d.espaces.filter(function (e) { return e.id === id; })[0] || null;
  }

  // NANR (29/08, decision Olivier) : miroir cote client de l'eligibilite J-21 controlee par
  // calculerTarif (lib/tarification.js) - le SERVEUR reste seul decisionnaire (une case cochee a
  // tort n'obtient jamais la remise, cf. calculerTarif) ; ce calcul ne sert qu'a ne pas proposer
  // une case que le serveur refuserait de toute facon.
  // (TEMPS 2, 01/09 soir) — « premier jour », PAS forcement state.search.date seul : en
  // multi-dates, POST /reserver tranche l'eligibilite de TOUTE la reservation sur le jour le PLUS
  // TOT parmi TOUTES les dates demandees (routes/tunnel.js, dateDebutTunnel =
  // jours.map(j=>j.date_jour).sort()[0]) — jamais sur state.search.date seul, qui n'est que « la
  // date saisie en premier dans le formulaire », pas forcement la plus proche chronologiquement.
  // Reprendre la meme regle ici evite que l'apercu (etape Salle) promette une remise que l'envoi
  // refuserait ensuite. Mono-date (datesSupp vide) : resultat rigoureusement identique a avant
  // (une seule date dans la liste) — § mono-date inchange.
  function premierJourDemande() {
    var dates = [state.search.date].concat(state.datesSupp.map(function (d) { return d.date; })).filter(Boolean);
    if (!dates.length) return null;
    return dates.slice().sort()[0];
  }
  function joursAvantDebut() {
    var premier = premierJourDemande();
    if (!premier) return null;
    var debut = new Date(premier + 'T00:00:00');
    var auj = new Date();
    auj.setHours(0, 0, 0, 0);
    return Math.round((debut - auj) / 86400000);
  }
  function eligibleNonRemboursable() {
    var j = joursAvantDebut();
    return j != null && j >= 21;
  }

  // Tarif de la salle choisie (repli sur le tarif global informatif si la salle n'en porte pas).
  // (01/09) En multi-dates, e.tarif porte deja la SOMME des tarifs par jour (voir
  // doRechercheMulti) -- cette fonction n'a rien d'autre a changer que sa source (dispoActive).
  function tarifSelection() {
    var e = espaceSelectionne();
    if (e && e.tarif) return e.tarif;
    var d = dispoActive();
    return d ? d.tarif : null;
  }

  // Annonce de remise (29/08) — le serveur calcule ET rédige le texte (libelle_annonce,
  // lib/tarification.js calculerTarif) : déjà non-cumulatif (statut, code promo ou NANR — une
  // seule remise à la fois, jamais la somme). Le plugin ne fait qu'afficher tel quel, près du
  // prix, en note discrète (§25 : une remise n'est pas une action) — rien ne s'affiche si aucune
  // remise ne s'applique (libelle_annonce vaut alors null côté serveur).
  function renderAnnonceRemise(tarif) {
    var t = tarif !== undefined ? tarif : tarifSelection();
    return (t && !t.erreur && t.libelle_annonce) ? h(['<div class="spr-annonce-remise">', esc(t.libelle_annonce), '</div>']) : '';
  }

  // (02/11, `1.622`) NANR — LE SERVEUR TRANCHE, exactement comme `code_statut` plus bas : le
  // plugin ne rejoue pas le J-21 pour DÉCIDER, il lit le verdict rendu avec le prix.
  // calculerTarif (lib/tarification.js:646) renvoie `non_remboursable_eligible` à TROIS états :
  //   true  — demandé ET accordé (le prix rendu PORTE la remise) ;
  //   false — demandé et REFUSÉ (le prix rendu est le prix STANDARD) ;
  //   null  — aucune demande n'a voyagé (`&non_remboursable=0`) : rien à dire.
  // `undefined` est un QUATRIÈME cas, qui n'est pas un verdict : une réponse qui ne porte pas le
  // champ (API antérieure au 29/08, réponse en cache). On n'affirme alors RIEN — ni remise, ni
  // « non annulable » — et l'envoi ne demande pas le NANR : l'écran et l'envoi disent la même
  // chose, faute de quoi le client s'engagerait sur ce qu'il n'a pas lu.
  // ⚠️ `code_statut === 'ignore_nanr'` n'est PAS un refus : c'est le signe que le NANR S'APPLIQUE
  // et qu'il écarte le code promo (lib/tarification.js:640). Le lire comme un refus inverserait
  // exactement le défaut qu'on ferme ici.
  function nanrAccordeParServeur() {
    var t = tarifSelection();
    return !!(t && !t.erreur && t.non_remboursable_eligible === true);
  }
  function nanrRefuseParServeur() {
    var t = tarifSelection();
    return !!(t && !t.erreur && t.non_remboursable_eligible === false);
  }

  // (02/11, `1.623`) Le pourcentage VIENT DU SERVEUR (`remise_non_remboursable_pct`, qui porte le
  // réglage `sresa_remise_non_remboursable_pct`) — jamais un chiffre écrit ici, qui mentirait le
  // jour où Olivier change le réglage. Il vaut 0 tant que le NANR n'est pas appliqué : le serveur
  // ne lit le réglage QU'À L'INTÉRIEUR de `if (nonRembApplicable)` (lib/tarification.js:614-618).
  // 0 et absent se lisent donc tous deux « inconnu », et le libellé n'énonce alors AUCUN chiffre
  // plutôt qu'un chiffre périmé.
  function pctNonRemboursable() {
    var t = tarifSelection();
    var p = (t && !t.erreur) ? Number(t.remise_non_remboursable_pct) : NaN;
    return (isFinite(p) && p > 0) ? p : null;
  }

  // Le refus, DIT une fois, sobrement — là où le client vient de le provoquer (la case, étape 2)
  // et là où il relit avant d'envoyer (le récapitulatif). Même classe que la bannière de
  // décochage juste à côté : aucun style neuf.
  function renderNanrRefusHtml() {
    return nanrRefuseParServeur()
      ? h(['<div class="spr-hint spr-hint-indispo">Le tarif non remboursable n\'est pas disponible pour ces dates.</div>'])
      : '';
  }

  // ===================== CODE PROMO (25/09, SRESA-PLUGIN-CODE-PROMO) =====================
  // Le sort du code est TRANCHÉ PAR LE SERVEUR, à chaque calcul de tarif (lib/tarification.js
  // calculerTarif) : `code_statut` vaut 'applique' · 'ecarte' (valable, mais une autre remise est
  // plus avantageuse en € — aucune ne se cumule) · 'ignore_nanr' (le tarif non remboursable prime)
  // · 'refuse' (+ code_refus.message, qui dit quoi faire) · null (aucun code transmis). Le plugin
  // ne recalcule rien : il lit ce champ sur le tarif de la salle choisie, exactement comme il lit
  // déjà libelle_annonce.
  function statutCodeTarif() {
    var t = tarifSelection();
    return (t && !t.erreur && t.code_statut) ? t.code_statut : null;
  }

  function refusCodeTarif() {
    var t = tarifSelection();
    return (t && !t.erreur && t.code_refus) ? t.code_refus : null;
  }

  // Ce que le client lit une fois le code passé au calcul — une phrase par statut. Jamais un code
  // annoncé « appliqué » quand il ne l'est pas : c'est exactement le piège que tend le non-cumul
  // (un code parfaitement valable peut ne rien changer au prix).
  function messageStatutCode() {
    var statut = statutCodeTarif();
    var t = tarifSelection();
    var v = state.codePromoVerdict;
    var libelle = (v && v.valide && v.libelle) ? v.libelle : null;
    if (statut === 'applique') {
      return { classe: 'spr-code-ok', texte: 'Code ' + state.codePromo + ' appliqué' + (libelle ? ' — ' + libelle : '') + '.' };
    }
    if (statut === 'ecarte') {
      return { classe: 'spr-code-note', texte: 'Le code ' + state.codePromo + ' est valable mais n\'est pas appliqué : '
        + ((t && t.libelle_annonce) ? t.libelle_annonce : 'une autre remise')
        + ' est plus avantageuse en euros (aucune remise ne se cumule).' };
    }
    if (statut === 'ignore_nanr') {
      return { classe: 'spr-code-note', texte: 'Le tarif non remboursable s\'applique : le code ' + state.codePromo
        + ' n\'est pas utilisé (aucune remise ne se cumule). Décochez ce tarif pour comparer les deux.' };
    }
    if (statut === 'refuse') {
      var r = refusCodeTarif();
      return { classe: 'spr-code-refus', texte: (r && r.message) ? r.message
        : 'Ce code n\'est pas reconnu. Vérifiez l\'orthographe, ou continuez sans code.' };
    }
    return null;
  }

  // Libellé COURT pour le récapitulatif — même donnée, même serveur, pas un second verdict.
  function libelleRecapCode() {
    if (!state.codePromo) return null;
    var statut = statutCodeTarif();
    if (state.sansCode) return state.codePromo + ' — non appliqué (réservé sans le code)';
    if (statut === 'applique') return state.codePromo + ' — appliqué';
    if (statut === 'ecarte') return state.codePromo + ' — non appliqué (remise plus avantageuse)';
    if (statut === 'ignore_nanr') return state.codePromo + ' — non appliqué (tarif non remboursable)';
    if (statut === 'refuse') return state.codePromo + ' — refusé';
    return state.codePromo;
  }

  // Le champ — ÉTAPE 2, là où les prix s'affichent et où le tarif non remboursable se coche : les
  // deux leviers de prix au même endroit, au-dessus de la liste dont ils changent les montants.
  function renderCodePromoBox() {
    var v = state.codePromoVerdict;
    var msg = state.codePromo ? messageStatutCode() : null;
    // Refus À LA SAISIE (GET /tunnel/verifier-code) : le message du serveur, TEL QUEL — il nomme le
    // motif (inconnu, pas encore valable, expiré, plafond atteint, déjà utilisé) et dit quoi faire.
    var refusSaisie = (v && !v.valide) ? h(['<div class="spr-code-msg spr-code-refus">', esc(v.message || ''), '</div>',
      // Aucune fuite (décision 29/08 : un code réservé à UN AUTRE client répond « inconnu », comme
      // un code qui n'existe pas) — cette note est la même pour tout code inconnu, elle n'apprend
      // donc rien sur le code saisi ; elle évite juste qu'un client à qui un code a été réservé
      // reste bloqué sur un refus qu'une identification lèverait.
      (v.motif === 'inconnu' && !state.identifie)
        ? '<div class="spr-code-msg spr-code-note">Si ce code vous a été communiqué personnellement, identifiez-vous (« Déjà client ? ») puis saisissez-le à nouveau.</div>'
        : '']) : '';
    var corps = state.codePromo
      ? h(['<div class="spr-code-row"><span class="spr-code-tag">', esc(state.codePromo), '</span>',
        '<button class="spr-btn spr-code-btn" id="spr-code-retirer">Retirer</button></div>',
        msg ? h(['<div class="spr-code-msg ', msg.classe, '">', esc(msg.texte), '</div>']) : ''])
      : h(['<div class="spr-code-row">',
        '<input type="text" id="spr-code-input" placeholder="Votre code" autocomplete="off" value="', esc(state.codePromoSaisie), '">',
        '<button class="spr-btn spr-code-btn" id="spr-code-appliquer"', state.codePromoLoading ? ' disabled' : '', '>',
        state.codePromoLoading ? 'Vérification…' : 'Appliquer', '</button></div>', refusSaisie]);
    return h(['<div class="spr-code-box">',
      '<div class="spr-code-title">Code promo</div>',
      '<div class="spr-code-sub">Si vous en avez un, saisissez-le : les prix ci-dessous se mettent à jour.</div>',
      corps,
      '</div>']);
  }

  // Le refus du code AU MOMENT D'ENVOYER (409 nommé, récapitulatif) — message du serveur tel quel :
  // il porte le motif et le prix sans le code. Rien n'a été écrit côté serveur par la tentative.
  function renderCodeRefusEnvoi() {
    var r = state.codeRefusEnvoi;
    if (!r) return '';
    return h(['<div class="spr-banner spr-warn">', esc(r.message), ' Votre demande n\'a pas encore été envoyée.</div>']);
  }

  // MAJORATION JOUR FÉRIÉ (§17.24, chantier « visible côté client », 30/08 soir) — une ligne PAR
  // jour férié validé (routes/tunnel.js POST /tunnel/options-paiement → majoration_ferie_lignes),
  // MÊME libellé que la ligne réelle facturée (lib/tarificationOptions.js) : le client revoit
  // exactement le même texte au récapitulatif, dans le mail de confirmation et sur la fiche staff.
  // AUTO-APPLIQUÉE, JAMAIS COCHABLE (§ « elle découle de la date, comme la remise fidélité découle
  // du statut ») : rendue en ligne de récapitulatif (spr-recap-line, comme Salle/Options) — PAS
  // dans la modale de pause, ce n'est pas un choix — avec une note discrète expliquant le pourquoi
  // (jamais une justification longue).
  function renderMajorationFerie() {
    var lignes = majorationFerieLignes();
    if (!lignes.length) return '';
    var linesHtml = lignes.map(function (l) {
      return '<div class="spr-recap-line"><span>' + esc(l.libelle) + '</span><span>' + fmtMontant(l.montant_ttc) + '</span></div>';
    }).join('');
    return h([linesHtml,
      '<div class="spr-hint" style="margin:2px 0 10px;">Le centre est fermé ce jour-là : cette majoration ',
      "s'applique automatiquement et n'est pas modifiable.</div>"]);
  }

  // MAJORATION JOUR FÉRIÉ (§17.24, chantier « visible côté client », 30/08 soir) — chargée à
  // l'étape 4 (chargerOptionsPaiement → POST /tunnel/options-paiement, qui reçoit déjà la date
  // choisie) et posée dans state.optionsPaiement, jamais dans state.optionsCatalogue : ce n'est
  // PAS une option cochable (§ « ne pas la rendre cochable » — elle découle de la date, comme la
  // remise fidélité découle du statut). Absente/0 tant que l'étape 4 n'a pas été atteinte : le
  // total aux étapes 1-3 reste salle + options choisies, comme avant.
  function majorationFerieLignes() {
    var op = state.optionsPaiement;
    return (op && Array.isArray(op.majoration_ferie_lignes)) ? op.majoration_ferie_lignes : [];
  }
  function montantMajorationFerieTtc() {
    var op = state.optionsPaiement;
    return op && op.majoration_ferie_ttc ? Number(op.majoration_ferie_ttc) : 0;
  }
  function montantMajorationFerieHt() {
    var op = state.optionsPaiement;
    return op && op.majoration_ferie_ht ? Number(op.majoration_ferie_ht) : 0;
  }

  // §4.9/§4.17 ext. — BUG CORRIGÉ (24/08) : ce montant ne portait QUE la salle (t.tarif_ttc), sans
  // jamais ajouter les options choisies à l'étape 3 (pauses/restauration/aménagement) — alors que le
  // serveur, LUI, encaisse bien salle + options (routes/tunnel.js POST /reserver, calculerOptionsReservation
  // appelé après insertion des options, cf. lib/tarificationOptions.js). Le client payait donc le bon
  // montant (vérifié sur WEB-223/224 : Stripe a bien débité salle+options), mais voyait un total plus
  // bas AVANT de payer — décalage entre l'écran et la carte bancaire. Inclut désormais montantOptionsTtc().
  // (30/08 soir) Inclut aussi montantMajorationFerieTtc() — même correctif, pour la même raison :
  // un férié validé bascule la demande en devis (jamais un paiement Stripe immédiat, cf.
  // routes/tunnel.js `demandeSeule`), donc aucun risque d'écart avec une carte déjà débitée ; mais
  // le montant « estimé » affiché avant envoi doit rester honnête, lui aussi.
  function montantSelection() {
    var t = tarifSelection();
    if (!t || t.erreur || t.tarif_ttc == null) return null;
    return round2(Number(t.tarif_ttc) + montantOptionsTtc() + montantMajorationFerieTtc());
  }

  // (25/08, §4) Pendant HT de montantSelection() — MÊME donnée serveur (tarif_ht_net) + MÊME
  // accumulation HT des options (montantOptionsHt(), ci-dessous) que le TTC : jamais un second calcul
  // indépendant qui pourrait diverger.
  function montantSelectionHt() {
    var t = tarifSelection();
    if (!t || t.erreur || t.tarif_ht_net == null) return null;
    return round2(Number(t.tarif_ht_net) + montantOptionsHt() + montantMajorationFerieHt());
  }

  // Montant HT des OPTIONS sélectionnées à l'étape 3 — MÊME FORMULE que le serveur
  // (lib/tarificationOptions.js calculerOptionsReservation) : par_personne × effectif de la ligne
  // (pause/restauration) ou du jour (aménagement, effectif = capaciteMin recherché).
  // Une option sans prix défini dans sresa_tarifs_options compte pour 0 — ne gonfle jamais le total,
  // exactement comme côté serveur (§ « zéro n'est pas absent », l'option reste sélectionnée et sera
  // livrée même à 0 €). Recalculé à la volée depuis le catalogue déjà chargé (GET /tunnel/options) :
  // aucun aller-retour serveur supplémentaire pour l'affichage.
  function montantOptionsHt() {
    var cat = state.optionsCatalogue;
    if (!cat) return 0;
    var ht = 0;
    // (29/08, refonte modale pause) — CORRECTIF ANNEXE trouvé en migrant vers `state.pauses` :
    // l'ancien calcul multipliait par la quantité UNIQUEMENT en `par_personne`, jamais en
    // `forfait` (toujours ×1) — alors que le serveur (tarificationOptions.js, correctif du 28/08,
    // [[sresa_tarif_pauses_forfait_lots_2026_08_28]]) multiplie les DEUX par `nombre_personnes`
    // (effectif ou nombre de lots selon l'unité, même champ). L'estimation affichée au client
    // sous-évaluait donc une pause forfait à plus d'un lot (ex. 3 lots de « 10 capsules de café
    // Merling » affichés au prix d'1 seul) — jamais la FACTURATION réelle (déjà correcte côté
    // serveur), seulement ce que le client voyait avant de payer. Corrigé au passage : chaque
    // pause de `state.pauses` compte pour `nombre_personnes × prix_ht`, quelle que soit l'unité.
    state.pauses.forEach(function (pz) {
      var p = cat.pauses.filter(function (x) { return String(x.id) === String(pz.formule_id); })[0];
      if (!p || p.prix_ht == null) return;
      ht += Number(p.prix_ht) * (Number(pz.nombre_personnes) || 0);
    });
    if (state.selectedRestauration > 0 && cat.restauration.length && cat.restauration[0].prix_ht != null) {
      var r = cat.restauration[0];
      ht += Number(r.prix_ht) * (r.unite_facturation === 'par_personne' ? state.selectedRestauration : 1);
    }
    if (state.selectedAmenagementId) {
      var a = cat.amenagements.filter(function (x) { return x.id === state.selectedAmenagementId; })[0];
      if (a && a.prix_ht != null) {
        var effectif = Number(state.search.capaciteMin) || 0;
        ht += Number(a.prix_ht) * (a.unite_facturation === 'par_personne' ? effectif : 1);
      }
    }
    return round2(ht);
  }

  // TVA 20 % — même taux constant que le serveur applique aux options (lib/tarificationOptions.js,
  // TVA_PCT, « alignée sur la salle »). ⚠️ Un seul taux existe aujourd'hui pour toutes les options y
  // compris la restauration ; si un jour un taux différencié est décidé côté S-RESA, CE calcul devra
  // suivre (note de session du 25/08 — non tranché à ce jour, le taux réellement facturé reste 20 %).
  function montantOptionsTtc() {
    return round2(montantOptionsHt() * 1.2);
  }

  // Total formaté (salle + options), pour les étapes récap et paiement Stripe.
  function fmtMontantTotal() {
    return fmtMontant(montantSelection());
  }

  // Pendant HT du total ci-dessus, formaté (25/08, §4).
  function fmtMontantTotalHt() {
    var n = montantSelectionHt();
    return n == null ? null : Number(n).toFixed(2) + ' € HT';
  }

  // ===================== UTILITAIRES DATE/HEURE =====================
  // Les horaires par défaut ci-dessous ne servent QU'À L'AFFICHAGE, en repli si /tunnel/creneaux
  // n'a pas répondu. Ils sont alignés sur la grille S-RESA (§17.1bis). La requête, elle, ne les
  // embarque jamais pour la journée/demi-journée : elle transmet le créneau, et c'est le serveur
  // qui applique la grille (source unique, clés vigie_config sresa_horaire_*).
  // (01/09, lot D court) -- memes horaires que ci-dessus, mais PARAMETRES (unite/demiPeriode
  // explicites) pour etre reutilisables par jour, dans une recherche multi-dates ou chaque date
  // porte sa propre duree. computeCreneauHoraires() delegue ici pour la date PRINCIPALE
  // (state.search) -- comportement mono-date strictement identique a avant ce chantier.
  function horairesPourJour(unite, demiPeriode) {
    var c = state.config || {};
    if (unite === 'journee') {
      return { debut: c.journee_debut || '08:30', fin: c.journee_fin || '18:00' };
    }
    if (unite === 'demi_journee') {
      return demiPeriode === 'matin'
        ? { debut: c.matin_debut || '08:30', fin: c.matin_fin || '12:30' }
        : { debut: c.apresmidi_debut || '14:00', fin: c.apresmidi_fin || '18:00' };
    }
    return { debut: '', fin: '' };
  }

  function computeCreneauHoraires() {
    if (state.search.unite === 'heure') {
      return { debut: state.search.heureDebut, fin: state.search.heureFin };
    }
    return horairesPourJour(state.search.unite, state.search.demiPeriode);
  }

  // Pas de granularité des créneaux horaires (§17.17.1) — servi par le SERVEUR dans /tunnel/creneaux
  // (bloc regles). Aucune valeur en dur : repli 15 min uniquement si le serveur n'a pas répondu.
  function pasMinutes() {
    var r = state.config && state.config.regles;
    var p = r && Number(r.pas_minutes);
    return p && p > 0 ? p : 15;
  }

  // Créneau transmis au backend (§17.13). Pour une demi-journée : 'matin' | 'apres_midi' ; sinon
  // undefined (la journée et les heures précises n'ont pas de créneau demi-journée). C'est cette
  // valeur — et non des heures figées — qui pilote la grille côté serveur.
  function computeCreneau() {
    if (state.search.unite === 'demi_journee') {
      return state.search.demiPeriode === 'apresmidi' ? 'apres_midi' : 'matin';
    }
    return undefined;
  }

  // Libellé lisible du créneau retenu, pour l'affichage sous le sélecteur de durée.
  function libelleCreneau() {
    var s = state.search, hor = computeCreneauHoraires();
    if (s.unite === 'heure') {
      return s.heureDebut && s.heureFin ? (s.heureDebut + ' – ' + s.heureFin) : '';
    }
    return hor.debut && hor.fin ? (hor.debut + ' – ' + hor.fin) : '';
  }

  function heuresEntre(debut, fin) {
    var d = debut.split(':').map(Number);
    var f = fin.split(':').map(Number);
    return ((f[0] * 60 + f[1]) - (d[0] * 60 + d[1])) / 60;
  }

  function minutesVersHeure(min) {
    var hh = Math.floor(min / 60);
    var mm = Math.round(min % 60);
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // (29/08, §3 diagnostic « L'horaire est-il demandé ? ») — défaut de l'heure de pause, plus
  // jamais '10:30' en dur (n'avait aucun sens pour une réservation l'après-midi). Milieu du
  // créneau RÉELLEMENT réservé (journée/demi-journée/heures précises), arrondi au pas serveur
  // (pasMinutes(), même granularité que les créneaux de réservation) et pincé à l'intérieur du
  // créneau si l'arrondi le faisait déborder. Reste un DÉFAUT modifiable dans la modale — jamais
  // imposé.
  function heureParDefautPause() {
    var hor = computeCreneauHoraires();
    if (!hor.debut || !hor.fin) return '10:30';
    var d = hor.debut.split(':').map(Number);
    var f = hor.fin.split(':').map(Number);
    var minDebut = d[0] * 60 + d[1];
    var minFin = f[0] * 60 + f[1];
    if (!(minFin > minDebut)) return hor.debut;
    var pas = pasMinutes();
    var milieu = Math.round((minDebut + minFin) / 2 / pas) * pas;
    milieu = Math.min(Math.max(milieu, minDebut), minFin);
    return minutesVersHeure(milieu);
  }

  function computeDuree() {
    if (state.search.unite === 'heure') {
      var horaires = computeCreneauHoraires();
      return horaires.debut && horaires.fin ? heuresEntre(horaires.debut, horaires.fin) : 0;
    }
    return 1;
  }

  function formatDateFr(iso) {
    var d = new Date(iso + 'T00:00:00');
    return d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear();
  }

  // ===================== LOT D COURT (01/09) — DEVIS MULTI-DATES =====================
  // Liste ORDONNÉE des jours de la recherche en cours : la date principale (state.search) suivie
  // des dates supplémentaires (state.datesSupp), chacune normalisée en {date_jour, unite, creneau,
  // heure_debut?, heure_fin?} — même vocabulaire que le serveur (routes/tunnel.js POST /reserver,
  // lib/creerReservation.js resoudreJour : jour.unite/jour.creneau prévalent déjà sur
  // unite_choisie/creneau globaux, en toute rétrocompatibilité). Sans date supplémentaire, renvoie
  // EXACTEMENT le même objet qu'avant ce chantier (un seul élément, mêmes clés) — c'est ce qui
  // garantit que le mono-date reste inchangé partout où cette fonction remplace l'ancien code
  // (chargerOptionsPaiement, construirePayload).
  function joursRecherche() {
    var s = state.search;
    var estHeure = s.unite === 'heure';
    var primary = {
      date_jour: s.date, unite: s.unite, creneau: computeCreneau(),
      heure_debut: estHeure ? s.heureDebut : undefined,
      heure_fin: estHeure ? s.heureFin : undefined,
    };
    if (!state.datesSupp.length) return [primary];
    var extra = state.datesSupp.map(function (d) {
      return {
        date_jour: d.date, unite: d.unite,
        creneau: d.unite === 'demi_journee' ? (d.demiPeriode === 'apresmidi' ? 'apres_midi' : 'matin') : undefined,
      };
    });
    return [primary].concat(extra);
  }

  // Libellé de date long, capitalisé — MÊME FORMULE que le mail n°4 (lib/emailToutEstPret.js,
  // dateDebutLabel/dLabel) : Intl fr-FR, weekday/day/month, première lettre mise en majuscule.
  // Choisi pour que le client reconnaisse le même vocabulaire d'une communication à l'autre.
  function libelleDateFrLong(iso) {
    var d = new Date(iso + 'T00:00:00');
    var label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // Libellé de durée par jour — MÊME FORMULE que libelleDureeJour (lib/emailToutEstPret.js, lot
  // C/F du 31/08) : « Après-midi (14:00–18:00) », « Journée (08:30–18:00) ». demiPeriode ici suit
  // la convention CLIENT ('matin'/'apresmidi', cf. state.search.demiPeriode), traduite comme le
  // fait déjà computeCreneau() pour le serveur ('apres_midi').
  function libelleDureeJourClient(unite, demiPeriode) {
    var hor = horairesPourJour(unite, demiPeriode);
    var horaires = hor.debut && hor.fin ? (hor.debut + '–' + hor.fin) : '';
    if (unite === 'demi_journee') {
      var mot = demiPeriode === 'apresmidi' ? 'Après-midi' : 'Matin';
      return horaires ? (mot + ' (' + horaires + ')') : mot;
    }
    if (unite === 'journee') {
      return horaires ? ('Journée (' + horaires + ')') : 'Journée complète';
    }
    return horaires;
  }

  // Ligne « <Jour> <date> — <Durée> (<horaires>) » du récapitulatif multi-dates (étape 5) — même
  // gabarit que le mail n°4 (§5 du cadrage : « reprendre EXACTEMENT ce format »).
  function ligneJourLabel(dateIso, unite, demiPeriode) {
    return libelleDateFrLong(dateIso) + ' — ' + libelleDureeJourClient(unite, demiPeriode);
  }

  // (31/08, ergonomie tunnel §4) — libellé lisible d'un type d'espace (espaces.type_reservation),
  // pour le message de repli. Un seul point de traduction plutôt que des chaînes en dur répétées.
  function libelleTypeEspace(type, pluriel) {
    if (type === 'bureau') return pluriel ? 'bureaux' : 'bureau';
    return pluriel ? 'salles de réunion' : 'salle de réunion';
  }

  // ===================== RENDU =====================
  function render() {
    // L'étape « paiement Stripe » (7) réutilise le point d'étape « Paiement » (4) dans le fil.
    var dotStep = state.step === 7 ? 4 : state.step;
    var stepsHtml = h(['<div class="spr-steps">',
      renderDot(1, 'Recherche', dotStep), '<div class="spr-step-line"></div>',
      renderDot(2, 'Salle', dotStep), '<div class="spr-step-line"></div>',
      renderDot(3, 'Options', dotStep), '<div class="spr-step-line"></div>',
      renderDot(4, 'Paiement', dotStep), '<div class="spr-step-line"></div>',
      renderDot(5, 'Confirmation', dotStep),
      '</div>']);

    var body = '';
    if (state.step === 1) body = renderStepRecherche();
    else if (state.step === 2) body = renderStepSalle();
    else if (state.step === 3) body = renderStepOptions();
    else if (state.step === 4) body = renderStepPaiement();
    else if (state.step === 5) body = renderStepRecap();
    else if (state.step === 6) body = renderStepConfirmation();
    else if (state.step === 7) body = renderStepPaiementStripe();

    var errorHtml = state.error ? h(['<div class="spr-banner spr-error">', esc(state.error), '</div>']) : '';

    // (29/08, refonte modale pause) — la modale d'ajout/modif et le bandeau d'annulation sont
    // rendus ICI, en dehors de renderStepOptions() : root.innerHTML est réécrit en entier à
    // chaque render() de toute façon (même motif que le reste du fichier), donc pas besoin d'un
    // second point de montage — un seul `render()` reste la seule source de vérité du DOM.
    var modalHtml = state.pauseModal ? renderPauseModal() : '';
    var undoHtml = state.pauseUndo ? h(['<div class="spr-undo-bar">',
      '<span>', esc(state.pauseUndo.libelle), '</span>',
      '<button type="button" class="spr-btn spr-ghost" id="spr-pause-undo-btn">Annuler</button>',
      '</div>']) : '';

    root.innerHTML = (state.step < 6 || state.step === 7 ? stepsHtml : '') + errorHtml + body + undoHtml + modalHtml;
    bindEvents();
  }

  function renderDot(n, label, dotStep) {
    var cur = dotStep === undefined ? state.step : dotStep;
    var cls = cur > n ? 'done' : (cur === n ? 'active' : '');
    return '<div class="spr-step-dot ' + cls + '" title="' + esc(label) + '">' + (cur > n ? '✓' : n) + '</div>';
  }

  // Lien vers l'espace client AVEC LE TOKEN qui a identifié ce client (31/08, ergonomie tunnel §6
  // — signalé deux fois par Olivier, le lien « Gérer mes réservations » ne survivait pas au
  // changement d'étape). ESPACE_CLIENT_URL pointe soit la page moderne portant [space_mon_espace]
  // (réglage « URL de l'espace client », lit ?space_token= — même convention que ce tunnel, cf.
  // assets/mon-espace.js), soit, à défaut de réglage, l'ancien espace client direct dont le token
  // est un SEGMENT DE CHEMIN (assets/mon-espace.js absent de cette cible ; espace-client.js
  // historique, getTokenFromUrl) — pas une query string. On distingue les deux par la FORME de
  // l'URL plutôt que d'inventer un 3ᵉ format qui casserait l'une des deux cibles.
  function urlEspaceClientAvecToken() {
    if (!state.token) return ESPACE_CLIENT_URL;
    if (/\/espace-client\/?$/.test(ESPACE_CLIENT_URL)) {
      return ESPACE_CLIENT_URL.replace(/\/$/, '') + '/' + encodeURIComponent(state.token);
    }
    var sep = ESPACE_CLIENT_URL.indexOf('?') >= 0 ? '&' : '?';
    return ESPACE_CLIENT_URL + sep + 'space_token=' + encodeURIComponent(state.token);
  }

  // Badge « ✓ Connecté », REUTILISÉ par renderIdentifyPrompt() (étapes 1, 2, 3) ET par
  // renderStepPaiement() (étape 4, qui composait jusqu'ici le même badge séparément — cf. §6) :
  // un seul point de rendu pour que le lien « Gérer mes réservations » n'oublie jamais une étape.
  function renderConnectedChip() {
    return h(['<div class="spr-identified-chip">✓ Connecté',
      state.identiteInfo && state.identiteInfo.raison_sociale ? (' — ' + esc(state.identiteInfo.raison_sociale)) : '',
      // (31/08, §6) — le lien n'a de sens qu'avec un token en poche (state.token) : un client
      // identifié via le cookie space_client seul (portail S-CLIENT) n'en a pas ici, cf. §
      // urlEspaceClientAvecToken ci-dessus — pas de lien plutôt qu'un lien qui perdrait le token.
      state.token ? h([' <a class="spr-manage-link" href="', esc(urlEspaceClientAvecToken()), '" target="_blank" rel="noopener">Gérer mes réservations</a>']) : '',
      '</div>']);
  }

  // Proposition d'identification, RÉUTILISÉE à plusieurs endroits du tunnel (correctif 29/08 —
  // « proposer dès le début » plutôt que la limiter à l'étape Paiement). Un seul point de rendu
  // et un seul point de câblage (bindEvents ci-dessous) pour ne jamais faire diverger le texte ou
  // le comportement entre les emplacements. Déjà identifié : petit badge, pas de formulaire.
  // Jamais bloquant — c'est une PROPOSITION (§ note de cadrage), le tunnel reste utilisable sans.
  function renderIdentifyPrompt() {
    if (state.identifie) {
      // (30/08 soir, correctif post-test Olivier) — la remise (si applicable) s'affiche desormais
      // ICI, juste sous le badge, des l'etape 1 : jusqu'ici elle n'apparaissait qu'au recap/paiement,
      // laissant croire pendant tout le parcours que rien n'etait applique. §25 : une remise n'est
      // pas une action -> note discrete (renderAnnonceRemise, deja stylee --spr-note), pas un badge.
      // (31/08, correctif reliquats v1.9.4 §1) — noteRemisesHtml VIT ICI, dans la branche identifie,
      // et non plus en dehors de renderIdentifyPrompt() : posée inconditionnellement (bug constaté à
      // l'écran par Olivier le 31/08), elle s'affichait même NON CONNECTÉ, juste sous le bandeau
      // « Déjà client ? » — contredisant « Identifiez-vous pour voir vos tarifs dédiés » juste
      // au-dessus, et promettant une remise à un prospect qui n'y a droit à rien. Elle ACCOMPAGNE le
      // badge (sous lui), elle ne remplace jamais le bandeau non-connecté. Libellé inchangé
      // (« éventuelles » confirmé par Olivier — remise fidélité, tarif négocié, ou rien).
      return h([renderConnectedChip(),
        '<div class="spr-note-remises">Les prix intègrent les éventuelles remises auxquelles vous avez droit.</div>',
        renderAnnonceRemise()]);
    }
    return h(['<div class="spr-identify-box spr-identify-compact">',
      // (31/08, ergonomie tunnel §1) — même formulation que le lien « Déjà client ? Retrouvez vos
      // réservations » (dejaClientHtml, renderStepRecherche) : une seule façon de poser la
      // question dans tout le tunnel, plutôt que « Déjà locataire S-PACE ? » ici et « Vous êtes
      // déjà locataire S-PACE ? » à l'étape Paiement (renderStepPaiement, ci-dessous).
      '<div class="spr-identify-title">Déjà client ?</div>',
      '<div class="spr-identify-sub">Identifiez-vous pour voir vos tarifs dédiés — facultatif, vous pouvez continuer sans.</div>',
      '<div class="spr-identify-row"><input type="email" id="spr-identify-email" placeholder="votre@email.fr">',
      '<button class="spr-btn" id="spr-btn-identify">Recevoir mon lien</button></div>',
      '</div>']);
  }

  // ---- Étape 1 : recherche ----
  function renderStepRecherche() {
    var s = state.search;
    var demiField = s.unite === 'demi_journee' ? h(['<div class="spr-field"><label>Période</label><select id="spr-demi">',
      '<option value="matin"', s.demiPeriode === 'matin' ? ' selected' : '', '>Matin</option>',
      '<option value="apresmidi"', s.demiPeriode === 'apresmidi' ? ' selected' : '', '>Après-midi</option>',
      '</select></div>']) : '';
    // §17.17.1 — le PAS des créneaux « heures précises » vient du serveur (regles.pas_minutes), jamais
    // codé en dur : modifier sresa_horaire_pas_minutes en config se propage sans redéployer le plugin.
    // Rendu via l'attribut step (en secondes) du champ time → le sélecteur ne propose que les minutes
    // du pas (00/15/30/45 pour un pas de 15). Repli 15 min si /tunnel/creneaux n'a pas répondu.
    var pasMin = pasMinutes();
    var stepAttr = ' step="' + (pasMin * 60) + '"';
    var heureFields = s.unite === 'heure' ? h(['<div class="spr-grid-2">',
      '<div class="spr-field"><label>Heure de début</label><input type="time"', stepAttr, ' id="spr-heure-debut" value="', esc(s.heureDebut), '"></div>',
      '<div class="spr-field"><label>Heure de fin</label><input type="time"', stepAttr, ' id="spr-heure-fin" value="', esc(s.heureFin), '"></div>',
      '</div>',
      '<div class="spr-hint">Créneaux par tranches de ', pasMin, ' minutes.</div>']) : '';

    // (30/08 soir) — masque une fois connecte : proposer une connexion a quelqu'un deja connecte
    // n'a pas de sens (le lien vers l'espace client reste utile, mais plus ce bandeau-la).
    var dejaClientHtml = state.identifie ? '' : h(['<div class="spr-already-client"><a href="', esc(ESPACE_CLIENT_URL), '" target="_blank" rel="noopener">Déjà client ? Retrouvez vos réservations</a></div>']);

    // (correctif 29/08 — proposer l'identification DÈS LE DÉBUT) Un locataire S-PACE identifié
    // voit ses tarifs dédiés (remise de statut) dès CET écran plutôt que de découvrir un prix
    // différent plus tard dans le parcours — cf. renderIdentifyPrompt(). Reste FACULTATIF (§ note
    // de cadrage) : un prospect qui ne se connecte pas ne voit rien de bloquant, juste ce lien
    // discret en plus de celui qui mène à l'espace client (dejaClientHtml, ci-dessus).
    // (31/08, ergonomie tunnel §2 — puis correctif reliquats v1.9.4 §1) — la note « éventuelles
    // remises », SANS CHIFFRER, vit désormais DANS renderIdentifyPrompt() (branche identifie),
    // conditionnée comme le badge : elle n'a rien à dire à un prospect non connecté. Voir le
    // commentaire dans renderIdentifyPrompt() ci-dessus pour le détail du bug corrigé.

    return dejaClientHtml + renderIdentifyPrompt() + h(['<div class="spr-card">',
      '<div class="spr-title">Réserver un espace</div>',
      '<div class="spr-subtitle">Recherchez la disponibilité d\'une salle ou d\'un bureau S-PACE.</div>',
      '<div class="spr-grid-2">',
      '<div class="spr-field"><label>Date</label><input type="date" id="spr-date" value="', esc(s.date), '"></div>',
      '<div class="spr-field"><label>Type d\'espace</label><select id="spr-type">',
      '<option value="salle_reunion"', s.typeReservation === 'salle_reunion' ? ' selected' : '', '>Salle de réunion</option>',
      '<option value="bureau"', s.typeReservation === 'bureau' ? ' selected' : '', '>Bureau</option>',
      '</select></div>',
      '</div>',
      '<div class="spr-grid-2">',
      '<div class="spr-field"><label>Durée</label><select id="spr-unite">',
      '<option value="journee"', s.unite === 'journee' ? ' selected' : '', '>Journée complète</option>',
      '<option value="demi_journee"', s.unite === 'demi_journee' ? ' selected' : '', '>Demi-journée</option>',
      '<option value="heure"', s.unite === 'heure' ? ' selected' : '', '>Heures précises</option>',
      '</select></div>',
      '<div class="spr-field"><label>Effectif</label><input type="number" min="1" id="spr-capacite" value="', esc(s.capaciteMin), '" placeholder="Nombre de personnes"></div>',
      '</div>',
      demiField, heureFields,
      (s.unite !== 'heure' && libelleCreneau()) ? h(['<div class="spr-hint">Horaires : ', esc(libelleCreneau()), '</div>']) : '',
      renderMultiDatesBlock(),
      '<div class="spr-actions spr-end"><button class="spr-btn spr-primary" id="spr-btn-rechercher"', state.loading ? ' disabled' : '', '>', state.loading ? 'Recherche…' : 'Rechercher', '</button></div>',
      '</div>']);
  }

  // (01/09, lot D court) — bloc « dates supplémentaires » de l'étape 1 : une ligne par date déjà
  // ajoutée (date + Durée, même vocabulaire Journée/Demi-journée + Période Matin/Après-midi que le
  // sélecteur principal ci-dessus et que le lot B côté assistant staff, app.js
  // detailAjouterJourForm) + un bouton « Ajouter une date ». Vide (state.datesSupp = []) → ce bloc
  // ne rend qu'un bouton d'ajout, la recherche reste mono-date (§ mono-date inchangé).
  function renderMultiDatesBlock() {
    var s = state.search;
    var rows = state.datesSupp.map(function (d) {
      var demiSel = d.unite === 'demi_journee';
      return h(['<div class="spr-multi-date-row">',
        '<div class="spr-field"><label>Date</label><input type="date" class="spr-multi-date-date" data-key="', d.key, '" value="', esc(d.date), '"></div>',
        '<div class="spr-field"><label>Durée</label><select class="spr-multi-date-unite" data-key="', d.key, '">',
        '<option value="journee"', d.unite === 'journee' ? ' selected' : '', '>Journée</option>',
        '<option value="demi_journee"', demiSel ? ' selected' : '', '>Demi-journée</option>',
        '</select></div>',
        demiSel ? h(['<div class="spr-field"><label>Période</label><select class="spr-multi-date-periode" data-key="', d.key, '">',
          '<option value="matin"', d.demiPeriode === 'matin' ? ' selected' : '', '>Matin</option>',
          '<option value="apresmidi"', d.demiPeriode === 'apresmidi' ? ' selected' : '', '>Après-midi</option>',
          '</select></div>']) : '',
        '<button type="button" class="spr-btn spr-ghost spr-multi-date-retirer" data-key="', d.key, '">Retirer</button>',
        '</div>']);
    }).join('');
    // « Heures précises » ne fait pas partie du vocabulaire multi-dates (lot B non plus) : on
    // n'invite pas à ajouter une date tant que la date principale est en heures précises, plutôt
    // que de proposer un mode qui obligerait à re-choisir une durée incompatible.
    var peutAjouter = s.unite !== 'heure';
    return h(['<div class="spr-multi-dates">',
      '<div class="spr-multi-dates-title">Plusieurs dates ?</div>',
      rows,
      peutAjouter
        ? '<button type="button" class="spr-btn" id="spr-btn-ajouter-date">+ Ajouter une date</button>'
        : '<div class="spr-hint">« Heures précises » n\'est pas proposé pour plusieurs dates.</div>',
      // (01/09 soir, lot D complet) — cette phrase ne peut plus annoncer « devis obligatoire » : un
      // client identifié peut désormais payer directement plusieurs dates en ligne (le mode réel
      // proposé, lui, est décidé étape 4 par le serveur — /options-paiement, jamais ici).
      state.datesSupp.length ? h(['<div class="spr-hint">Sur plusieurs dates, le paiement en ligne reste possible si vous êtes identifié(e) ; sinon nous établissons un devis.</div>']) : '',
      '</div>']);
  }

  // ---- Étape 2 : choix de la salle (tarif PAR SALLE) ----
  function renderStepSalle() {
    // (01/09, lot D court) — dispoActive() vaut EXACTEMENT state.disponibilite tant qu'aucune date
    // supplémentaire n'existe : rien ne change ici pour le mono-date.
    var multiJours = state.datesSupp.length > 0;
    var d = dispoActive();
    // (correctif 29/08) Bandeau d'identification repris ICI aussi, pas seulement à l'étape 1 : le
    // préremplissage depuis [space_disponibilite] (preferCode/prefillDate/capacité, cf. init())
    // saute directement l'étape 1 et atterrit ici — sans ce second point d'entrée, ce parcours-là
    // ne verrait jamais la proposition avant l'étape Paiement.
    var identifyBanner = renderIdentifyPrompt();
    if (!d || !d.espaces.length) {
      // (01/09, lot D court) — « aucune salle sur l'ENSEMBLE des dates » n'est pas la même
      // situation que le mono-date : jamais un mur — deux issues, comme le mono-date (§3, 31/08) :
      // modifier les dates, ou laisser ses coordonnées (renderListeAttenteBox, réutilisée telle
      // quelle).
      if (multiJours) {
        return identifyBanner + h(['<div class="spr-card">',
          '<div class="spr-title">Aucune disponibilité</div>',
          '<div class="spr-subtitle">Aucune salle n\'est libre sur ces ', (1 + state.datesSupp.length), ' dates. Essayez d\'autres dates, ou laissez-nous vos coordonnées.</div>',
          '<div class="spr-actions spr-end"><button class="spr-btn" id="spr-btn-retour1">← Modifier les dates</button></div>',
          renderListeAttenteBox(),
          '</div>']);
      }
      // (31/08, ergonomie tunnel §3) — DEUX issues, pas une : jusqu'ici le texte ne parlait que de
      // la liste d'attente alors que « Modifier la recherche » (une autre date, un autre effectif)
      // existait déjà en bouton — un client pouvait croire qu'il n'avait pas le choix. Le bouton
      // est aussi REMONTÉ au-dessus de la liste d'attente : « un client veut d'abord essayer autre
      // chose » (Olivier) — reste un .spr-btn discret (pas .spr-primary), ce n'est qu'un ORDRE.
      return identifyBanner + h(['<div class="spr-card">',
        '<div class="spr-title">Aucune disponibilité</div>',
        '<div class="spr-subtitle">Aucun espace n\'est libre pour ces critères. Essayez une autre date, ou laissez-nous vos coordonnées.</div>',
        '<div class="spr-actions spr-end"><button class="spr-btn" id="spr-btn-retour1">← Modifier la recherche</button></div>',
        renderListeAttenteBox(),
        '</div>']);
    }

    // (31/08, ergonomie tunnel §4) — Repli vers l'autre type d'espace (GET /tunnel/disponibilite,
    // type_repli) : SEULEMENT annoncé quand le serveur l'a réellement utilisé (aucun bureau/salle
    // n'a jamais été cherché « au cas où » — §4 hors périmètre, jamais systématique). Le message
    // nomme le type DEMANDÉ (state.search.typeReservation, ce qu'Olivier a tapé) et le type
    // RÉELLEMENT PROPOSÉ (d.type_repli) — jamais un « Aucune disponibilité » vrai mais inutile qui
    // laisserait partir un client sur une liste d'attente pour un créneau qui n'existera jamais.
    var repliBanner = d.type_repli
      ? h(['<div class="spr-banner spr-info">Aucun ', libelleTypeEspace(state.search.typeReservation, false),
        ' ne convient, mais ces ', libelleTypeEspace(d.type_repli, true), ' sont libres.</div>'])
      : '';
    var roomsHtml = d.espaces.map(function (e) {
      var sel = state.selectedEspaceId === e.id;
      // §17.11 — lien « Voir la salle » (nouvel onglet), affiché seulement si la fiche est
      // renseignée (sinon rien : pas de lien mort). Placé HORS du <label> pour que le clic
      // ouvre la fiche sans sélectionner la salle ni détourner du parcours.
      var ficheLink = e.url_fiche_site
        ? h(['<a class="spr-room-fiche" href="', esc(e.url_fiche_site), '" target="_blank" rel="noopener noreferrer">Voir la salle ↗</a>'])
        : '';
      // Surclassement : la salle est plus grande que le besoin. On le SIGNALE clairement (le client
      // doit comprendre qu'on lui propose plus grand) — et son tarif propre, plus élevé, est affiché
      // juste à côté (fini le « offert » : la salle réelle est facturée, décision Olivier).
      var tag = e.surclasse ? '<span class="spr-room-tag">Plus grande que votre besoin</span>' : '';
      var prixTtc = fmtTtc(e.tarif);
      var prixHt = fmtHt(e.tarif);
      // HT en avant / TTC en information (§4 — même hiérarchie que [space_disponibilite] et les
      // fiches salle du site public).
      var prixHtml = prixTtc
        ? h(['<div class="spr-room-price">',
          prixHt ? h(['<span class="spr-room-price-ht">', prixHt, '</span>']) : '',
          '<span class="spr-room-price-ttc">', prixTtc, '</span>',
          '</div>'])
        : '<div class="spr-room-price spr-room-price-devis">Sur devis</div>';
      return h(['<div class="spr-room-item">',
        '<label class="spr-room-option', sel ? ' spr-selected' : '', '">',
        '<input type="radio" name="spr-espace" value="', e.id, '"', sel ? ' checked' : '', '>',
        '<div class="spr-room-main"><div class="spr-room-name">', esc(e.nom), tag, '</div>',
        '<div class="spr-room-cap">Capacité ', esc(e.capacite), ' personnes</div></div>',
        prixHtml,
        '</label>',
        ficheLink,
        '</div>']);
    }).join('');

    var sel = espaceSelectionne();
    var montantTtc = fmtTtc(tarifSelection());
    var montantHt = fmtHt(tarifSelection());
    var recapSel = sel ? h(['<div class="spr-tarif-box">',
      '<span class="spr-tarif-lbl">', esc(sel.nom), sel.surclasse ? ' · plus grande que votre besoin' : '', '</span>',
      '<span class="spr-tarif-val">',
      montantTtc
        ? h([montantHt ? h(['<span class="spr-tarif-ht-inline">', esc(montantHt), ' · </span>']) : '', esc(montantTtc)])
        : 'Sur devis',
      '</span>',
      '</div>', renderAnnonceRemise()]) : '';

    var sousTitreDate = multiJours
      ? ((1 + state.datesSupp.length) + ' dates sélectionnées')
      : formatDateFr(state.search.date);

    // NANR (29/08, décision Olivier ; déplacé ÉTAPE 2 le 01/09 soir — § TEMPS 2 « propose ET
    // chiffre » : coché ici, chaque salle ci-dessus se rafraîchit à son tarif remisé, AVANT tout
    // engagement — le verrou reste à l'écran de confirmation, cf. renderStepRecap, avec son
    // propre rappel « réservation non annulable »). Proposé seulement si éligible (réservation à
    // 21 jours calendaires minimum sur le PREMIER jour demandé, cf. joursAvantDebut), jamais
    // coché par défaut — un choix qui se présente comme un choix, pas une case à décocher. Le
    // serveur reste seul décisionnaire (calculerTarif) ; ce conditionnement ne sert qu'à ne pas
    // montrer une case que le serveur refuserait de toute façon.
    var nanrHtml = '';
    if (eligibleNonRemboursable()) {
      // (02/11, `1.623`) Le pourcentage est celui du SERVEUR, et il n'est connu qu'une fois le
      // NANR accordé : à l'ouverture de cet écran (case non cochée) le serveur renvoie 0, donc
      // le titre ne chiffre rien ; il se chiffre dès que la case cochée revient accordée.
      var pctNanr = pctNonRemboursable();
      nanrHtml = h(['<label class="spr-nanr-box', state.nonRemboursable ? ' spr-selected' : '', '">',
        '<input type="checkbox" id="spr-nanr-toggle"', state.nonRemboursable ? ' checked' : '', '>',
        // (02/11, ajout d'Olivier au brief `1.624`) Le libelle disait « si elle est annulée »
        // quand le recapitulatif, lui, dit « non annulable » : l'un laissait croire qu'annuler
        // reste possible (avec des consequences), l'autre que non. Le titre porte desormais les
        // DEUX refus, et le texte dit la CONTREPARTIE — la remise — que l'ancien taisait : une
        // case qui n'enonce que ce qu'on perd ne dit pas ce qu'on achete.
        // ⚠️ AUCUN CHIFFRE dans le texte : le pourcentage est un reglage du serveur
        // (`sresa_remise_non_remboursable_pct`), et le suffixe « — -N % » du titre le porte deja,
        // rendu par le serveur apres cochage (`1.623`). L'ecrire ici le ferait mentir au premier
        // changement de reglage.
        '<div><div class="spr-po-title">Tarif non annulable et non remboursable', pctNanr != null ? ' — -' + pctNanr + ' %' : '', '</div>',
        '<div class="spr-po-sub">En contrepartie, vous bénéficiez d\'une remise sur le prix, affichée dès que vous cochez la case. Cette réservation ne pourra être ni annulée, ni remboursée, ni recréditée, ni modifiée en ligne (nous contacter reste possible, au cas par cas).</div></div>',
        '</label>']);
    }
    // (TEMPS 2, 01/09 soir) — § piège « décochage silencieux » : quand une nouvelle recherche a
    // dû décocher un NANR déjà choisi (dates modifiées, cf. bouton Rechercher étape 1), on ne se
    // contente pas d'afficher la case redevenue vide — on le DIT, une fois, ici même.
    // (02/11, ajout d'Olivier au brief `1.624`) « cochez-le a nouveau si vous le souhaitez
    // toujours » est un CONSEIL : il n'est vrai que si la case est encore proposee a la nouvelle
    // date. Quand elle ne l'est plus (eligibleNonRemboursable() faux : moins de 21 jours sur le
    // premier jour demande), ce message envoyait le client chercher une case qui n'existe plus a
    // l'ecran. On DIT alors pourquoi, au lieu de conseiller l'impossible. Meme condition, mot pour
    // mot, que celle qui decide d'afficher la case (nanrHtml ci-dessus) : les deux ne peuvent pas
    // diverger d'un cote et de l'autre.
    // Le message vient de v1.9.9 (59c0be3), pas des correctifs `1.622`/`1.623` du 02/11.
    var nanrNoticeHtml = '';
    if (state.nanrResetNotice) {
      nanrNoticeHtml = eligibleNonRemboursable()
        ? h(['<div class="spr-hint spr-hint-indispo">Vos dates ont changé : le tarif non remboursable n\'est plus sélectionné — cochez-le à nouveau si vous le souhaitez toujours.</div>'])
        : h(['<div class="spr-hint spr-hint-indispo">Vos dates ont changé : le tarif non remboursable n\'est pas disponible pour ces dates.</div>']);
    }

    return identifyBanner + h(['<div class="spr-card">',
      '<div class="spr-title">Choisissez votre espace</div>',
      '<div class="spr-subtitle">', sousTitreDate, ' — chaque salle est affichée à son tarif', multiJours ? ' total' : '', '.</div>',
      repliBanner,
      nanrHtml,
      renderNanrRefusHtml(),
      nanrNoticeHtml,
      renderCodePromoBox(),
      roomsHtml,
      recapSel,
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour1">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-continuer2"', state.selectedEspaceId ? '' : ' disabled', '>Continuer →</button>',
      '</div></div>']);
  }

  function renderListeAttenteBox() {
    return h(['<div class="spr-identify-box">',
      '<div class="spr-identify-title">Rejoindre la liste d\'attente</div>',
      '<div class="spr-identify-sub">Votre email suffit — nous vous préviendrons si ce créneau se libère.</div>',
      '<div class="spr-identify-row"><input type="email" id="spr-attente-email" placeholder="votre@email.fr">',
      '<button class="spr-btn spr-primary" id="spr-btn-attente">M\'inscrire</button></div>',
      '</div>']);
  }

  // (29/08, §3 « HT et TTC ») — le TTC redevient l'information DOMINANTE, le HT une note
  // secondaire entre parenthèses. C'est déjà la convention retenue à l'étape Récapitulatif
  // (§4, 25/08 — spr-recap-total en évidence, spr-recap-ht-info en dessous, discret) : l'étape
  // Options était la seule à afficher l'inverse (HT dominant, « 7.00 € HT (8.40 € TTC) »),
  // incohérence signalée par Olivier le 29/08. Même donnée (prix_ht), même taux 20 % que
  // montantOptionsTtc() — aucun second calcul.
  function libelleMontantTtcHt(prixHt) {
    var ttc = Number(prixHt) * 1.2;
    return h(['<span class="spr-montant-ttc">', ttc.toFixed(2), ' € TTC</span>',
      ' <span class="spr-option-price-secondary">(', Number(prixHt).toFixed(2), ' € HT)</span>']);
  }

  // Ligne récap d'une pause déjà ajoutée (étape 3) — MODIFIABLE et SUPPRIMABLE (§4 diagnostic :
  // sinon il faut tout recommencer). Le prix affiché reprend la même formule que
  // montantOptionsHt() (prix_ht × nombre_personnes, quelle que soit l'unité) pour ne jamais
  // diverger de l'estimation totale plus bas dans le tunnel.
  function renderPauseLigne(pz, cat) {
    var formule = cat.pauses.filter(function (p) { return String(p.id) === String(pz.formule_id); })[0];
    var uniteMot = formule && formule.unite_facturation === 'forfait' ? 'lot(s)' : 'pers.';
    var montant = formule && formule.prix_ht != null
      ? libelleMontantTtcHt(Number(formule.prix_ht) * (Number(pz.nombre_personnes) || 0))
      : 'Prix à définir';
    return h(['<div class="spr-pause-line">',
      '<div class="spr-pause-line-info">',
      '<div class="spr-pause-line-nom">', esc(formule ? formule.nom : 'Formule'), '</div>',
      '<div class="spr-pause-line-detail">', esc(pz.heure_pause), ' — ', pz.nombre_personnes, ' ', uniteMot, ' — ', montant, '</div>',
      '</div>',
      '<div class="spr-pause-line-actions">',
      '<button type="button" class="spr-btn spr-ghost spr-pause-modifier" data-pause-key="', pz.key, '">Modifier</button>',
      '<button type="button" class="spr-btn spr-ghost spr-pause-supprimer" data-pause-key="', pz.key, '">Supprimer</button>',
      '</div></div>']);
  }

  // ---- Étape 3 : options ----
  function renderStepOptions() {
    var cat = state.optionsCatalogue;
    if (!cat) return '<div class="spr-card spr-loading">Chargement des options…</div>';

    // (29/08, §1 « le bouton et la modale ») — remplace les six lignes de quantité (une par
    // formule active) par une liste récap des pauses déjà ajoutées + UN bouton « + Ajouter une
    // pause » qui ouvre la modale (nom, descriptif, prix — sans compresser). Plusieurs pauses
    // sont désormais possibles (le backend l'acceptait déjà, cf. options.pauses[] côté
    // construirePayload), chacune avec son propre horaire.
    var pausesRecap = state.pauses.map(function (pz) { return renderPauseLigne(pz, cat); }).join('');
    var pausesHtml = cat.pauses.length
      ? h([pausesRecap ? '<div class="spr-pause-list">' + pausesRecap + '</div>' : '',
        '<button type="button" class="spr-btn" id="spr-btn-ajouter-pause">+ Ajouter une pause</button>'])
      : '<div class="spr-subtitle">Aucune pause disponible.</div>';

    var restauRow = cat.restauration.length ? h(['<div class="spr-option-row"><div><div class="spr-option-name">Plateau repas</div>',
      '<div class="spr-option-price">', libelleMontantTtcHt(cat.restauration[0].prix_ht), ' / personne</div></div>',
      '<div class="spr-qty"><button id="spr-restau-minus">−</button><span>', state.selectedRestauration, '</span><button id="spr-restau-plus">+</button></div>',
      '</div>']) : '';

    var amenagementHtml = cat.amenagements.length ? h(['<div class="spr-field"><label>Aménagement</label><select id="spr-amenagement">',
      '<option value="">Aucun</option>',
      cat.amenagements.map(function (a) {
        // Un <select> natif ignore tout balisage dans ses <option> — texte brut, TTC d'abord
        // (même inversion qu'ailleurs sur cette étape).
        return '<option value="' + a.id + '"' + (state.selectedAmenagementId === a.id ? ' selected' : '') + '>' + esc(a.nom) + ' (+' + (Number(a.prix_ht) * 1.2).toFixed(2) + ' € TTC / +' + Number(a.prix_ht).toFixed(2) + ' € HT)</option>';
      }).join(''),
      '</select></div>']) : '';

    // (correctif 30/08 soir) Repris ICI aussi, comme aux étapes 1, 2 et 4 : sans ce bandeau, un
    // client identifié dès l'étape 2 voyait le badge « ✓ Connecté » disparaître à cette étape
    // avant de réapparaître à l'étape 4 — incohérence d'affichage relevée en traçant le trou
    // principal (cf. init()), pas un bug de logique mais une inconsistance qui laisse croire que
    // rien n'était pris en compte entre-temps.
    var identifyBanner = renderIdentifyPrompt();

    return identifyBanner + h(['<div class="spr-card">',
      '<div class="spr-title">Options complémentaires</div>',
      '<div class="spr-subtitle">Facultatif — vous pouvez continuer sans rien sélectionner.</div>',
      pausesHtml, restauRow, amenagementHtml,
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour2">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-continuer3">Continuer →</button>',
      '</div></div>']);
  }

  // Modale « Ajouter/Modifier une pause » (§1) — nom, DESCRIPTIF (sresa_formules.descriptif,
  // migration 063 — peut être vide si Olivier n'a pas encore rempli cette formule), prix, sans
  // compresser. Le select formule déclenche un render() (pour rafraîchir descriptif/prix/libellé
  // effectif-ou-lots), les deux autres champs se contentent de mettre l'état à jour (repris tels
  // quels si un changement de formule redessine la modale).
  function renderPauseModal() {
    var cat = state.optionsCatalogue;
    var m = state.pauseModal;
    var formule = cat.pauses.filter(function (p) { return String(p.id) === String(m.formule_id); })[0];
    var uniteLabel = formule && formule.unite_facturation === 'forfait' ? 'Nombre de lots' : 'Effectif (personnes)';
    var uniteMot = formule && formule.unite_facturation === 'forfait' ? 'lot' : 'personne';
    var prixInfo = formule && formule.prix_ht != null
      ? h(['<div class="spr-pause-modal-prix">', libelleMontantTtcHt(formule.prix_ht), ' / ', uniteMot, '</div>'])
      : '';
    var descriptifInfo = formule && formule.descriptif
      ? h(['<div class="spr-pause-modal-descriptif">', esc(formule.descriptif), '</div>'])
      : '';

    return h(['<div class="spr-modal-overlay" id="spr-pause-modal-overlay"><div class="spr-modal">',
      '<div class="spr-modal-title">', m.editKey ? 'Modifier la pause' : 'Ajouter une pause', '</div>',
      '<div class="spr-field"><label>Formule</label><select id="spr-pause-formule">',
      cat.pauses.map(function (p) {
        return '<option value="' + p.id + '"' + (String(p.id) === String(m.formule_id) ? ' selected' : '') + '>' + esc(p.nom) + '</option>';
      }).join(''),
      '</select></div>',
      descriptifInfo, prixInfo,
      '<div class="spr-grid-2">',
      '<div class="spr-field"><label>', esc(uniteLabel), '</label><input type="number" min="1" step="1" id="spr-pause-effectif" value="', esc(m.nombre_personnes), '"></div>',
      '<div class="spr-field"><label>Heure</label><input type="time" id="spr-pause-heure" value="', esc(m.heure_pause), '"></div>',
      '</div>',
      '<div class="spr-actions spr-end">',
      '<button type="button" class="spr-btn" id="spr-pause-modal-annuler">Annuler</button>',
      '<button type="button" class="spr-btn spr-primary" id="spr-pause-modal-valider">', m.editKey ? 'Enregistrer' : 'Ajouter', '</button>',
      '</div>',
      '</div></div>']);
  }

  // Remplace state.pauses en gardant l'ancienne valeur pour l'annulation (cran ②, §4 diagnostic —
  // JAMAIS une confirmation avant l'action, seulement une possibilité de revenir en arrière juste
  // après, ~6s). Rien n'est envoyé au serveur ici : les pauses ne sont créées qu'à la soumission
  // finale du tunnel (POST /tunnel/reserver) — l'« annulation » est donc un pur retour d'état
  // local, pas un second appel réseau comme côté assistant interne (detailAmenagementChange).
  function definirPauses(nouvelles, libelle) {
    if (_pauseUndoTimer) { clearTimeout(_pauseUndoTimer); _pauseUndoTimer = null; }
    var precedentes = state.pauses;
    state.pauses = nouvelles;
    state.pauseUndo = { libelle: libelle, precedentes: precedentes };
    render();
    _pauseUndoTimer = setTimeout(function () {
      _pauseUndoTimer = null;
      state.pauseUndo = null;
      render();
    }, 6000);
  }

  function annulerActionPause() {
    if (_pauseUndoTimer) { clearTimeout(_pauseUndoTimer); _pauseUndoTimer = null; }
    if (state.pauseUndo) { state.pauses = state.pauseUndo.precedentes; state.pauseUndo = null; }
    render();
  }

  function ouvrirModalePause(editKey) {
    var cat = state.optionsCatalogue;
    if (!cat || !cat.pauses.length) return;
    if (editKey) {
      var pz = state.pauses.filter(function (x) { return x.key === editKey; })[0];
      if (!pz) return;
      state.pauseModal = { editKey: editKey, formule_id: pz.formule_id, nombre_personnes: pz.nombre_personnes, heure_pause: pz.heure_pause };
    } else {
      // Pré-remplissage de l'effectif (même principe que la modale pause côté staff, 25/08,
      // [[sresa_modale_pause_trois_defauts_2026_08_25]]) : par_personne → effectif déjà saisi à
      // la recherche (state.search.capaciteMin), jamais deviné pour un forfait (un nombre de
      // lots par défaut serait faux).
      var premiere = cat.pauses[0];
      var effectifDefaut = premiere.unite_facturation === 'forfait' ? '' : (state.search.capaciteMin || '');
      state.pauseModal = { editKey: null, formule_id: premiere.id, nombre_personnes: effectifDefaut, heure_pause: heureParDefautPause() };
    }
    render();
  }

  function fermerModalePause() {
    state.pauseModal = null;
    render();
  }

  function validerModalePause() {
    var m = state.pauseModal;
    if (!m) return;
    var cat = state.optionsCatalogue;
    // (module-level, PAS bindEvents) — byId n'existe qu'à l'intérieur de bindEvents() ; ici,
    // comme le reste des fonctions de ce niveau (doIdentify, etc.), on lit le DOM directement.
    var formuleId = Number(document.getElementById('spr-pause-formule').value);
    var formule = cat.pauses.filter(function (p) { return p.id === formuleId; })[0];
    var effectif = parseInt(document.getElementById('spr-pause-effectif').value, 10);
    var heure = document.getElementById('spr-pause-heure').value;
    if (!formule) { state.error = 'Choisissez une formule.'; render(); return; }
    if (!effectif || effectif < 1) { state.error = formule.unite_facturation === 'forfait' ? 'Indiquez un nombre de lots valide.' : 'Indiquez un effectif valide.'; render(); return; }
    if (!heure) { state.error = 'Choisissez une heure pour la pause.'; render(); return; }
    state.error = null;

    var uniteMot = formule.unite_facturation === 'forfait' ? 'lot(s)' : 'pers.';
    var nouvelles, libelle;
    if (m.editKey) {
      nouvelles = state.pauses.map(function (pz) {
        return pz.key === m.editKey ? { key: pz.key, formule_id: formuleId, nombre_personnes: effectif, heure_pause: heure } : pz;
      });
      libelle = 'Pause modifiée : ' + formule.nom + ', ' + effectif + ' ' + uniteMot + ', ' + heure + '.';
    } else {
      nouvelles = state.pauses.concat([{ key: ++_pauseKeySeq, formule_id: formuleId, nombre_personnes: effectif, heure_pause: heure }]);
      libelle = 'Pause ajoutée : ' + formule.nom + ', ' + effectif + ' ' + uniteMot + ', ' + heure + '.';
    }
    state.pauseModal = null;
    definirPauses(nouvelles, libelle);
  }

  function supprimerPause(key) {
    var pz = state.pauses.filter(function (x) { return x.key === key; })[0];
    var cat = state.optionsCatalogue;
    var formule = pz && cat ? cat.pauses.filter(function (p) { return String(p.id) === String(pz.formule_id); })[0] : null;
    var nouvelles = state.pauses.filter(function (x) { return x.key !== key; });
    definirPauses(nouvelles, 'Pause supprimée' + (formule ? (' : ' + formule.nom) : '') + '.');
  }

  // ---- Étape 4 : identification + mode de paiement + coordonnées ----
  function renderStepPaiement() {
    // (01/09 soir, lot D complet) — §8 : SEULS 'credit_salle'/'sur_facture' restent réservés au
    // mono-jour (confirmation/débit immédiat sur plusieurs jours à la fois n'a jamais été demandé).
    // 'devis' et — depuis ce soir — 'en_ligne' sont acceptés en multi-dates (le serveur les accepte
    // tous les deux, routes/tunnel.js POST /reserver ; tout autre mode y reste refusé en 400). On ne
    // force donc PLUS `state.modePaiement = 'devis'` à chaque rendu — ça empêchait purement et
    // simplement de sélectionner 'en_ligne' quand plusieurs dates sont demandées. Le pré-choix par
    // défaut, lui, reste posé une seule fois par chargerOptionsPaiement() (pas ici, pas à chaque rendu).
    var multiJours = state.datesSupp.length > 0;
    var identifBlock;
    if (state.identifie) {
      // (31/08, §6) — même badge que renderIdentifyPrompt() (étapes 1-3), désormais partagé via
      // renderConnectedChip() : le lien « Gérer mes réservations » ne doit manquer nulle part.
      identifBlock = renderConnectedChip();
    } else {
      identifBlock = h(['<div class="spr-identify-box">',
        // (31/08, §1) — même titre que renderIdentifyPrompt() : une seule formulation.
        '<div class="spr-identify-title">Déjà client ?</div>',
        '<div class="spr-identify-sub">Identifiez-vous pour accéder à votre crédit salle ou à la facturation fin de mois.</div>',
        '<div class="spr-identify-row"><input type="email" id="spr-identify-email" placeholder="votre@email.fr">',
        '<button class="spr-btn" id="spr-btn-identify">Recevoir mon lien</button></div>',
        '</div>']);
    }

    var op = state.optionsPaiement || {};
    var options = [{ value: 'devis', title: 'Demande de devis', sub: 'Nous vous recontactons pour finaliser votre réservation.' }];
    // (30/08, chantier SIRET dans le tunnel) — « Un nouveau client NE RÉSERVE PAS EN LIGNE » :
    // un client NON identifié (pas de lien magique résolu) ne voit QUE « Demande de devis »,
    // quoi que dise le serveur sur la disponibilité du paiement en ligne/crédit/facture — leur
    // proposer un mode que POST /reserver refusera ensuite (403, §3 du cadrage) serait un mur
    // après coup. Un client identifié garde tous les modes, sous réserve de ce que dit le serveur.
    // (01/09 soir, lot D complet) — le paiement en ligne (Stripe) est désormais proposé aussi en
    // multi-dates : seul op.paiement_en_ligne_disponible décide (§17.14, la règle vit côté serveur,
    // evaluerPaiementEnLigne n'exclut plus plusieurs jours). Crédit salle et facture fin de mois,
    // EUX, restent réservés au mono-jour (§8, décision jamais rouverte : confirmer/débiter
    // immédiatement sur plusieurs jours à la fois n'a jamais été demandé) — jamais un choix que
    // l'envoi refuserait ensuite (« un formulaire qui propose ce qu'il refuse est pire qu'un
    // formulaire contraint », 31/08).
    if (state.identifie) {
      // §4.9 — Paiement en ligne par carte : proposé UNIQUEMENT si le SERVEUR le déclare possible
      // (Stripe configuré, créneau non contesté, dans les horaires…) — pour CHAQUE jour demandé.
      // La règle est portée par l'endpoint /options-paiement (§17.14). Visible DÈS LE CHOIX.
      if (op.paiement_en_ligne_disponible) {
        options.push({ value: 'en_ligne', title: 'Paiement en ligne par carte', sub: 'Réservation confirmée immédiatement après le paiement (paiement sécurisé Stripe).' });
      }
      if (!multiJours && op.credit_disponible) {
        options.push({ value: 'credit_salle', title: 'Crédit salle', sub: 'Solde disponible : ' + op.credit_solde_heures + ' h' });
      }
      if (!multiJours && op.paiement_fin_mois_disponible) {
        // (correctif 29/08 — ouverture du règlement sur facture) Le sous-texte vient TEL QUEL du
        // serveur (paiement_fin_mois_libelle, /tunnel/options-paiement — lib/creditSalle.js::
        // libelleFacturation) : même rédaction que le mail n°3, jamais réécrite ici. Repli si le
        // champ manque (ancienne version d'API) : ne bloque pas l'affichage de l'option.
        options.push({ value: 'sur_facture', title: 'Facture fin de mois', sub: op.paiement_fin_mois_libelle || 'Réservation confirmée immédiatement.' });
      }
    }
    // §17.19 — Le POURQUOI, dès le choix. Quand le paiement en ligne n'est pas proposé, on affiche
    // TEL QUEL le message décidé par le serveur (options-paiement → paiement_en_ligne_message) :
    // créneau contesté, hors-horaires, délai court (message combiné pour hors+délai). Aucune phrase
    // codée en dur ici ; le plugin n'invente ni ne décide (§17.14). Pour le hors-horaires, on
    // complète avec le SURCOÛT chiffré (accès autonome) fourni par regles_horaires, s'il est non nul.
    // RÉSERVÉ au client identifié (ci-dessus) : pour un nouveau client, l'absence de paiement en
    // ligne n'est pas un motif d'indisponibilité ponctuelle, c'est la politique du tunnel.
    var indispoNote = '';
    // (01/09 soir, lot D complet) — le mur générique « multi-dates = devis obligatoire » disparaît :
    // seul un motif RÉEL rendu par le serveur (op.paiement_en_ligne_message) explique maintenant
    // l'absence de paiement en ligne, multi-dates ou pas. Crédit salle / facture fin de mois restent
    // silencieusement absents en multi-dates (mêmes deux modes qu'avant, aucun mur à expliquer :
    // seule leur ABSENCE de la liste le dit, comme pour un client non identifié).
    if (state.identifie && !op.paiement_en_ligne_disponible && op.paiement_en_ligne_message) {
      var reg = op.regles_horaires;
      var surcout = '';
      if (reg && reg.hors_horaires && reg.hors_horaires.concerne && Number(reg.hors_horaires.surcout_ht) > 0) {
        surcout = ' Supplément d\'accès hors horaires estimé : +' + Number(reg.hors_horaires.surcout_ht).toFixed(2) + ' € HT.';
      }
      // (30/08 soir, §17.24) — le message serveur dit déjà « une majoration jour férié s'applique »
      // (lib/reglesHoraires.js::construireMessageCombine), sans chiffre. On complète ICI avec le
      // montant réel (majorationFerieLignes(), chargé par le même appel /options-paiement) — même
      // logique que le surcoût hors-horaires ci-dessus, jamais un second texte inventé.
      var majoLignes = majorationFerieLignes();
      if (majoLignes.length) {
        surcout += ' Majoration : +' + fmtMontant(montantMajorationFerieTtc()) + '.';
      }
      indispoNote = h(['<div class="spr-hint spr-hint-indispo">', esc(op.paiement_en_ligne_message), esc(surcout), '</div>']);
    }

    var paymentHtml = options.map(function (o) {
      var selp = state.modePaiement === o.value;
      return h(['<label class="spr-payment-option', selp ? ' spr-selected' : '', '">',
        '<input type="radio" name="spr-mode" value="', o.value, '"', selp ? ' checked' : '', '>',
        '<div><div class="spr-po-title">', esc(o.title), '</div><div class="spr-po-sub">', esc(o.sub), '</div></div>',
        '</label>']);
    }).join('');

    var contactHtml = state.identifie ? '' : renderContactNouveauClient();

    // NANR — DÉPLACÉ à l'étape 2 (renderStepSalle) le 01/09 soir, § TEMPS 2 : proposé et chiffré
    // dès le choix de la salle plutôt que découvert ici. state.nonRemboursable (posé là-bas) est
    // simplement REPRIS tel quel par construirePayload() à l'envoi — rien à recalculer ici.

    // (30/08) SIRET déjà connu (§3) : le parcours normal (commentaire + Continuer) n'a plus lieu
    // d'être — la seule action possible est de demander le lien de connexion (panneau rendu par
    // renderContactNouveauClient, déjà inclus dans contactHtml). On garde « ← Retour » (permet
    // de changer de salle) mais on retire « Continuer » : POST /reserver la refuserait de toute
    // façon (409, §3), autant ne pas présenter un bouton qui mène à un mur.
    var siretConnuBloquant = !state.identifie && state.contact.type === 'professionnel'
      && state.siretLookup && state.siretLookup.deja_client;

    return h(['<div class="spr-card">',
      '<div class="spr-title">Paiement &amp; coordonnées</div>',
      identifBlock,
      '<div class="spr-payment-choice">', paymentHtml, '</div>',
      indispoNote,
      contactHtml,
      siretConnuBloquant ? '' : renderHorairesAnticipes(),
      siretConnuBloquant ? '' : h(['<div class="spr-field"><label>Commentaire (optionnel)</label><textarea id="spr-commentaire" rows="3">', esc(state.commentaire), '</textarea></div>']),
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour3">← Retour</button>',
      siretConnuBloquant ? '' : '<button class="spr-btn spr-primary" id="spr-btn-continuer4">Continuer →</button>',
      '</div></div>']);
  }

  // Texte "commentaire" pour la demande d'horaires anticipes — rien ecrit dans sresa_jours par ce
  // parcours (une demande n'est pas un accord) : juste un texte lisible par l'equipe, au meme
  // endroit que le commentaire libre du client.
  function texteHorairesAnticipes() {
    var ha = state.horaireAnticipe;
    var lignes = [];
    if (ha.avant) lignes.push("Demande : arriver avant l'ouverture" + (ha.avantHeure ? (' vers ' + ha.avantHeure) : '') + '.');
    if (ha.apres) lignes.push('Demande : partir après la fermeture' + (ha.apresHeure ? (' vers ' + ha.apresHeure) : '') + '.');
    return lignes.join(' ');
  }

  // ---- Horaires anticipés (30/08 soir, correctif post-test Olivier) ----
  // Une DEMANDE seulement — voir commentaire sur state.horaireAnticipe ci-dessus. Déclenche trois
  // fragments de consigne côté staff s'ils sont un jour accordés (badge la veille, fenêtres,
  // autonomie) : on ne les envoie donc JAMAIS depuis ce parcours, on se contente de signaler la
  // demande à l'équipe (commentaire_general, lu par notificationEquipeTunnel.js).
  function renderHorairesAnticipes() {
    var ha = state.horaireAnticipe;
    // (31/08, ergonomie tunnel §5) — jusqu'ici imbriquées dans un <div class="spr-field"> : le
    // sélecteur CSS `.spr-field input` (pensé pour les text/select/textarea, largeur 100%, cadre
    // épais) s'appliquait AUSSI à ces cases à cocher, qui héritaient donc d'un cadre pleine largeur
    // séparant visuellement la case du libellé — cause réelle du rendu signalé par Olivier, pas
    // un simple choix de style. Ce sont des CASES, pas des choix majeurs (Olivier) : plus de cadre
    // .spr-payment-option ici, motif .spr-checkbox-line dédié (case + libellé sur une ligne, sans
    // bordure). Le titre n'est plus un <label> de .spr-field (uppercase, cf. tunnel.css) : un
    // simple intitulé de section, comme les autres titres du tunnel (jamais en capitales).
    return h(['<div class="spr-horaires-anticipes">',
      '<div class="spr-horaires-anticipes-title">Besoin d\'un horaire particulier ?</div>',
      '<label class="spr-checkbox-line">',
      '<input type="checkbox" id="spr-ha-avant"', ha.avant ? ' checked' : '', '>',
      "<span>J'ai besoin d'arriver avant l'ouverture</span>",
      '</label>',
      ha.avant ? h(['<div class="spr-field"><label>Heure d\'arrivée souhaitée (facultatif)</label><input type="time" id="spr-ha-avant-heure" value="', esc(ha.avantHeure), '"></div>']) : '',
      '<label class="spr-checkbox-line">',
      '<input type="checkbox" id="spr-ha-apres"', ha.apres ? ' checked' : '', '>',
      '<span>Je dois partir après la fermeture</span>',
      '</label>',
      ha.apres ? h(['<div class="spr-field"><label>Heure de départ souhaitée (facultatif)</label><input type="time" id="spr-ha-apres-heure" value="', esc(ha.apresHeure), '"></div>']) : '',
      (ha.avant || ha.apres) ? h(['<div class="spr-hint">Ceci est une demande, pas une confirmation — nous reviendrons vers vous.</div>']) : '',
      '</div>']);
  }

  // ---- Bloc coordonnées d'un NOUVEAU client (30/08, chantier SIRET dans le tunnel) ----
  // §1 : choix pro/particulier explicite (un champ, jamais déduit). §2 : préremplissage par
  // BOUTON (jamais automatique), correction toujours possible, établissement fermé signalé sans
  // bloquer. §3 : un SIRET déjà connu de Vigie n'affiche plus le formulaire de création — juste
  // le renvoi vers le lien de connexion existant (2h, POST /client/demander-lien, aucun second
  // mécanisme). Extrait de renderStepPaiement pour rester lisible.
  function renderContactNouveauClient() {
    var typeHtml = h(['<div class="spr-field">',
      '<label>Vous réservez en tant que</label>',
      '<div class="spr-payment-choice">',
      '<label class="spr-payment-option', state.contact.type === 'professionnel' ? ' spr-selected' : '', '">',
      '<input type="radio" name="spr-c-type" value="professionnel"', state.contact.type === 'professionnel' ? ' checked' : '', '>',
      '<div class="spr-po-title">Professionnel</div></label>',
      '<label class="spr-payment-option', state.contact.type === 'particulier' ? ' spr-selected' : '', '">',
      '<input type="radio" name="spr-c-type" value="particulier"', state.contact.type === 'particulier' ? ' checked' : '', '>',
      '<div class="spr-po-title">Particulier</div></label>',
      '</div></div>']);

    if (!state.contact.type) {
      // Rien d'autre tant que le choix n'est pas fait — §1 « un champ, pas une déduction ».
      return h(['<div class="spr-contact-nouveau">', typeHtml, '</div>']);
    }

    if (state.contact.type === 'particulier') {
      return h(['<div class="spr-contact-nouveau">', typeHtml,
        '<div class="spr-grid-2">',
        '<div class="spr-field"><label>Nom complet</label><input type="text" id="spr-c-raison" value="', esc(state.contact.raison_sociale), '"></div>',
        '<div class="spr-field"><label>Téléphone</label><input type="tel" id="spr-c-telephone" value="', esc(state.contact.telephone), '"></div>',
        '</div>',
        '<div class="spr-field"><label>Email</label><input type="email" id="spr-c-email" value="', esc(state.contact.email), '"></div>',
        '</div>']);
    }

    // --- Professionnel ---
    var lk = state.siretLookup;

    // §3 — SIRET déjà connu de Vigie : on n'affiche plus le formulaire de création, seulement le
    // renvoi vers le lien de connexion. « Personne à qui envoyer le lien » (a_contact:false) ≠
    // « mauvais email » (correspond:false) — deux messages différents, jamais un mur muet.
    if (lk && lk.deja_client) {
      var panneauConnu;
      if (lk.a_contact === false) {
        panneauConnu = h(['<div class="spr-banner spr-info">',
          "Ce SIRET a déjà un compte chez nous, mais nous n'avons aucun contact enregistré pour l'y joindre. ",
          'Merci de nous contacter directement : <strong>05 46 50 46 86</strong>.</div>']);
      } else {
        panneauConnu = h(['<div class="spr-identify-box">',
          '<div class="spr-identify-title">Ce SIRET a déjà un compte chez nous.</div>',
          '<div class="spr-identify-sub">Saisissez votre adresse email — nous vous envoyons un lien pour réserver (valable 2 heures).</div>',
          '<div class="spr-identify-row"><input type="email" id="spr-siret-connu-email" placeholder="votre@email.fr" value="', esc(state.siretConnuEmail), '">',
          '<button class="spr-btn" id="spr-btn-siret-connu-envoyer"', state.siretConnuLoading ? ' disabled' : '', '>',
          state.siretConnuLoading ? 'Vérification…' : 'Recevoir mon lien', '</button></div>',
          state.siretConnuMessage ? h(['<div class="spr-hint', state.siretConnuMessage.type === 'erreur' ? ' spr-hint-indispo' : '', '">', esc(state.siretConnuMessage.text), '</div>']) : '',
          '</div>']);
      }
      return h(['<div class="spr-contact-nouveau">', typeHtml,
        panneauConnu,
        '<div class="spr-hint"><a href="#" id="spr-siret-connu-retour">Ce n\'est pas le bon SIRET ?</a></div>',
        '</div>']);
    }

    var siretHint = '';
    if (state.siretLookupLoading) {
      siretHint = h(['<div class="spr-hint">Recherche en cours…</div>']);
    } else if (lk && lk.trouve === false) {
      // §2 — SIRET introuvable : ne bloque jamais, juste un rappel que la saisie reste manuelle
      // (un SIRET tout neuf peut ne pas être encore publié).
      siretHint = h(['<div class="spr-hint">SIRET introuvable auprès du répertoire des entreprises — vous pouvez saisir les informations manuellement ci-dessous.</div>']);
    } else if (lk && lk.trouve && lk.etablissement_ferme) {
      // §2 — Établissement fermé : SIGNALÉ, jamais bloquant — le client sait peut-être quelque
      // chose que l'API ignore encore (§ « l'API peut être en retard sur la réalité »).
      siretHint = h(['<div class="spr-hint spr-hint-indispo">',
        'Cet établissement est fermé — vérifiez le numéro. Vous pouvez tout de même continuer, ou nous appeler au <strong>05 46 50 46 86</strong>.',
        '</div>']);
    }

    return h(['<div class="spr-contact-nouveau">', typeHtml,
      '<div class="spr-grid-2">',
      '<div class="spr-field"><label>SIRET</label>',
      '<div class="spr-identify-row"><input type="text" inputmode="numeric" maxlength="14" id="spr-c-siret" placeholder="14 chiffres" value="', esc(state.contact.siret), '">',
      '<button class="spr-btn" id="spr-btn-siret-lookup"', state.siretLookupLoading ? ' disabled' : '', '>Remplir depuis le SIRET</button></div>',
      siretHint,
      '</div>',
      '<div class="spr-field"><label>Nom du contact</label><input type="text" id="spr-c-nom" value="', esc(state.contact.nom), '"></div>',
      '</div>',
      '<div class="spr-grid-2">',
      '<div class="spr-field"><label>Raison sociale</label><input type="text" id="spr-c-raison" value="', esc(state.contact.raison_sociale), '"></div>',
      '<div class="spr-field"><label>Adresse de facturation</label><input type="text" id="spr-c-adresse" value="', esc(state.contact.adresse_facturation), '"></div>',
      '</div>',
      '<div class="spr-grid-2">',
      '<div class="spr-field"><label>Email</label><input type="email" id="spr-c-email" value="', esc(state.contact.email), '"></div>',
      '<div class="spr-field"><label>Téléphone</label><input type="tel" id="spr-c-telephone" value="', esc(state.contact.telephone), '"></div>',
      '</div>',
      '</div>']);
  }

  // ===================== CGPS (02/11, `1.624`) =====================
  // UNE SEULE case, pour la reservation ENTIERE (jamais une par date), a l'ecran qui precede
  // l'envoi : le recapitulatif est le seul passage oblige des QUATRE fins de parcours (devis,
  // credit salle, facture fin de mois, paiement en ligne). Ses deux boutons — « Envoyer ma
  // demande » / « Continuer vers le paiement » et « Reserver sans le code » — menent tous les
  // deux a doReserver(), seul appelant de POST /tunnel/reserver : c'est pourquoi le verrou vit
  // dans doReserver() et non sur un bouton (cf. la garde la-bas).
  // Le libelle ne DIT PAS ce que les CGPS contiennent (non remboursable, annulation, delai) : le
  // texte juridique vit a son adresse, et le resumer ici creerait une seconde version a tenir.
  // Cadre de la meme famille que la case du tarif non remboursable (.spr-nanr-box) : aucun style
  // neuf, et la meme grammaire visuelle pour les deux seules cases a cocher du parcours.
  // ⚠️ La boite est un <div>, pas un <label> comme .spr-nanr-box : un lien a l'interieur d'un
  // <label> ferait basculer la case EN MEME TEMPS qu'il ouvre l'onglet. Le <label for=…> ne
  // couvre donc que les mots, et le lien reste un lien.
  function renderCgpsBox() {
    // Le lien s'ouvre dans un nouvel onglet : le parcours en cours — et tout ce qui a ete saisi —
    // survit a la lecture du texte. `rel="noopener noreferrer"` va avec `target="_blank"`.
    var lien = h(['<a href="', esc(CGPS_URL), '" target="_blank" rel="noopener noreferrer">',
      'conditions générales de prestations de services</a>']);
    // Le refus DU SERVEUR prime sur le rappel local : s'il a parle, c'est sa phrase qui compte.
    var messageHtml = '';
    if (state.cgpsRefus) {
      messageHtml = h(['<div class="spr-hint spr-hint-indispo">', esc(state.cgpsRefus), '</div>']);
    } else if (state.cgpsManquante) {
      messageHtml = h(['<div class="spr-hint spr-hint-indispo">Merci d\'accepter les conditions ',
        'générales de prestations de services pour envoyer votre demande.</div>']);
    }
    return h(['<div class="spr-nanr-box', state.cgpsAcceptees ? ' spr-selected' : '', '">',
      '<input type="checkbox" id="spr-cgps-toggle"', state.cgpsAcceptees ? ' checked' : '', '>',
      '<div><div class="spr-po-title">',
      '<label for="spr-cgps-toggle">J\'ai lu et j\'accepte les </label>', lien,
      '</div></div>',
      '</div>', messageHtml]);
  }

  // Le focus se replace APRES render(), qui reecrit tout le DOM : l'element d'avant n'existe
  // plus. focus() amene lui-meme la case dans la vue, sans second mecanisme de defilement.
  // ⚠️ PAS `byId` ICI. `byId` est une variable LOCALE de bindEvents() (plus bas dans ce fichier),
  // et le fichier le dit deja : « byId n'existe qu'a l'interieur de bindEvents() ». Appele depuis
  // le module, il levait un ReferenceError — le focus ne se posait JAMAIS, et l'erreur sortait du
  // gestionnaire de clic sans rien casser d'autre a l'ecran, puisque render() avait deja eu lieu.
  // Un defaut entierement silencieux, que seule une assertion lisant document.activeElement a vu.
  function focusCgps() {
    var el = document.getElementById('spr-cgps-toggle');
    if (el && el.focus) el.focus();
  }

  // ---- Étape 5 : récapitulatif ----
  function renderStepRecap() {
    var multiJours = state.datesSupp.length > 0;
    var espace = espaceSelectionne();
    // §4.9/§4.17 ext. — le total DOIT porter salle + options (bug corrigé le 24/08, cf.
    // montantSelection). On détaille les deux lignes dès que des options sont sélectionnées, pour que
    // le client voie explicitement ce qu'il paie en plus de la salle (jamais un total muet).
    var salleTtc = fmtTtc(tarifSelection());
    var optionsMontant = montantOptionsTtc();
    // (30/08 soir, §17.24) — une majoration jour férié ne doit jamais gonfler un total « Salle »
    // muet sans qu'on voie POURQUOI : si elle est seule (aucune autre option), la ligne Salle doit
    // quand même se détailler, sinon le client verrait « Majoration : 60 € / Total : X € » sans
    // jamais savoir ce que vaut la salle seule.
    var majorationLignes = majorationFerieLignes();
    var showSalleLine = (optionsMontant > 0 || majorationLignes.length > 0) && salleTtc;
    var montantTtc = fmtMontantTotal();
    // §4 « à l'écran de paiement, le TTC reste dominant, le HT en information » — cette étape
    // précède l'envoi/le paiement (mode déjà choisi) : même hiérarchie qu'à l'étape 7 ci-dessous.
    var montantHt = fmtMontantTotalHt();
    var modeLabels = { devis: 'Demande de devis', en_ligne: 'Paiement en ligne par carte', credit_salle: 'Crédit salle', sur_facture: 'Facture fin de mois' };
    var enLigne = state.modePaiement === 'en_ligne';

    // (01/09, lot D court) — une ligne PAR DATE, MÊME FORMAT que le mail n°4 (§5 du cadrage :
    // « Lundi 21 septembre — Après-midi (14:00–18:00) », lib/emailToutEstPret.js::libelleDureeJour)
    // + le prix de CE jour pour la salle choisie (state.disponibiliteMulti.parJour, posé par
    // doRechercheMulti — tarif linéaire en duree, donc le prix par jour est exact, pas une
    // approximation). Mono-date : une seule ligne « Date », strictement inchangée.
    var dateLignesHtml;
    if (multiJours && state.disponibiliteMulti) {
      var joursTries = [{ date: state.search.date, unite: state.search.unite, demiPeriode: state.search.demiPeriode }]
        .concat(state.datesSupp)
        .slice()
        .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
      dateLignesHtml = joursTries.map(function (j) {
        var pj = state.disponibiliteMulti.parJour.filter(function (x) { return x.date === j.date; })[0];
        var tarifJour = (pj && espace) ? pj.especesParId[espace.id] : null;
        var prix = (tarifJour && !tarifJour.erreur) ? fmtTtc(tarifJour) : '';
        return h(['<div class="spr-recap-line"><span>', esc(ligneJourLabel(j.date, j.unite, j.demiPeriode)), '</span><span>', prix, '</span></div>']);
      }).join('');
    } else {
      dateLignesHtml = h(['<div class="spr-recap-line"><span>Date</span><span>', formatDateFr(state.search.date), '</span></div>']);
    }

    // (31/08, §6) — le badge (et « Gérer mes réservations ») suit désormais le client à TOUTES
    // les étapes, pas seulement 1 à 4.
    return (state.identifie ? renderConnectedChip() : '') + h(['<div class="spr-card">',
      '<div class="spr-title">Récapitulatif</div>',
      '<div class="spr-recap-line"><span>Espace</span><span>', esc(espace ? espace.nom : ''), espace && espace.surclasse ? ' (plus grande)' : '', '</span></div>',
      dateLignesHtml,
      '<div class="spr-recap-line"><span>Effectif</span><span>', esc(state.search.capaciteMin), ' personnes</span></div>',
      '<div class="spr-recap-line"><span>Paiement</span><span>', modeLabels[state.modePaiement] || state.modePaiement, '</span></div>',
      // (TEMPS 2, 01/09 soir) — le NANR est désormais PROPOSÉ et CHIFFRÉ dès l'étape 2 (Salle),
      // mais le VERROU (l'engagement réel) reste ICI : c'est ce récapitulatif que
      // « spr-btn-envoyer » envoie à doReserver(), jamais l'étape 2. Le rappel explicite
      // « réservation non annulable » vit donc à CET écran, juste avant l'envoi — pas seulement
      // dans la case à cocher deux étapes plus tôt, que le client a pu cocher puis oublier.
      // (02/11, `1.622`) Ce que le SERVEUR a accordé, pas ce que la case dit : `state.nonRemboursable`
      // seul affichait « Non remboursable » et « Réservation non annulable » alors que le prix juste
      // en dessous était le prix STANDARD — l'écran promettait un engagement et une remise que la
      // réservation n'aurait pas eus. Refusé : on le DIT, à la place, sans rien promettre.
      // (`1.623`) Le pourcentage vient du même tarif ; absent ou 0, la ligne ne chiffre pas.
      nanrAccordeParServeur() ? h(['<div class="spr-recap-line"><span>Tarif</span><span>Non remboursable', pctNonRemboursable() != null ? ' (-' + pctNonRemboursable() + '%)' : '', '</span></div>',
        '<div class="spr-hint spr-hint-nanr">Réservation non annulable : elle ne sera ni remboursée ni recréditée, et ne pourra plus être modifiée en ligne.</div>'])
        : renderNanrRefusHtml(),
      // (25/09) Code promo — dit à l'écran qu'on relit avant d'envoyer, avec son sort réel : un code
      // saisi mais écarté par le non-cumul ne doit pas laisser croire qu'il joue sur ce prix.
      state.codePromo ? h(['<div class="spr-recap-line"><span>Code promo</span><span>', esc(libelleRecapCode()), '</span></div>']) : '',
      showSalleLine ? h(['<div class="spr-recap-line"><span>Salle</span><span>', salleTtc, '</span></div>']) : '',
      optionsMontant > 0 ? h(['<div class="spr-recap-line"><span>Options</span><span>', fmtMontant(optionsMontant), '</span></div>']) : '',
      renderMajorationFerie(),
      montantTtc ? h(['<div class="spr-recap-line spr-recap-total"><span>Montant', enLigne ? ' à régler' : ' estimé', ' TTC</span><span>', montantTtc, '</span></div>']) : '',
      montantHt ? h(['<div class="spr-recap-line spr-recap-ht-info"><span>dont HT</span><span>', montantHt, '</span></div>']) : '',
      renderAnnonceRemise(),
      renderCodeRefusEnvoi(),
      // (02/11, `1.624`) La case CGPS, juste au-dessus des boutons : c'est ici que le client
      // valide, et une case lue deux etapes plus tot est une case oubliee — meme raison que le
      // rappel « reservation non annulable » quelques lignes au-dessus. Posee SANS condition :
      // tout parcours du tunnel passe par cet ecran, quel que soit le mode de reglement, le
      // nombre de dates, et que le client soit identifie ou non.
      renderCgpsBox(),
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour4">← Retour</button>',
      // (25/09) Après un refus du code à la confirmation, « Envoyer ma demande » rejouerait le même
      // refus : le bouton d'envoi cède la place au choix réel — réserver sans le code, au prix que
      // le serveur vient d'annoncer (il est écrit sur le bouton). « ← Retour » reste offert.
      state.codeRefusEnvoi
        ? h(['<button class="spr-btn spr-primary" id="spr-btn-sans-code"', state.loading ? ' disabled' : '', '>',
          state.loading ? 'Envoi…' : ('Réserver sans le code' + (state.codeRefusEnvoi.tarifSansCodeTtc != null
            ? ' — salle à ' + Number(state.codeRefusEnvoi.tarifSansCodeTtc).toFixed(2) + ' € TTC' : '')),
          '</button>'])
        : h(['<button class="spr-btn spr-primary" id="spr-btn-envoyer"', state.loading ? ' disabled' : '', '>',
          state.loading ? 'Envoi…' : (enLigne ? 'Continuer vers le paiement →' : 'Envoyer ma demande'), '</button>']),
      '</div></div>']);
  }

  // ---- Étape 6 : confirmation (ou prise en compte si conflit §17.14) ----
  function renderStepConfirmation() {
    var r = state.resultat;
    // §17.14 — prise en compte : un conflit d'agenda a été détecté à la confirmation. On ne montre
    // JAMAIS un refus sec (le client a rempli tout son parcours) : on affiche le message de prise en
    // compte renvoyé par le serveur, l'équipe revient vers lui.
    // (31/08, §6) — badge/lien à toutes les étapes, y compris la confirmation finale.
    var chip = state.identifie ? renderConnectedChip() : '';
    if (state.aRevoir) {
      return chip + h(['<div class="spr-card spr-confirm-box">',
        '<div class="spr-confirm-icon">⏳</div>',
        '<div class="spr-title">Demande prise en compte</div>',
        '<div class="spr-subtitle">', esc(state.messageClient || 'Votre demande a bien été prise en compte. Notre équipe revient vers vous très vite pour la confirmer.'),
        r && r.reservation && r.reservation.numero_devis ? h([' Référence : ', esc(r.reservation.numero_devis), '.']) : '',
        '</div>',
        '</div>']);
    }
    var paye = r && r.reservation && (r.reservation.statut_paiement === 'paye' || state.modePaiement === 'en_ligne');
    return chip + h(['<div class="spr-card spr-confirm-box">',
      '<div class="spr-confirm-icon">✓</div>',
      '<div class="spr-title">', paye ? 'Paiement confirmé' : 'Demande envoyée', '</div>',
      '<div class="spr-subtitle">Référence : ', esc(r && r.reservation ? r.reservation.numero_devis : ''), '. ',
      paye ? 'Votre réservation est confirmée.' : 'Vous recevrez une confirmation par email très prochainement.',
      ' Un email vous a été adressé.</div>',
      '</div>']);
  }

  // ---- Étape 7 : paiement en ligne (Stripe Payment Element) ----
  function renderStepPaiementStripe() {
    // §4.9/§4.17 ext. — même correctif qu'à l'étape récap (24/08) : le montant affiché ici DOIT être
    // celui réellement débité par Stripe, soit salle + options (le serveur crée le PaymentIntent sur
    // ce total, cf. routes/tunnel.js POST /reserver). Afficher la salle seule aurait laissé un écart
    // entre ce texte et la carte bancaire du client au moment précis où il paie.
    var montantTtc = fmtMontantTotal();
    // §4 « à l'écran de PAIEMENT, le TTC reste dominant, le HT en information » — c'est le montant
    // réellement débité par la carte que le client doit lire en premier.
    var montantHt = fmtMontantTotalHt();
    // (31/08, §6) — badge/lien à toutes les étapes, y compris le paiement Stripe.
    return (state.identifie ? renderConnectedChip() : '') + h(['<div class="spr-card">',
      '<div class="spr-title">Paiement sécurisé</div>',
      '<div class="spr-subtitle">', montantTtc ? ('Montant à régler : ' + montantTtc + '.') : '',
      montantHt ? h([' <span class="spr-montant-ht-info">(dont ', montantHt, ')</span>']) : '',
      ' Paiement par carte via Stripe.</div>',
      renderAnnonceRemise(),
      '<div id="spr-stripe-element" class="spr-stripe-element"><div class="spr-loading">Chargement du module de paiement…</div></div>',
      '<div id="spr-stripe-status" class="spr-stripe-status"></div>',
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour-pay">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-payer">', montantTtc ? ('Payer ' + montantTtc.replace(' TTC', '')) : 'Payer', '</button>',
      '</div></div>']);
  }

  // ===================== ÉVÉNEMENTS =====================
  function bindEvents() {
    var byId = function (id) { return document.getElementById(id); };

    // (correctif 29/08) Le bouton d'identification peut désormais apparaître à l'étape 1, 2 OU 4
    // (renderIdentifyPrompt est repris à ces trois endroits) — câblé une seule fois ici, hors du
    // if/else par étape ci-dessous, plutôt que dupliqué dans chaque branche.
    if (byId('spr-btn-identify')) byId('spr-btn-identify').onclick = doIdentify;

    // (29/08, refonte modale pause) — bandeau d'annulation et modale rendus HORS du if/else par
    // étape (même motif que le bouton d'identification ci-dessus) : la modale ne s'ouvre qu'à
    // l'étape 3, mais son câblage n'a pas besoin d'être dupliqué par étape.
    if (byId('spr-pause-undo-btn')) byId('spr-pause-undo-btn').onclick = annulerActionPause;
    if (state.pauseModal) {
      if (byId('spr-pause-formule')) byId('spr-pause-formule').onchange = function (e) { state.pauseModal.formule_id = Number(e.target.value); render(); };
      if (byId('spr-pause-effectif')) byId('spr-pause-effectif').onchange = function (e) { state.pauseModal.nombre_personnes = e.target.value; };
      if (byId('spr-pause-heure')) byId('spr-pause-heure').onchange = function (e) { state.pauseModal.heure_pause = e.target.value; };
      if (byId('spr-pause-modal-annuler')) byId('spr-pause-modal-annuler').onclick = fermerModalePause;
      if (byId('spr-pause-modal-valider')) byId('spr-pause-modal-valider').onclick = validerModalePause;
      // Clic sur le fond (hors carte) = Annuler — jamais sur la carte elle-même.
      if (byId('spr-pause-modal-overlay')) byId('spr-pause-modal-overlay').onclick = function (e) { if (e.target.id === 'spr-pause-modal-overlay') fermerModalePause(); };
    }

    if (state.step === 1) {
      if (byId('spr-date')) byId('spr-date').onchange = function (e) { state.search.date = e.target.value; };
      if (byId('spr-type')) byId('spr-type').onchange = function (e) { state.search.typeReservation = e.target.value; };
      if (byId('spr-unite')) byId('spr-unite').onchange = function (e) {
        state.search.unite = e.target.value;
        // (01/09, lot D court) — « heures précises » n'est pas géré en multi-dates (§ hors
        // périmètre) : basculer dessus efface les dates supplémentaires plutôt que de laisser un
        // état incohérent (un bouton « Ajouter une date » qui n'existerait déjà plus).
        if (state.search.unite === 'heure' && state.datesSupp.length) { state.datesSupp = []; }
        render();
      };
      if (byId('spr-capacite')) byId('spr-capacite').onchange = function (e) { state.search.capaciteMin = e.target.value; };
      if (byId('spr-demi')) byId('spr-demi').onchange = function (e) { state.search.demiPeriode = e.target.value; render(); };
      if (byId('spr-heure-debut')) byId('spr-heure-debut').onchange = function (e) { state.search.heureDebut = e.target.value; render(); };
      if (byId('spr-heure-fin')) byId('spr-heure-fin').onchange = function (e) { state.search.heureFin = e.target.value; render(); };
      // (01/09, lot D court) — bloc « dates supplémentaires » : ajout/retrait/édition d'une ligne.
      if (byId('spr-btn-ajouter-date')) byId('spr-btn-ajouter-date').onclick = ajouterDateSupp;
      document.querySelectorAll('.spr-multi-date-date').forEach(function (el) {
        el.onchange = function (e) { changerDateSupp(Number(el.dataset.key), 'date', e.target.value); };
      });
      document.querySelectorAll('.spr-multi-date-unite').forEach(function (el) {
        el.onchange = function (e) { changerDateSupp(Number(el.dataset.key), 'unite', e.target.value); render(); };
      });
      document.querySelectorAll('.spr-multi-date-periode').forEach(function (el) {
        el.onchange = function (e) { changerDateSupp(Number(el.dataset.key), 'demiPeriode', e.target.value); };
      });
      document.querySelectorAll('.spr-multi-date-retirer').forEach(function (el) {
        el.onclick = function () { retirerDateSupp(Number(el.dataset.key)); };
      });
      // Fonction nommée (pas doRecherche directement) : un handler onclick reçoit le MouseEvent en
      // 1er argument, qui atterrirait sinon dans preferCode (§1.5.0, préremplissage) — sans effet
      // réel (aucune salle ne matche jamais un événement), mais pas la peine de compter dessus.
      // (TEMPS 2, 01/09 soir) — § piège « décochage silencieux » : nanrResetNotice n'est armé que
      // si une remise ÉTAIT réellement cochée (jamais de bannière quand il n'y avait rien à
      // perdre) ; lu une seule fois par renderStepSalle(), puis éteint dès que l'utilisateur
      // retouche la case (toggleNonRemboursable) ou relance une nouvelle recherche.
      if (byId('spr-btn-rechercher')) byId('spr-btn-rechercher').onclick = function () {
        state.nanrResetNotice = state.nonRemboursable;
        state.nonRemboursable = false;
        lancerRecherche();
      };
    } else if (state.step === 2) {
      document.querySelectorAll('input[name="spr-espace"]').forEach(function (r) {
        r.onchange = function (e) { state.selectedEspaceId = Number(e.target.value); render(); };
      });
      // NANR — déplacé ici (étape 2) le 01/09 soir, § TEMPS 2 : voir renderStepSalle() pour le
      // rendu de la case, toggleNonRemboursable() pour le re-calcul (mono ET multi-dates).
      if (byId('spr-nanr-toggle')) byId('spr-nanr-toggle').onchange = toggleNonRemboursable;
      // (25/09) Code promo — même écran que le tarif non remboursable. La valeur est relue sur le
      // champ vivant au clic (cf. appliquerCodePromo) : un clic direct sur « Appliquer » sans
      // quitter le champ ne déclenche pas forcément son onchange.
      if (byId('spr-code-input')) {
        byId('spr-code-input').onchange = function (e) { state.codePromoSaisie = e.target.value; };
        byId('spr-code-input').onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); appliquerCodePromo(); }
        };
      }
      if (byId('spr-code-appliquer')) byId('spr-code-appliquer').onclick = appliquerCodePromo;
      if (byId('spr-code-retirer')) byId('spr-code-retirer').onclick = retirerCodePromo;
      if (byId('spr-btn-retour1')) byId('spr-btn-retour1').onclick = function () { state.step = 1; render(); };
      if (byId('spr-btn-continuer2')) byId('spr-btn-continuer2').onclick = function () { state.step = 3; loadOptions(); };
      if (byId('spr-btn-attente')) byId('spr-btn-attente').onclick = doListeAttente;
    } else if (state.step === 3) {
      if (byId('spr-btn-ajouter-pause')) byId('spr-btn-ajouter-pause').onclick = function () { ouvrirModalePause(null); };
      document.querySelectorAll('.spr-pause-modifier').forEach(function (b) {
        b.onclick = function () { ouvrirModalePause(Number(b.dataset.pauseKey)); };
      });
      document.querySelectorAll('.spr-pause-supprimer').forEach(function (b) {
        b.onclick = function () { supprimerPause(Number(b.dataset.pauseKey)); };
      });
      if (byId('spr-restau-plus')) byId('spr-restau-plus').onclick = function () { state.selectedRestauration++; render(); };
      if (byId('spr-restau-minus')) byId('spr-restau-minus').onclick = function () { state.selectedRestauration = Math.max(0, state.selectedRestauration - 1); render(); };
      if (byId('spr-amenagement')) byId('spr-amenagement').onchange = function (e) { state.selectedAmenagementId = e.target.value ? Number(e.target.value) : null; };
      if (byId('spr-btn-retour2')) byId('spr-btn-retour2').onclick = function () { state.step = 2; render(); };
      if (byId('spr-btn-continuer3')) byId('spr-btn-continuer3').onclick = function () { state.step = 4; chargerOptionsPaiement(); };
    } else if (state.step === 4) {
      document.querySelectorAll('input[name="spr-mode"]').forEach(function (r) {
        r.onchange = function (e) { state.modePaiement = e.target.value; render(); };
      });
      // (30/08) Changer de type pro/particulier repart d'un formulaire propre — un SIRET/une
      // recherche déjà faits pour l'autre type n'ont pas de sens une fois basculé.
      document.querySelectorAll('input[name="spr-c-type"]').forEach(function (r) {
        r.onchange = function (e) {
          state.contact.type = e.target.value;
          state.siretLookup = null; state.siretApiSnapshot = null;
          state.siretConnuEmail = ''; state.siretConnuMessage = null;
          render();
        };
      });
      ['spr-c-raison', 'spr-c-nom', 'spr-c-email', 'spr-c-telephone', 'spr-c-siret', 'spr-c-adresse'].forEach(function (id) {
        var field = {
          'spr-c-raison': 'raison_sociale', 'spr-c-nom': 'nom', 'spr-c-email': 'email',
          'spr-c-telephone': 'telephone', 'spr-c-siret': 'siret', 'spr-c-adresse': 'adresse_facturation',
        }[id];
        if (byId(id)) byId(id).onchange = function (e) { state.contact[field] = e.target.value; };
      });
      if (byId('spr-btn-siret-lookup')) byId('spr-btn-siret-lookup').onclick = doSiretLookup;
      if (byId('spr-siret-connu-email')) byId('spr-siret-connu-email').onchange = function (e) { state.siretConnuEmail = e.target.value; };
      if (byId('spr-btn-siret-connu-envoyer')) byId('spr-btn-siret-connu-envoyer').onclick = doSiretConnuEnvoyer;
      if (byId('spr-siret-connu-retour')) byId('spr-siret-connu-retour').onclick = function (e) {
        e.preventDefault();
        state.siretLookup = null; state.siretConnuEmail = ''; state.siretConnuMessage = null;
        render();
      };
      if (byId('spr-commentaire')) byId('spr-commentaire').onchange = function (e) { state.commentaire = e.target.value; };
      if (byId('spr-ha-avant')) byId('spr-ha-avant').onchange = function (e) { state.horaireAnticipe.avant = e.target.checked; render(); };
      if (byId('spr-ha-avant-heure')) byId('spr-ha-avant-heure').onchange = function (e) { state.horaireAnticipe.avantHeure = e.target.value; };
      if (byId('spr-ha-apres')) byId('spr-ha-apres').onchange = function (e) { state.horaireAnticipe.apres = e.target.checked; render(); };
      if (byId('spr-ha-apres-heure')) byId('spr-ha-apres-heure').onchange = function (e) { state.horaireAnticipe.apresHeure = e.target.value; };
      if (byId('spr-btn-retour3')) byId('spr-btn-retour3').onclick = function () { state.step = 3; render(); };
      if (byId('spr-btn-continuer4')) byId('spr-btn-continuer4').onclick = function () {
        if (!state.identifie) {
          // §1 — un champ, pas une déduction : le choix doit être fait avant tout le reste.
          if (!state.contact.type) {
            state.error = 'Merci d\'indiquer si vous réservez en tant que professionnel ou particulier.';
            render();
            return;
          }
          if (state.contact.type === 'professionnel') {
            if (!/^\d{14}$/.test(state.contact.siret || '')) {
              state.error = 'Le SIRET doit comporter 14 chiffres.';
              render();
              return;
            }
            if (!state.contact.raison_sociale || !state.contact.adresse_facturation || !state.contact.email) {
              state.error = 'Merci de renseigner au moins la raison sociale, l\'adresse de facturation et l\'email.';
              render();
              return;
            }
          } else if (!state.contact.raison_sociale || !state.contact.email) {
            state.error = 'Merci de renseigner au moins votre nom et votre email.';
            render();
            return;
          }
          // (30/08 soir, correctif post-test Olivier) — telephone obligatoire, pro ET particulier :
          // tous les refus de geste espace client renvoient vers "appelez-nous", l'equipe doit donc
          // toujours avoir un numero pour rappeler. 10 chiffres — un numero etranger (belge, suisse)
          // n'en fait pas 10 : signale, non assoupli pour l'instant (reserve documentee, pas un
          // correctif de ce chantier).
          if (!/^\d{10}$/.test((state.contact.telephone || '').replace(/[\s.\-]/g, ''))) {
            state.error = 'Le téléphone doit comporter 10 chiffres.';
            render();
            return;
          }
        }
        state.error = null;
        state.step = 5;
        render();
      };
    } else if (state.step === 5) {
      if (byId('spr-btn-retour4')) byId('spr-btn-retour4').onclick = function () { state.step = 4; render(); };
      if (byId('spr-btn-envoyer')) byId('spr-btn-envoyer').onclick = doReserver;
      // (25/09) Code promo refusé à la confirmation : le choix « réserver sans le code ».
      if (byId('spr-btn-sans-code')) byId('spr-btn-sans-code').onclick = reserverSansCode;
      // (02/11, `1.624`) La case CGPS. On repasse par render() (comme la case du tarif non
      // remboursable) : le cadre doit suivre l'etat coche, et le rappel « merci d'accepter… »
      // disparaitre des que c'est fait. Cocher efface aussi un refus du serveur deja affiche —
      // le prochain envoi portera le booleen, ce refus-la n'a plus cours.
      if (byId('spr-cgps-toggle')) byId('spr-cgps-toggle').onchange = function (e) {
        state.cgpsAcceptees = !!e.target.checked;
        if (state.cgpsAcceptees) { state.cgpsManquante = false; state.cgpsRefus = null; }
        render();
      };
    } else if (state.step === 7) {
      if (byId('spr-btn-retour-pay')) byId('spr-btn-retour-pay').onclick = function () {
        // Retour au récap : on repart proprement (le PaymentIntent créé reste en attente côté Stripe,
        // sans effet — la réservation reste en 'simulation' tant qu'aucun paiement n'aboutit).
        state.step = 5; state.stripeMounted = false; state.error = null; render();
      };
      if (byId('spr-btn-payer')) byId('spr-btn-payer').onclick = doPayer;
      if (!state.stripeMounted) initStripePayment();
    }
  }

  // ===================== ACTIONS =====================
  // preferCode (1.5.0, préremplissage depuis [space_disponibilite]) : code d'une salle à
  // présélectionner dans les résultats si elle y figure — sinon repli sur le 1er résultat
  // (comportement inchangé). La salle a pu être prise entre la recherche de dispo et l'arrivée ici :
  // ne jamais bloquer sur ce cas, juste retomber sur le choix normal.
  function doRecherche(preferCode, conserverEtape) {
    var s = state.search;
    // (correctif 29/08) Retourne toujours une Promise résolue, y compris sur ces deux sorties
    // anticipées — doRecherche() est désormais chaînée par init() (reprise après identification,
    // ci-dessous) : un appelant qui fait .then() dessus ne doit jamais tomber sur `undefined`.
    if (!s.date || !s.capaciteMin) {
      state.error = 'Merci de renseigner une date et un effectif.';
      render();
      return Promise.resolve();
    }
    var estHeure = s.unite === 'heure';
    if (estHeure && (!s.heureDebut || !s.heureFin)) {
      state.error = 'Merci de renseigner une heure de début et de fin.';
      render();
      return Promise.resolve();
    }
    state.loading = true;
    state.error = null;
    render();

    // Grille = source unique (§17.13) : pour la journée / demi-journée on N'EMBARQUE PAS d'heures
    // dans les dates — on envoie la date seule + le créneau, et le serveur applique la grille
    // (sresa_horaire_*). Pour « heures précises », on envoie les heures saisies par le client.
    var creneau = computeCreneau();
    var dateDebut = estHeure ? (s.date + 'T' + s.heureDebut + ':00') : s.date;
    var dateFin = estHeure ? (s.date + 'T' + s.heureFin + ':00') : s.date;
    var qs = '?date_debut=' + encodeURIComponent(dateDebut) + '&date_fin=' + encodeURIComponent(dateFin)
      + '&capacite_min=' + encodeURIComponent(s.capaciteMin) + '&unite=' + encodeURIComponent(s.unite)
      + '&duree=' + encodeURIComponent(computeDuree()) + '&type_reservation=' + encodeURIComponent(s.typeReservation)
      + (creneau ? '&creneau=' + encodeURIComponent(creneau) : '')
      + (estHeure ? '&heure_debut=' + encodeURIComponent(s.heureDebut) + '&heure_fin=' + encodeURIComponent(s.heureFin) : '')
      + '&non_remboursable=' + (state.nonRemboursable ? '1' : '0')
      // (25/09) Code promo — le paramètre que /tunnel/disponibilite accepte DÉJÀ (18/09, aucun
      // appelant jusqu'ici). C'est le serveur qui applique, écarte ou refuse : chaque salle listée
      // revient à son prix remisé (e.tarif) avec son `code_statut`. Rien n'est transmis tant que la
      // saisie n'a pas été vérifiée valide (state.codePromo reste null).
      + (state.codePromo ? '&code=' + encodeURIComponent(state.codePromo) : '')
      // (1.7.2) Le token d'identification voyage desormais jusqu'a /tunnel/disponibilite — meme
      // convention que /client/moi?token= — pour qu'un client deja identifie voie la remise qui
      // s'applique DES cet ecran, au lieu de decouvrir un prix different au recapitulatif.
      + (state.token ? '&token=' + encodeURIComponent(state.token) : '');

    var espaceAvant = state.selectedEspaceId;
    // (correctif 29/08) Retourne désormais la promesse — jusqu'ici perdue, ce qui empêchait tout
    // appelant (notamment la reprise après identification, cf. init()) de savoir QUAND le tarif
    // rafraîchi était disponible avant d'enchaîner (chargerOptionsPaiement a besoin du montant
    // à jour). Les appelants existants (onclick) ignorent la valeur de retour — comportement
    // inchangé pour eux.
    return api('/tunnel/disponibilite' + qs).then(function (data) {
      state.disponibilite = data;
      // (30/08 soir, correctif post-test Olivier) — identifie/identite_info arrivent desormais avec
      // CETTE reponse (routes/tunnel.js /disponibilite), pas seulement a l'etape 4
      // (chargerOptionsPaiement) : le badge « Connecte » peut donc s'afficher des l'etape 1, y
      // compris juste apres le rechargement automatique au retour d'un lien email (init() rejoue
      // deja doRecherche() avec le token — seul l'affichage manquait).
      state.identifie = !!data.identifie;
      state.identiteInfo = data.identite_info || null;
      var prefere = preferCode ? data.espaces.filter(function (e) { return String(e.code) === String(preferCode); })[0] : null;
      var conserve = (!preferCode && espaceAvant) ? data.espaces.filter(function (e) { return e.id === espaceAvant; })[0] : null;
      state.selectedEspaceId = prefere ? prefere.id : (conserve ? conserve.id : (data.espaces.length ? data.espaces[0].id : null));
      state.loading = false;
      if (!conserverEtape) state.step = 2;
      render();
    }).catch(function (err) {
      state.loading = false;
      state.error = err.message;
      render();
    });
  }

  // ===================== LOT D COURT (01/09) — RECHERCHE ET ACTIONS MULTI-DATES =====================
  // Point d'entrée unique du bouton « Rechercher » de l'étape 1 : bascule vers la recherche
  // multi-dates dès qu'au moins une date supplémentaire existe, sinon appelle EXACTEMENT
  // doRecherche() (mono-date), sans aucun changement à cette fonction — § mono-date inchangé.
  function lancerRecherche() {
    if (state.datesSupp.length) { doRechercheMulti(); return; }
    doRecherche();
  }

  function ajouterDateSupp() {
    state.datesSupp.push({ key: ++_dateSuppKeySeq, date: '', unite: 'journee', demiPeriode: 'matin' });
    render();
  }

  function retirerDateSupp(key) {
    state.datesSupp = state.datesSupp.filter(function (d) { return d.key !== key; });
    render();
  }

  function changerDateSupp(key, field, value) {
    var d = state.datesSupp.filter(function (x) { return x.key === key; })[0];
    if (!d) return;
    d[field] = value;
  }

  // Recherche sur PLUSIEURS dates (non nécessairement consécutives) : une salle n'est retenue que
  // si elle est libre sur TOUTES les dates demandées — une requête GET /tunnel/disponibilite par
  // date (même endpoint que le mono-date, duree=1 comme toujours pour journee/demi_journee),
  // puis intersection des identifiants de salle côté client (aucun endpoint combiné côté serveur,
  // cf. cadrage « rien à construire côté disponibilité partielle » — chaque appel, lui, est déjà
  // du serveur qui accepte). Le tarif de chaque salle candidate est la SOMME de son tarif propre
  // sur chaque date (calculerTarif est linéaire en duree — lib/tarification.js — sommer les
  // tarifs par jour d'une même salle donne exactement le même total que le regroupement par unité
  // fait côté serveur à la création, cf. routes/tunnel.js POST /reserver).
  // (correctif 01/09) `conserverEtape` — même paramètre que doRecherche(), pour la même raison :
  // la restauration du snapshot d'identification (init(), consumeSnapshot()) cible l'étape
  // quittée pour s'identifier, qui peut être Salle/Options/Paiement (2/3/4), pas seulement la
  // recherche. Sans ce paramètre, un client identifié depuis l'étape Paiement en plein
  // multi-dates retombait à l'étape Salle après le rafraîchissement automatique — la donnée
  // (dates, salle choisie) restait juste, mais l'écran revenait en arrière sans raison visible.
  function doRechercheMulti(conserverEtape) {
    var s = state.search;
    if (!s.date || !s.capaciteMin) {
      state.error = 'Merci de renseigner une date et un effectif.';
      render();
      return Promise.resolve();
    }
    var toutesDates = [{ date: s.date, unite: s.unite, demiPeriode: s.demiPeriode }].concat(state.datesSupp);
    for (var i = 0; i < toutesDates.length; i++) {
      if (!toutesDates[i].date) {
        state.error = 'Merci de renseigner toutes les dates ajoutées, ou de retirer celles qui sont vides.';
        render();
        return Promise.resolve();
      }
    }
    var vues = {};
    for (var k = 0; k < toutesDates.length; k++) {
      if (vues[toutesDates[k].date]) {
        state.error = 'Chaque date ne peut être ajoutée qu\'une seule fois.';
        render();
        return Promise.resolve();
      }
      vues[toutesDates[k].date] = true;
    }

    state.loading = true;
    state.error = null;
    render();

    var requetes = toutesDates.map(function (j) {
      var creneau = j.unite === 'demi_journee' ? (j.demiPeriode === 'apresmidi' ? 'apres_midi' : 'matin') : undefined;
      var qs = '?date_debut=' + encodeURIComponent(j.date) + '&date_fin=' + encodeURIComponent(j.date)
        + '&capacite_min=' + encodeURIComponent(s.capaciteMin) + '&unite=' + encodeURIComponent(j.unite)
        + '&duree=1&type_reservation=' + encodeURIComponent(s.typeReservation)
        + (creneau ? '&creneau=' + encodeURIComponent(creneau) : '')
        // (TEMPS 2, 01/09 soir) — CORRECTIF : ce paramètre était codé en dur à 0, quel que soit
        // state.nonRemboursable — cocher le NANR en multi-dates n'avait donc jusqu'ici AUCUN
        // effet sur le prix affiché (dispoActive() lit disponibiliteMulti, jamais rafraîchi par
        // ce paramètre figé). Sûr d'envoyer state.nonRemboursable tel quel sur CHAQUE jour ici :
        // premierJourDemande()/eligibleNonRemboursable() (voir plus haut) ne laissent la case se
        // cocher que si le jour le PLUS TÔT de la demande est déjà à J-21 — tout autre jour de la
        // même demande, forcément égal ou postérieur, l'est donc nécessairement aussi. Résultat
        // par jour ici == résultat retenu par POST /reserver pour toute la réservation (même
        // règle, cf. joursAvantDebut).
        + '&non_remboursable=' + (state.nonRemboursable ? '1' : '0')
        // (25/09) Code promo — sur CHAQUE date, comme non_remboursable juste au-dessus : le même
        // code s'applique à toute la demande (POST /reserver le revérifie une fois pour toutes).
        + (state.codePromo ? '&code=' + encodeURIComponent(state.codePromo) : '')
        + (state.token ? '&token=' + encodeURIComponent(state.token) : '');
      return api('/tunnel/disponibilite' + qs).then(function (data) { return { jour: j, data: data }; });
    });

    return Promise.all(requetes).then(function (resultats) {
      state.loading = false;
      state.identifie = !!resultats[0].data.identifie;
      state.identiteInfo = resultats[0].data.identite_info || null;

      var idSets = resultats.map(function (r) { return r.data.espaces.map(function (e) { return e.id; }); });
      var communs = idSets.length ? idSets.reduce(function (acc, ids) {
        var set = {};
        ids.forEach(function (id) { set[id] = true; });
        return acc.filter(function (id) { return set[id]; });
      }) : [];

      var espacesCombines = communs.map(function (id) {
        var premier = null;
        var htBrut = 0, reduction = 0, htNet = 0, ttc = 0, tvaPct = 20;
        var surclasse = false, libelleAnnonce = null, erreur = null;
        // (25/09) Le sort du code voyage comme libelle_annonce : ce tarif-ci est RECONSTRUIT ici
        // (somme des dates), il ne vient pas tel quel du serveur — sans ces deux champs, l'écran ne
        // pourrait rien dire du code en multi-dates.
        var codeStatut = null, codeRefus = null;
        // (02/11, `1.622`/`1.623`) Même motif, et même raison, que `code_statut` juste au-dessus :
        // ce tarif-ci est RECONSTRUIT ici, il ne vient pas tel quel du serveur. Sans ces deux
        // champs, l'écran ne pourrait rien dire du tarif non remboursable en multi-dates — et le
        // récapitulatif, qui lit désormais le verdict, n'afficherait plus RIEN même accordé.
        // `nanrEligible` : un refus l'emporte. Le serveur tranche toute la demande sur le jour le
        // PLUS TÔT (routes/tunnel.js, dateDebutTunnel), qui est le plus contraignant — une date
        // refusée ici signifie donc que le jour le plus tôt l'est aussi. `undefined` (champ absent)
        // n'est pas un verdict et ne doit pas se laisser écraser par un `null`.
        var nanrEligible, nanrPct = 0;
        resultats.forEach(function (r) {
          var e = r.data.espaces.filter(function (x) { return x.id === id; })[0];
          if (!e) return;
          if (!premier) premier = e;
          if (e.surclasse) surclasse = true;
          if (e.tarif && e.tarif.erreur) { erreur = e.tarif.erreur; return; }
          if (e.tarif) {
            htBrut += Number(e.tarif.tarif_ht_brut) || 0;
            reduction += Number(e.tarif.montant_reduction_total) || 0;
            htNet += Number(e.tarif.tarif_ht_net) || 0;
            ttc += Number(e.tarif.tarif_ttc) || 0;
            tvaPct = e.tarif.tva_pct;
            if (e.tarif.libelle_annonce) libelleAnnonce = e.tarif.libelle_annonce;
            // Un refus l'emporte sur tout le reste (il vaut pour toutes les dates : mêmes dates de
            // validité, même plafond) ; sinon le premier statut rencontré. La VÉRITÉ reste POST
            // /reserver, qui revérifie le code pour toute la demande AVANT d'écrire.
            if (e.tarif.code_statut === 'refuse') codeStatut = 'refuse';
            else if (!codeStatut) codeStatut = e.tarif.code_statut || null;
            if (e.tarif.code_refus && !codeRefus) codeRefus = e.tarif.code_refus;
            if (e.tarif.non_remboursable_eligible === false) nanrEligible = false;
            else if (nanrEligible === undefined && 'non_remboursable_eligible' in e.tarif) {
              nanrEligible = e.tarif.non_remboursable_eligible;
            }
            if (!nanrPct && Number(e.tarif.remise_non_remboursable_pct) > 0) {
              nanrPct = Number(e.tarif.remise_non_remboursable_pct);
            }
          }
        });
        return {
          id: id, nom: premier.nom, code: premier.code, capacite: premier.capacite,
          surclasse: surclasse, url_fiche_site: premier.url_fiche_site,
          tarif: erreur ? { erreur: erreur } : {
            tarif_ht_brut: round2(htBrut), montant_reduction_total: round2(reduction),
            tarif_ht_net: round2(htNet), tva_pct: tvaPct, tarif_ttc: round2(ttc),
            libelle_annonce: libelleAnnonce,
            code_statut: codeStatut, code_refus: codeRefus,
            non_remboursable_eligible: nanrEligible,
            remise_non_remboursable_pct: nanrPct,
          },
        };
      });

      var parJour = resultats.map(function (r) {
        var especesParId = {};
        (r.data.espaces || []).forEach(function (e) { especesParId[e.id] = e.tarif; });
        return { date: r.jour.date, unite: r.jour.unite, demiPeriode: r.jour.demiPeriode, especesParId: especesParId };
      });

      state.disponibiliteMulti = {
        espaces: espacesCombines,
        parJour: parJour,
        taille_demandee: resultats[0].data.taille_demandee,
      };

      var espaceAvant = state.selectedEspaceId;
      var conserve = espaceAvant ? espacesCombines.filter(function (e) { return e.id === espaceAvant; })[0] : null;
      state.selectedEspaceId = conserve ? conserve.id : (espacesCombines.length ? espacesCombines[0].id : null);
      // (01/09 soir, lot D complet) — simple valeur de DÉPART, plus un mode imposé : le paiement en
      // ligne est désormais accepté aussi en multi-dates (routes/tunnel.js POST /reserver). Cette
      // valeur est de toute façon réévaluée par chargerOptionsPaiement() à l'étape 4, une fois la
      // disponibilité réelle du paiement en ligne connue — ici, avant cet appel, 'devis' reste le
      // repli le plus sûr (toujours accepté, quel que soit l'état d'identification).
      state.modePaiement = 'devis';
      if (!conserverEtape) state.step = 2;
      render();
    }).catch(function (err) {
      state.loading = false;
      state.error = err.message;
      render();
    });
  }

  // NANR (29/08 ; déplacé étape 2 le 01/09 soir) : re-simule la disponibilite/le tarif de TOUTES
  // les salles listees avec le nouveau choix, SANS changer d'etape (l'utilisateur est deja a
  // l'etape Salle quand il coche/decoche — § TEMPS 2 « propose ET chiffre »).
  // (TEMPS 2, 01/09 soir) — CORRECTIF : cette fonction appelait TOUJOURS doRecherche() (mono-
  // date), meme en multi-dates ; dispoActive() lit alors disponibiliteMulti (jamais rafraichi par
  // doRecherche(), qui ecrit disponibilite) — cocher le NANR en multi-dates ne changeait donc
  // AUCUN prix affiche. Repondre a l'etape reellement active, comme lancerRecherche().
  function toggleNonRemboursable() {
    state.nonRemboursable = !state.nonRemboursable;
    state.nanrResetNotice = false;
    if (state.datesSupp.length) { doRechercheMulti(true); } else { doRecherche(null, true); }
  }

  // (25/09) Rejoue la recherche de l'étape ACTIVE (mono ou multi-dates), sans changer d'écran —
  // même choix que toggleNonRemboursable ci-dessus, et pour la même raison : c'est le serveur qui
  // rechiffre les salles, jamais un calcul local.
  function relancerRechercheCode() {
    return state.datesSupp.length ? doRechercheMulti(true) : doRecherche(null, true);
  }

  // « Appliquer » — DEUX temps, et pas un de plus :
  //  ① GET /tunnel/verifier-code : le verdict nommé, tout de suite, SANS RIEN CONSOMMER (l'usage se
  //     compte à la confirmation, côté serveur, lib/tarification.js::consommerCodeReduction) ;
  //  ② si le code vaut quelque chose : on REJOUE la recherche avec &code= — ce sont les prix DU
  //     SERVEUR qui changent. C'est aussi ce second appel qui dit si le code est réellement
  //     APPLIQUÉ ou ÉCARTÉ par le non-cumul, ce que la vérification à la saisie ne peut pas savoir.
  function appliquerCodePromo() {
    var champ = document.getElementById('spr-code-input');
    var saisie = ((champ ? champ.value : state.codePromoSaisie) || '').trim();
    state.codePromoSaisie = saisie;
    if (!saisie) {
      state.codePromoVerdict = { valide: false, motif: 'vide', message: 'Merci de saisir un code, ou continuez sans code.' };
      render();
      return Promise.resolve();
    }
    state.codePromoLoading = true;
    state.error = null;
    render();
    return api('/tunnel/verifier-code?code=' + encodeURIComponent(saisie)
      + (state.token ? '&token=' + encodeURIComponent(state.token) : ''))
      .then(function (v) {
        state.codePromoLoading = false;
        state.codePromoVerdict = v;
        var avait = state.codePromo;
        // Le serveur renvoie le code tel qu'il est EN BASE (casse comprise) : on garde le sien.
        state.codePromo = v.valide ? (v.code || saisie.toUpperCase()) : null;
        state.codePromoSaisie = v.valide ? '' : saisie;
        state.sansCode = false;
        state.codeRefusEnvoi = null;
        // Rejouer seulement s'il y a un code à faire entrer, ou un code à faire sortir des prix.
        if (state.codePromo || avait) return relancerRechercheCode();
        render();
        return undefined;
      })
      .catch(function (err) {
        state.codePromoLoading = false;
        state.codePromoVerdict = null;
        state.error = err.message;
        render();
      });
  }

  function retirerCodePromo() {
    state.codePromo = null;
    state.codePromoSaisie = '';
    state.codePromoVerdict = null;
    state.sansCode = false;
    state.codeRefusEnvoi = null;
    return relancerRechercheCode();
  }

  // « Réserver sans le code » — le code ne valait plus au moment de confirmer (409 nommé). On
  // renvoie LA MÊME demande avec sans_code:true : le serveur écarte le code et confirme au prix
  // qu'il vient d'annoncer. La tentative refusée n'a rien écrit.
  function reserverSansCode() {
    state.sansCode = true;
    state.codeRefusEnvoi = null;
    doReserver();
  }

  function doListeAttente() {
    var email = document.getElementById('spr-attente-email').value.trim();
    if (!email) { state.error = 'Merci de renseigner votre email.'; render(); return; }
    var s = state.search;
    var horaires = computeCreneauHoraires();
    api('/tunnel/liste-attente', {
      method: 'POST',
      body: JSON.stringify({
        capacite_min: s.capaciteMin, type_reservation: s.typeReservation,
        date_debut: s.date + 'T' + horaires.debut + ':00', date_fin: s.date + 'T' + horaires.fin + ':00',
        email: email,
      }),
    }).then(function () {
      state.error = null;
      root.innerHTML = '<div class="spr-card"><div class="spr-banner spr-ok">Vous êtes inscrit(e) — nous vous préviendrons par email dès que ce créneau se libère.</div></div>';
    }).catch(function (err) {
      state.error = err.message;
      render();
    });
  }

  function loadOptions() {
    if (state.optionsCatalogue) { render(); return; }
    api('/tunnel/options').then(function (data) {
      state.optionsCatalogue = data;
      render();
    }).catch(function (err) {
      state.error = err.message;
      state.step = 2;
      render();
    });
  }

  // Charge les modes de paiement disponibles — POUR TOUS (anonyme inclus), afin que le paiement en
  // ligne (qui n'exige pas d'identification) s'affiche dès le choix. Le serveur décide de sa
  // disponibilité (§17.14). Un client identifié y ajoute crédit salle / facture fin de mois.
  function chargerOptionsPaiement() {
    var montant = montantSelection();
    // §17.17/§17.19 — on transmet la FENÊTRE (salle + jour + créneau/heures) pour que le serveur
    // évalue hors-horaires / délai court / créneau contesté DÈS LE CHOIX, et renvoie le POURQUOI du
    // refus de paiement en ligne. Le plugin ne décide de rien : il affiche ce que dit le serveur.
    var s = state.search;
    var estHeure = s.unite === 'heure';
    var creneau = computeCreneau();
    // (01/09, lot D court) — joursRecherche() renvoie EXACTEMENT [jour] (même forme qu'avant ce
    // chantier) quand aucune date supplémentaire n'existe ; la liste complète sinon, pour que la
    // prévisualisation de majoration jour férié (§17.24) et nb_jours restent justes en multi-dates
    // aussi. (01/09 soir, lot D complet) — plus « seul le mode devis est proposé ensuite » : le
    // paiement en ligne l'est désormais aussi, cf. pré-sélection ci-dessous.
    var jours = joursRecherche();
    var nbJours = jours.length;
    api('/tunnel/options-paiement', {
      method: 'POST',
      body: JSON.stringify({
        token: state.token || undefined, montant_ttc: montant, nb_jours: nbJours,
        espace_id: state.selectedEspaceId, unite_choisie: s.unite, creneau: creneau,
        heure_debut: estHeure ? s.heureDebut : undefined,
        heure_fin: estHeure ? s.heureFin : undefined,
        jours: jours,
      }),
    }).then(function (data) {
      state.optionsPaiement = data;
      state.identifie = !!data.identifie;
      // Pré-sélection raisonnable du mode par défaut selon ce qui est réellement proposé.
      // (01/09 soir, lot D complet) — en multi-dates, crédit salle/facture fin de mois ne sont
      // JAMAIS proposés (cf. renderStepPaiement, !multiJours) : les présélectionner laisserait
      // state.modePaiement sur une valeur qu'aucun radio ne porte à l'écran (rien de coché). On
      // choisit donc parmi les seuls modes réellement offerts en multi-dates : en ligne si
      // possible, sinon devis.
      if (nbJours > 1) {
        state.modePaiement = (data.identifie && data.paiement_en_ligne_disponible) ? 'en_ligne' : 'devis';
      } else if (data.identifie && data.credit_disponible) state.modePaiement = 'credit_salle';
      else if (data.identifie && data.paiement_fin_mois_disponible) state.modePaiement = 'sur_facture';
      else state.modePaiement = 'devis';
      if (data.identifie) {
        api('/client/moi?token=' + encodeURIComponent(state.token)).then(function (moi) {
          state.identiteInfo = moi;
          render();
        }).catch(function () { render(); });
      } else {
        render();
      }
    }).catch(function () {
      // En cas d'échec, on retombe sur le devis seul (jamais bloquant).
      state.optionsPaiement = { identifie: false, paiement_en_ligne_disponible: false };
      render();
    });
  }

  // (1.7.2) localStorage, pas sessionStorage — voir le commentaire sur SNAPSHOT_TTL_MS en tete
  // de fichier. Les trois fonctions ci-dessous sont le seul point d'acces a SNAPSHOT_KEY,
  // pour ne jamais desynchroniser l'ecriture (doIdentify), la lecture (INIT) et le nettoyage
  // (fin de parcours / expiration).
  function saveSnapshot() {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        search: state.search, disponibilite: state.disponibilite, selectedEspaceId: state.selectedEspaceId,
        pauses: state.pauses, selectedRestauration: state.selectedRestauration,
        selectedAmenagementId: state.selectedAmenagementId,
        // (correctif 01/09) trou du lot D court -- le snapshot ne portait que la recherche
        // mono-date : un client qui ajoute des dates supplementaires (state.datesSupp) puis
        // s'identifie en cours de saisie les perdait au retour (repartait d'une seule date).
        // datesSupp voyage donc desormais lui aussi, avec sa propre duree/creneau par date (meme
        // forme que joursRecherche() ci-dessus). disponibiliteMulti suit disponibilite : gardee le
        // temps du rafraichissement au retour, pour eviter le meme flash "Aucune disponibilite"
        // que le correctif du 29/08 evitait deja pour le mono-date.
        datesSupp: state.datesSupp, disponibiliteMulti: state.disponibiliteMulti,
        // (correctif 29/08) step RÉEL — plus le "4" figé d'avant. L'identification est désormais
        // proposée dès l'étape 1/2 (renderIdentifyPrompt), pas seulement à l'étape Paiement :
        // reprendre toujours à 4 aurait fait sauter la recherche/le choix de salle pour un client
        // qui s'identifie avant même d'avoir cherché.
        // (TEMPS 2, 01/09 soir) — CORRECTIF : nonRemboursable manquait ici. Un client qui coche
        // le NANR (désormais étape 2) puis clique « Déjà client ? » (proposé dès l'étape 1/2/4)
        // le reperdait silencieusement au retour, alors que SES DATES N'ONT PAS CHANGÉ — donc
        // rien ne justifiait de le décocher (contrairement au bouton Rechercher, qui LUI change
        // réellement les dates). Voyage donc désormais lui aussi.
        nonRemboursable: state.nonRemboursable,
        // (25/09) Code promo — même motif que nonRemboursable juste au-dessus : un client qui saisit
        // un code puis clique « Déjà client ? » ne doit pas le reperdre, ses dates n'ayant pas
        // changé. Le verdict voyage avec (il porte le libellé affiché et le refus éventuel). Ni
        // `sansCode` ni `codeRefusEnvoi` ne voyagent : un refus d'envoi en cours n'a aucun sens au
        // retour, et le serveur le réévaluera de toute façon au prochain envoi.
        codePromo: state.codePromo, codePromoSaisie: state.codePromoSaisie,
        codePromoVerdict: state.codePromoVerdict,
        step: state.step, savedAt: Date.now(),
      }));
    } catch (e) { /* localStorage indisponible : tant pis, pas bloquant */ }
  }

  // Toujours CONSOMME (removeItem), qu'il soit exploitable ou non — pour ne jamais rejouer un
  // snapshot perime ou deja utilise a un rechargement suivant. Renvoie null si absent, invalide,
  // ou plus vieux que SNAPSHOT_TTL_MS.
  // Deux onglets ouverts en meme temps sur une identification : localStorage est PARTAGE (pas
  // isole par onglet comme sessionStorage) — le second doIdentify() ecraserait la sauvegarde du
  // premier. Cas juge rare (un seul lien de connexion en vol a la fois, en pratique), signale
  // ici plutot que sur-construit (ex. verrou multi-onglets).
  function consumeSnapshot() {
    var raw = null;
    try {
      raw = localStorage.getItem(SNAPSHOT_KEY);
      localStorage.removeItem(SNAPSHOT_KEY);
    } catch (e) { return null; }
    if (!raw) return null;
    try {
      var snap = JSON.parse(raw);
      if (!snap.savedAt || (Date.now() - snap.savedAt) > SNAPSHOT_TTL_MS) return null; // perime
      return snap;
    } catch (e) { return null; }
  }

  function clearSnapshot() {
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch (e) { /* noop */ }
  }

  function doIdentify() {
    var email = document.getElementById('spr-identify-email').value.trim();
    if (!email) { state.error = 'Merci de renseigner votre email.'; render(); return; }
    saveSnapshot();

    api('/client/demander-lien', { method: 'POST', body: JSON.stringify({ email: email, redirect_url: PAGE_URL }) })
      .then(function () {
        state.error = null;
        root.innerHTML = '<div class="spr-card"><div class="spr-banner spr-ok">Email envoyé ! Cliquez sur le lien reçu pour revenir ici identifié(e) (valable 2 heures).</div></div>';
      }).catch(function (err) {
        state.error = err.message;
        render();
      });
  }

  // (30/08, chantier SIRET dans le tunnel) — préremplissage §2 : un BOUTON, jamais automatique
  // (l'utilisateur déclenche). Consulte d'abord si ce SIRET est déjà un tiers actif chez nous
  // (§3, la vérification qui compte est refaite côté serveur à l'envoi — ceci n'est qu'un
  // confort d'écran, orienter tout de suite vers « demandez votre lien » plutôt que de laisser
  // remplir un formulaire pour rien). Sinon, préremplit depuis recherche-entreprises.api.gouv.fr
  // et capture l'instantané (siretApiSnapshot) pour le mail équipe (§5) — même si le client
  // corrige ensuite les champs, l'instantané reste ce que l'API disait AU MOMENT du clic.
  function doSiretLookup() {
    var siret = (state.contact.siret || '').replace(/\s/g, '');
    if (!/^\d{14}$/.test(siret)) {
      state.error = 'Le SIRET doit comporter 14 chiffres.';
      render();
      return;
    }
    state.error = null;
    state.siretLookupLoading = true;
    state.siretLookup = null;
    render();

    api('/tunnel/siret/' + siret)
      .then(function (data) {
        state.siretLookupLoading = false;
        state.siretLookup = data;
        if (!data.deja_client && data.trouve) {
          // Préremplissage — le client garde la main pour corriger chaque champ ensuite (§2).
          state.contact.raison_sociale = data.raison_sociale || state.contact.raison_sociale;
          state.contact.adresse_facturation = data.adresse || state.contact.adresse_facturation;
          state.siretApiSnapshot = { raison_sociale: data.raison_sociale || null, adresse: data.adresse || null, naf: data.naf || null };
        }
        render();
      }).catch(function (err) {
        state.siretLookupLoading = false;
        // §2 — une panne de recherche ne bloque JAMAIS la saisie manuelle.
        state.siretLookup = { valide: true, trouve: false, deja_client: false };
        state.error = err.message;
        render();
      });
  }

  // §3 — SIRET déjà connu : vérifie que l'email saisi correspond BIEN à CE tiers précis (jamais
  // un email au hasard) avant d'appeler POST /client/demander-lien (existant, même lien à 2h —
  // aucun second mécanisme créé ici). Un email qui ne correspond pas affiche le message dédié
  // (téléphone), sans jamais révéler quelles adresses existent réellement.
  function doSiretConnuEnvoyer() {
    var email = (state.siretConnuEmail || '').trim();
    if (!email) { state.error = 'Merci de renseigner votre email.'; render(); return; }
    state.error = null;
    state.siretConnuLoading = true;
    state.siretConnuMessage = null;
    render();

    api('/tunnel/verifier-email-siret', {
      method: 'POST', body: JSON.stringify({ siret: state.contact.siret, email: email }),
    }).then(function (v) {
      if (!v.correspond) {
        state.siretConnuLoading = false;
        state.siretConnuMessage = { type: 'erreur', text: "Nous ne reconnaissons pas cette adresse. Vous pouvez nous appeler au 05 46 50 46 86." };
        render();
        return;
      }
      saveSnapshot();
      return api('/client/demander-lien', { method: 'POST', body: JSON.stringify({ email: email, redirect_url: PAGE_URL }) })
        .then(function () {
          state.siretConnuLoading = false;
          state.siretConnuMessage = { type: 'succes', text: 'Email envoyé ! Cliquez sur le lien reçu pour revenir ici identifié(e) (valable 2 heures).' };
          render();
        });
    }).catch(function (err) {
      state.siretConnuLoading = false;
      state.error = err.message;
      render();
    });
  }

  function construirePayload() {
    var s = state.search;
    var estHeure = s.unite === 'heure';
    var multiJours = state.datesSupp.length > 0;
    var options = { pauses: [], restauration: [], amenagement_id: state.selectedAmenagementId || undefined };
    // (29/08, refonte modale pause) — heure_pause n'est plus jamais '10:30' en dur : chaque
    // pause de state.pauses porte désormais la sienne, saisie dans la modale (défaut proposé =
    // heureParDefautPause(), toujours modifiable). Le serveur (routes/tunnel.js POST /reserver)
    // acceptait déjà ce tableau tel quel, sans changement de son côté.
    // (01/09, lot D court) — les options sont choisies UNE SEULE FOIS (étape 3, hors périmètre de
    // ce chantier) mais doivent être RÉPÉTÉES sur CHAQUE date en multi-dates : le serveur les
    // rattache par date_jour (routes/tunnel.js POST /reserver, joursParDate[p.date_jour]) — sans
    // cette répétition, seule la première date recevrait la pause/le plateau repas. L'aménagement
    // (amenagement_id) n'a pas besoin d'être répété : le serveur l'applique déjà à TOUS les jours
    // créés, tel quel, mono comme multi.
    var datesOptions = multiJours ? joursRecherche() : [{ date_jour: s.date }];
    datesOptions.forEach(function (j) {
      state.pauses.forEach(function (pz) {
        options.pauses.push({ date_jour: j.date_jour, heure_pause: pz.heure_pause, formule_id: pz.formule_id, nombre_personnes: pz.nombre_personnes });
      });
      if (state.selectedRestauration > 0 && state.optionsCatalogue.restauration.length) {
        options.restauration.push({ date_jour: j.date_jour, nombre_personnes: state.selectedRestauration, heure_livraison: '12:30' });
      }
    });

    // (01/09, lot D court) — chaque jour porte désormais SA PROPRE unite/creneau quand plusieurs
    // dates sont demandées (jour.unite/jour.creneau prévalent déjà côté serveur sur
    // unite_choisie/creneau globaux, cf. lib/creerReservation.js resoudreJour) — sans cela, TOUS
    // les jours seraient facturés/bloqués sur l'unité de la date principale, faux dès qu'une date
    // diffère (même piège que le tarif avant le lot A). Mono-date : forme EXACTEMENT identique à
    // avant ce chantier (aucun champ unite/creneau sur l'unique jour, comme avant).
    var jours = multiJours
      ? joursRecherche().map(function (j) {
          return { date_jour: j.date_jour, nombre_personnes_devis: Number(s.capaciteMin), unite: j.unite, creneau: j.creneau };
        })
      : [{ date_jour: s.date, nombre_personnes_devis: Number(s.capaciteMin) }];

    var payload = {
      token: state.token || undefined,
      espace_id: state.selectedEspaceId,
      unite_choisie: s.unite,
      // Créneau explicite (§17.1bis / §17.13) : pour une demi-journée on transmet matin/après-midi ;
      // le serveur pose alors la bonne plage via la grille (8h30-12h30 vs 14h-18h). On n'envoie des
      // heures QUE pour « heures précises » — jamais d'horaires figés pour la journée/demi-journée.
      creneau: computeCreneau(),
      heure_debut: estHeure ? s.heureDebut : undefined,
      heure_fin: estHeure ? s.heureFin : undefined,
      jours: jours,
      // Catégorie initialement demandée (trace + surclassement). La FACTURATION est ancrée côté
      // serveur sur la taille RÉELLE de la salle choisie (release v1.2.0) → prix affiché = prix facturé.
      taille_demandee_id: multiJours ? state.disponibiliteMulti.taille_demandee.id : state.disponibilite.taille_demandee.id,
      unite: s.unite,
      duree: computeDuree(),
      mode_paiement: state.modePaiement,
      // (02/11, `1.622`) On envoie CE QU'ON A AFFICHÉ. Le serveur refusait déjà une demande non
      // éligible (calculerTarif : `nonRembApplicable = demandé && eligible`), donc retirer ici une
      // demande refusée ne change aucun prix : ça aligne l'envoi sur l'écran. La DEMANDE continue
      // de voyager telle quelle vers /tunnel/disponibilite (`&non_remboursable=`, plus haut) —
      // sans elle le serveur ne trancherait jamais, et il n'y aurait plus de verdict à lire.
      non_remboursable: nanrAccordeParServeur() ? 1 : 0,
      // (02/11, `1.624`) CGPS — un BOOLEEN, et seulement `true`. L'API est fail-closed sur la
      // VALEUR (routes/sresa/tunnel.js : `cgps_acceptees === true`) : la chaine 'true', le nombre
      // 1, 'oui' ou un objet y sont refuses comme « non accepte » — c'est par la qu'une preuve se
      // fabriquerait sans que personne n'ait rien coche. `undefined` est retire par
      // JSON.stringify, donc le champ est ABSENT quand la case n'est pas cochee : jamais `false`,
      // qui donnerait a lire un refus explicite du client la ou il n'y a eu aucun geste.
      cgps_acceptees: state.cgpsAcceptees ? true : undefined,
      // (25/09) Code promo — `code` tel qu'il a été vérifié à la saisie ; `sans_code:true` seulement
      // quand le client a explicitement choisi de réserver sans lui après un refus à la
      // confirmation (routes/tunnel.js : sans_code:true écarte le code, le reste de la demande est
      // rigoureusement identique). Le serveur revérifie AVANT d'écrire et compte l'usage lui-même —
      // le plugin ne décide rien, ne compte rien.
      code: state.codePromo || undefined,
      sans_code: state.sansCode ? true : undefined,
      // (30/08 soir) — la demande d'horaires anticipes voyage DANS le commentaire (aucune colonne
      // sresa_jours touchee par ce parcours) : elle atteint l'equipe via le meme canal deja lu au
      // mail de notification (notificationEquipeTunnel.js), sans creer un second mecanisme.
      commentaire_general: [state.commentaire, texteHorairesAnticipes()].filter(Boolean).join('\n\n') || undefined,
      options: options,
    };
    if (!state.identifie) {
      // (30/08) contact.siret/adresse_facturation/type déjà portés par state.contact ; le NAF et
      // l'instantané API (§5, « ce que l'API disait ») viennent de siretApiSnapshot — jamais
      // saisis à la main, jamais montrés au client, capturés au moment du clic « Remplir depuis
      // le SIRET » et conservés même si le client corrige raison sociale/adresse ensuite.
      var snap = state.siretApiSnapshot;
      payload.contact = Object.assign({}, state.contact, {
        naf: snap ? snap.naf : undefined,
        siret_api_raison_sociale: snap ? snap.raison_sociale : undefined,
        siret_api_adresse: snap ? snap.adresse : undefined,
        siret_api_naf: snap ? snap.naf : undefined,
      });
    }
    return payload;
  }

  function doReserver() {
    // (02/11, `1.624`) LE VERROU D'ECRAN, ICI ET NULLE PART AILLEURS. doReserver() est le SEUL
    // appelant de POST /tunnel/reserver, et ses deux declencheurs y passent tous les deux
    // (« Envoyer ma demande »/« Continuer vers le paiement » et « Reserver sans le code ») : la
    // garde posee ici les couvre par construction, aucun site d'envoi ne peut la manquer — c'est
    // la lecon du NANR, ou l'oubli d'un site faisait disparaitre une information sans bruit.
    // Le bouton n'est PAS `disabled` : un bouton eteint ne recoit aucun clic, donc n'explique
    // rien. Il reste cliquable et DIT pourquoi il ne part pas.
    // ⚠️ Tant que l'API est en mode tolerant (reglage `sresa_cgps_obligatoires` a false, son
    // etat de depart), cet ecran est la SEULE barriere : une reservation qui partirait sans le
    // champ serait creee sans preuve, en silence.
    if (!state.cgpsAcceptees) {
      state.cgpsManquante = true;
      state.cgpsRefus = null;
      state.loading = false;
      render();
      focusCgps();
      return;
    }
    state.loading = true;
    state.error = null;
    render();

    api('/tunnel/reserver', { method: 'POST', body: JSON.stringify(construirePayload()) })
      .then(function (data) {
        // (1.7.2) Fin de parcours — reservation ou devis desormais crees cote serveur (les 3
        // branches ci-dessous, y compris a_revoir) : plus besoin de reprendre une identification
        // en cours de route, on efface la sauvegarde.
        clearSnapshot();
        state.resultat = data;
        state.loading = false;

        // §17.14 — conflit d'agenda détecté à la confirmation : la demande est prise en compte, le
        // paiement est coupé côté serveur. On affiche le message de prise en compte, pas de paiement.
        if (data.a_revoir) {
          state.aRevoir = true;
          state.messageClient = data.message_client;
          state.step = 6;
          render();
          return;
        }

        // Paiement en ligne : le serveur a créé un PaymentIntent et renvoyé son client_secret →
        // on passe à l'étape de paiement Stripe. Sinon (devis / crédit / facture) : confirmation.
        if (data.stripe_client_secret && data.reservation) {
          state.stripeClientSecret = data.stripe_client_secret;
          state.reservationId = data.reservation.id;
          state.stripeMounted = false;
          state.step = 7;
          render();
          return;
        }

        state.step = 6;
        render();
      }).catch(function (err) {
        state.loading = false;
        // (25/09) Code promo refusé AU MOMENT DE CONFIRMER — 409 nommé : motif 'code_refuse' (le
        // code ne vaut plus : expiré, désactivé, plafond) ou 'code_plafond_atteint' (quelqu'un
        // d'autre a pris le dernier usage entre la saisie et l'envoi). RIEN n'a été écrit côté
        // serveur. Ce n'est pas une erreur muette : on montre le message du serveur (il dit le prix
        // sans le code) et on propose le vrai choix — réserver sans le code, ou revenir en arrière.
        var extra = err.data || {};
        // (02/11, `1.624`) CGPS refusees PAR LE SERVEUR — motif `cgps_non_acceptees`. On lit le
        // MOTIF, pas le code HTTP (422 aujourd'hui ; le motif, lui, est stable). Ce refus tombe
        // AVANT `pool.connect()` cote API, donc avant la moindre ligne ecrite et avant le moindre
        // appel Stripe : rien n'est cree, rien n'est facture, il n'y a aucun etat a moitie valide
        // a defaire. On ne garde PAS la case cochee : le serveur vient de dire qu'aucune
        // acceptation ne lui est parvenue, et un ecran qui l'affiche acceptee pendant qu'il dit
        // l'inverse mentirait a l'un des deux. On montre SA phrase (jamais une des notres
        // par-dessus) et on ramene le client sur la case.
        if (extra.motif === 'cgps_non_acceptees') {
          state.cgpsAcceptees = false;
          state.cgpsManquante = false;
          state.cgpsRefus = err.message;
          state.error = null;
          render();
          focusCgps();
          return;
        }
        if (err.status === 409 && (extra.motif === 'code_refuse' || extra.motif === 'code_plafond_atteint')) {
          state.codeRefusEnvoi = {
            motif: extra.motif,
            message: err.message,
            tarifSansCodeTtc: (extra.tarif_sans_code && extra.tarif_sans_code.tarif_ttc != null)
              ? Number(extra.tarif_sans_code.tarif_ttc) : null,
          };
          state.error = null;
          render();
          return;
        }
        state.error = err.message;
        render();
      });
  }

  // ===================== PAIEMENT EN LIGNE (Stripe) =====================
  // Charge Stripe.js à la demande (uniquement quand un paiement en ligne est réellement engagé) —
  // aucune dépendance chargée pour les parcours devis/crédit/facture.
  function ensureStripeJs() {
    return new Promise(function (resolve, reject) {
      if (window.Stripe) return resolve(window.Stripe);
      var existing = document.querySelector('script[data-spr-stripe]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.Stripe); });
        existing.addEventListener('error', function () { reject(new Error('Chargement de Stripe.js impossible')); });
        return;
      }
      var sc = document.createElement('script');
      sc.src = STRIPE_JS;
      sc.async = true;
      sc.setAttribute('data-spr-stripe', '1');
      sc.onload = function () { resolve(window.Stripe); };
      sc.onerror = function () { reject(new Error('Chargement de Stripe.js impossible')); };
      document.head.appendChild(sc);
    });
  }

  function stripeStatus(msg, kind) {
    var el = document.getElementById('spr-stripe-status');
    if (el) el.innerHTML = msg ? '<div class="spr-banner spr-' + (kind || 'error') + '">' + esc(msg) + '</div>' : '';
  }

  // Monte le Payment Element une seule fois (garde-fou state.stripeMounted). N'appelle JAMAIS render()
  // ensuite (il réécrirait le DOM et détruirait l'élément monté) : les erreurs s'affichent en place.
  function initStripePayment() {
    if (state.stripeMounted) return;
    state.stripeMounted = true;
    ensureStripeJs()
      .then(function () { return api('/tunnel/stripe-config'); })
      .then(function (conf) {
        if (!conf || !conf.publishable_key) throw new Error('Le paiement en ligne est indisponible pour le moment.');
        state.stripe = window.Stripe(conf.publishable_key);
        state.stripeElements = state.stripe.elements({ clientSecret: state.stripeClientSecret });
        // §17.19 — préremplir le formulaire carte avec ce qui a DÉJÀ été saisi à l'étape précédente
        // (nom, email, téléphone), pour éviter une double saisie au moment le plus critique du parcours.
        // L'adresse n'est pas collectée par le tunnel : on ne préremplit donc que ce qu'on possède.
        var paymentElement = state.stripeElements.create('payment', {
          defaultValues: { billingDetails: prefillBilling() },
        });
        var mountEl = document.getElementById('spr-stripe-element');
        if (mountEl) { mountEl.innerHTML = ''; paymentElement.mount('#spr-stripe-element'); }
      })
      .catch(function (err) {
        state.stripeMounted = false;
        stripeStatus(err.message || 'Le paiement en ligne est indisponible pour le moment.');
      });
  }

  // Valeurs de préremplissage du Payment Element (§17.19). Client anonyme : coordonnées saisies à
  // l'étape « Paiement & coordonnées ». Client identifié : ce qu'on connaît de son profil. On ne
  // renvoie que les champs réellement renseignés (Stripe ignore les valeurs vides/undefined).
  function prefillBilling() {
    var b = {};
    var info = state.identiteInfo || {};
    var nom = (!state.identifie ? state.contact.nom : '') || info.contact_nom || info.nom || '';
    var email = (!state.identifie ? state.contact.email : '') || info.email || '';
    var tel = (!state.identifie ? state.contact.telephone : '') || info.telephone || '';
    if (nom) b.name = nom;
    if (email) b.email = email;
    if (tel) b.phone = tel;
    return b;
  }

  function doPayer() {
    if (!state.stripe || !state.stripeElements) {
      stripeStatus('Le module de paiement n\'est pas prêt, merci de patienter un instant.');
      return;
    }
    var btn = document.getElementById('spr-btn-payer');
    if (btn) { btn.disabled = true; btn.textContent = 'Paiement en cours…'; }
    stripeStatus('');

    state.stripe.confirmPayment({
      elements: state.stripeElements,
      confirmParams: { return_url: PAGE_URL },
      redirect: 'if_required',
    }).then(function (result) {
      if (result.error) {
        if (btn) { btn.disabled = false; btn.textContent = 'Payer'; }
        stripeStatus(result.error.message || 'Le paiement n\'a pas abouti.');
        return;
      }
      var pi = result.paymentIntent;
      if (pi && (pi.status === 'succeeded' || pi.status === 'processing')) {
        // Confirmation immédiate côté serveur (le webhook Stripe fait le même travail en backstop,
        // de façon idempotente). On revérifie toujours le statut réel du PaymentIntent côté serveur.
        api('/tunnel/confirmer-paiement/' + encodeURIComponent(state.reservationId), { method: 'POST' })
          .then(function () {
            state.step = 6;
            render();
          }).catch(function () {
            // Paiement encaissé mais confirmation serveur en retard : le webhook finalisera. On
            // affiche quand même une confirmation (le paiement a réussi côté Stripe).
            state.step = 6;
            render();
          });
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Payer'; }
      stripeStatus('Paiement en attente (statut : ' + (pi ? pi.status : 'inconnu') + '). Merci de réessayer.', 'error');
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Payer'; }
      stripeStatus(err.message || 'Le paiement n\'a pas abouti.');
    });
  }

  // ===================== INIT =====================
  function init() {
    var params = new URLSearchParams(window.location.search);
    var tokenFromUrl = params.get('space_token');

    // (1.5.0) Préremplissage depuis [space_disponibilite] — spr_espace/spr_date/spr_unite/
    // spr_creneau/spr_heure_debut/spr_heure_fin/spr_capacite. Additif : en leur absence, état
    // initial inchangé (étape 1 vide, comme avant). spr_creneau arrive au format serveur
    // ('apres_midi') ; converti au format interne du sélecteur ('apresmidi', cf. renderStepRecherche).
    var prefillEspaceCode = params.get('spr_espace');
    var prefillDate = params.get('spr_date');
    if (prefillDate) state.search.date = prefillDate;
    if (params.get('spr_unite')) state.search.unite = params.get('spr_unite');
    if (params.get('spr_creneau')) state.search.demiPeriode = params.get('spr_creneau') === 'apres_midi' ? 'apresmidi' : 'matin';
    if (params.get('spr_heure_debut')) state.search.heureDebut = params.get('spr_heure_debut');
    if (params.get('spr_heure_fin')) state.search.heureFin = params.get('spr_heure_fin');
    if (params.get('spr_capacite')) state.search.capaciteMin = params.get('spr_capacite');
    var pretAPreremplir = !!(prefillEspaceCode && prefillDate && state.search.capaciteMin);

    var afterConfig = function () {
      if (tokenFromUrl) {
        state.token = tokenFromUrl;
        var snap = consumeSnapshot();
        if (snap) {
          Object.assign(state, {
            search: snap.search, selectedEspaceId: snap.selectedEspaceId,
            // (29/08) `snap.pauses || []` : filet pour un snapshot posé par l'ANCIENNE version du
            // plugin (avant le passage à `pauses[]`, forme `selectedPauses` map) pendant la
            // fenêtre de 2h où l'un et l'autre pourraient coexister après ce déploiement — plutôt
            // que de planter sur un champ absent, on repart d'une liste de pauses vide (une
            // saisie perdue reste préférable à un écran cassé).
            pauses: snap.pauses || [], selectedRestauration: snap.selectedRestauration,
            selectedAmenagementId: snap.selectedAmenagementId,
            // (correctif 01/09) même filet que pauses[] ci-dessus, même motif : un snapshot posé
            // par la version d'AVANT le lot D court (v1.9.5 et antérieures, datesSupp n'existait
            // pas encore) reste lisible pendant la fenêtre de 2h — on repart d'un tableau vide
            // (mono-date, comportement identique à avant ce chantier) plutôt que de planter.
            datesSupp: snap.datesSupp || [],
            // (TEMPS 2, 01/09 soir) — même filet que pauses[]/datesSupp[] ci-dessus : un snapshot
            // posé par une version d'AVANT ce chantier n'a pas ce champ, `=== true` retombe alors
            // sur false (comportement identique à avant : la case n'existait qu'à l'étape 4, sans
            // notion de survie au round-trip d'identification).
            nonRemboursable: snap.nonRemboursable === true,
            // (25/09) Même filet que les champs ci-dessus : un snapshot posé par une version
            // d'AVANT ce chantier ne porte pas ces champs — on repart sans code (comportement
            // identique à avant, aucun code n'existait). La recherche rejouée juste en dessous
            // emporte le code restauré ET le token désormais connu : un code réservé à ce client,
            // refusé tant qu'il était anonyme, est alors reconnu.
            codePromo: snap.codePromo || null,
            codePromoSaisie: snap.codePromoSaisie || '',
            codePromoVerdict: snap.codePromoVerdict || null,
          });
          // (correctif 29/08 — diagnostic du jour) CAUSE CONFIRMÉE de la remise absente au
          // retour : `state.disponibilite` était repris TEL QUEL du snapshot, or ce snapshot a
          // été posé AVANT l'identification (le tarif qu'il porte est donc l'anonyme, sans
          // remise). Le token est désormais connu -> on rejoue TOUJOURS /tunnel/disponibilite
          // (avec le token) avant d'afficher quoi que ce soit, quelle que soit l'étape où
          // l'identification a été demandée (1, 2 ou 4). On garde temporairement le tarif du
          // snapshot le temps du rafraîchissement, pour éviter un écran "Aucune disponibilité"
          // qui flasherait pendant l'aller-retour réseau.
          state.disponibilite = snap.disponibilite;
          // (correctif 01/09) même traitement que state.disponibilite juste au-dessus, pour la
          // même raison, côté multi-dates : évite le flash "Aucune disponibilité" pendant le
          // rafraîchissement ci-dessous quand des dates supplémentaires ont été restaurées.
          state.disponibiliteMulti = snap.disponibiliteMulti || null;
          var s = state.search;
          if (s.date && s.capaciteMin) {
            // Étape ciblée = celle quittée pour s'identifier, au minimum l'écran Salle (rien à
            // afficher à l'étape Options/Paiement sans disponibilité déjà chargée).
            state.step = Math.max(snap.step || 2, 2);
            if (state.step >= 3) loadOptions();
            // (correctif 01/09, trou du lot D court) — datesSupp restauré ci-dessus : si le client
            // avait ajouté des dates supplémentaires avant de s'identifier, c'est
            // doRechercheMulti() qu'il faut rejouer (avec le token désormais connu), pas
            // doRecherche() qui ignore state.datesSupp et ne verrait que la première date. Le mode
            // de paiement se réimpose de lui-même en 'devis' au rendu de l'étape Paiement
            // (renderStepPaiement(), §8) dès que state.datesSupp n'est pas vide — rien à répéter
            // ici.
            var promesse = state.datesSupp.length ? doRechercheMulti(true) : doRecherche(null, true);
            promesse.then(function () {
              if (state.step === 4) chargerOptionsPaiement();
            });
            return;
          }
          // Snapshot présent mais recherche pas encore remplie (identification demandée dès
          // l'étape 1) : rien à rejouer côté recherche, mais l'identité, elle, se résout quand
          // même juste en dessous — même bloc que le cas « pas de snapshot du tout ».
        }
        // (correctif 30/08 soir) Trou comblé : jusqu'ici, quand aucune recherche n'avait encore
        // été lancée au moment de s'identifier (snapshot absent, ou présent mais incomplet), rien
        // ne rejouait /tunnel/disponibilite ni ne posait state.identifie — le badge/la remise
        // restaient invisibles jusqu'à ce que le client relance une recherche à la main. C'est le
        // cas le plus naturel (le bandeau d'identification est AU-DESSUS du formulaire), confirmé
        // par les logs nginx du test d'Olivier du 30/08 (18h45 et 21h29 : aucune recherche n'a
        // précédé la demande de lien) — cf. /home/ubuntu/maj-doc-token-etape1-2026-08-30.md.
        // Corrigé en résolvant l'identité DÈS L'ARRIVÉE, sans attendre une recherche : on reprend
        // le chemin déjà utilisé et fonctionnel de l'étape 4 (chargerOptionsPaiement ci-dessus,
        // GET /client/moi?token=) plutôt que d'en écrire un troisième. Couvre indifféremment le
        // lien envoyé depuis le bandeau du tunnel et celui envoyé depuis l'espace client (bouton
        // « + Nouvelle réservation », qui repasse aussi ?space_token= vers cette même page).
        api('/client/moi?token=' + encodeURIComponent(state.token)).then(function (moi) {
          state.identifie = true;
          state.identiteInfo = moi;
          render();
        }).catch(function () {
          // Token invalide/expiré/révoqué : jamais bloquant — écran anonyme normal, comme avant.
          render();
        });
        return;
      }
      if (pretAPreremplir) { doRecherche(prefillEspaceCode); return; }
      render();
    };

    // Grille horaire publique (§17.13) — endpoint carve-out public, contrairement à
    // /config/creneaux qui est réservé au staff (SSO). Sert uniquement à l'affichage ; l'échec
    // n'empêche rien (repli sur les horaires alignés grille de computeCreneauHoraires).
    api('/tunnel/creneaux').then(function (data) {
      state.config = data;
      afterConfig();
    }).catch(function () {
      afterConfig();
    });
  }

  init();
})();
