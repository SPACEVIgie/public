(function () {
  'use strict';

  // [space_mon_espace] (1.5.0 — réécrit) — l'espace client COMPLET, sur le site : email → lien reçu
  // (ramène ICI) → liste des réservations → détail → demande d'annulation. Même mécanisme que
  // l'identification du tunnel (assets/tunnel.js) : lien magique par email, token lu en
  // ?space_token=, résolu côté serveur par resoudreCompte() (middleware/clientAuth.js) — routes
  // routes/espaceClient.js (demander-lien, moi, reservations, reservations/:id, .../annuler), AUCUNE
  // dupliquée ici.

  var cfg = window.SpaceMonEspaceConfig || {};
  var API_URL = (cfg.apiUrl || 'https://portail.s-pace.fr/sresa/api').replace(/\/$/, '');
  var API_KEY = cfg.apiKey || '';
  var PAGE_URL = cfg.pageUrl || window.location.href.split('?')[0];
  // (1.5.0) URL de retour du lien magique — réglage « URL de retour du lien magique » (vide →
  // repli sur cette page elle-même, cf. s-pace-reservation.php space_reservation_config_commune()).
  var RETURN_URL = cfg.magicReturnUrl || PAGE_URL;
  // (1.6.0) Bouton « Nouvelle réservation » → réglage « URL de la page de réservation ». Vide →
  // pas de bouton (cf. s-pace-reservation.php space_mon_espace_enqueue_assets() : pas de
  // destination devinée, une URL fausse enverrait le client sur une page 404).
  var RESERVATION_URL = cfg.reservationUrl || '';

  var root = document.getElementById('space-mon-espace-app');
  if (!root) return;

  // (30/08, module partagé) — window.SresaEspaceClientCore est chargé AVANT ce fichier (dépendance
  // wp_enqueue_script posée par s-pace-reservation.php), depuis le même fichier que la page autonome
  // S-RESA (portail.s-pace.fr/sresa/espace-client.js). Il porte désormais les deux gestes libre-
  // service « Modifier l'effectif »/« Supprimer un jour » (jusqu'ici absents d'ici, cf. incident
  // 69eff8a : deux implémentations divergent toujours) et le vocabulaire traduit "Participants".
  // AUCUNE logique de verrou/palier n'est recopiée ici — seul l'appel au cœur + le rendu.
  //
  // WordPress garantit l'ORDRE de chargement des deux scripts, pas le SUCCÈS du fetch réseau
  // externe (le portail peut être indisponible) : on teste donc window.SresaEspaceClientCore À
  // L'USAGE (dans render()/les actions), jamais une seule fois au chargement. Sans lui : les deux
  // contrôles sont masqués avec un message, TOUT LE RESTE de la page (liste, détail, annulation,
  // montant HT, motif) continue de fonctionner à l'identique — jamais de page blanche.
  function coreDisponible() { return !!window.SresaEspaceClientCore; }
  function apiBaseClient() { return API_URL + '/client'; }

  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  var LABELS_RESERVATION = {
    option: 'Option posée', simulation: 'Simulation', devis_envoye: 'Devis envoyé',
    confirme: 'Confirmée', annulee: 'Annulée', non_confirmee: 'Non confirmée',
  };
  var LABELS_PAIEMENT = {
    en_attente: 'En attente', paye: 'Payé', rembourse: 'Remboursé',
    partiellement_rembourse: 'Partiellement remboursé', echec: 'Échec',
  };
  var LABELS_ANNULATION = {
    demande_annulation_client: "Demande d'annulation en cours",
    annulee_client: 'Annulée (à votre demande)',
    annulee_interne: 'Annulée (par notre équipe)',
  };
  var LABELS_JOUR = { a_definir: 'À définir', definitif: 'Définitif' };

  var state = {
    vue: 'email', // email | envoye | liste | detail | erreur
    token: null,
    email: '',
    erreur: null,
    loading: false,
    moi: null,
    reservations: [],
    detail: null,
    annulationMotif: '',
    annulationEnvoyee: null, // { palier } après succès
    // (30/08) un seul geste jour à la fois affiché en confirmation deux-temps inline (même patron
    // que annulationMotif/annulationEnvoyee ci-dessus, jamais de modale) :
    // { jourId, loading:true } | { jourId, confirmingDelete:true, libelleHtml } | { jourId, deleting:true } | { jourId, error }
    jourSupprConfirm: null,
  };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-Space-Api-Key'] = API_KEY;
    return fetch(API_URL + path, Object.assign({ headers: headers, cache: 'no-store' }, opts))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) { var e = new Error(data.error || 'Erreur serveur'); e.status = res.status; throw e; }
          return data;
        });
      });
  }

  function withToken(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(state.token);
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

  function formatDateFr(iso) {
    if (!iso) return '';
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear();
  }

  // (30/08, régression du 29/08) — la LISTE d'une réservation affichait r.date_debut/r.date_fin
  // (reservations_salles, un seul bloc — le même défaut « 23 novembre » pour une résa de 4 jours
  // jusqu'au 14 décembre que côté serveur, cf. routes/espaceClient.js) jusqu'à ce que le correctif du
  // 29/08 (commit s-pace-suite 69eff8a) fasse porter GET /client/reservations par premier_jour/
  // dernier_jour/nb_jours (agrégés depuis sresa_jours) à la place — SANS ces deux champs, qui
  // n'existent plus du tout sur cette route. Ce fichier n'avait pas suivi (dernier commit avant celui-
  // ci : 25/08, montant HT) : formatDateFr(r.date_debut) retournait '' (undefined), d'où l'absence
  // totale de date constatée le 29/08 au soir — numéro + statut seuls. Même calcul que
  // portail/sresa/public/espace-client.js::labelPeriode (l'autre écran, déjà à jour depuis le 29/08) :
  // une seule date si un seul jour, sinon toujours "N journées, du … au …", même si les jours sont
  // consécutifs (un intervalle seul laisserait croire à une occupation continue).
  function formatPeriode(r) {
    if (!r.premier_jour) return '';
    if (Number(r.nb_jours) <= 1) return formatDateFr(r.premier_jour);
    return r.nb_jours + ' journées, du ' + formatDateFr(r.premier_jour) + ' au ' + formatDateFr(r.dernier_jour);
  }

  // (30/08, module partagé) — periodeLabel/paiementLabel préfèrent désormais le calcul du cœur
  // partagé (identique à celui d'espace-client.js — plus jamais un 5e endroit qui recopie le même
  // calcul, cf. commentaire au-dessus). formatPeriode/LABELS_PAIEMENT restent le repli si le
  // portail est indisponible (dégradation propre, jamais de page blanche).
  function periodeLabel(r) {
    return coreDisponible() ? window.SresaEspaceClientCore.labelPeriode(r) : formatPeriode(r);
  }

  // paiementLabel corrige au passage un écart réel avec la page autonome : ce fichier ne lisait
  // que statut_paiement (valeur technique de base), jamais mode_paiement — une réservation réglée
  // sur facture/crédit salle/gratuite affichait donc "En attente" ici, à tort (le paiement Stripe
  // n'est simplement pas le canal utilisé). window.SresaEspaceClientCore.labelPaiement vérifie
  // mode_paiement EN PREMIER, exactement comme espace-client.js.
  function paiementLabel(d) {
    if (coreDisponible()) return window.SresaEspaceClientCore.labelPaiement(d);
    return LABELS_PAIEMENT[d.statut_paiement] || d.statut_paiement || '—';
  }

  // (25/08, §4) TTC toujours affiché ; HT en information QUAND il est fiable. Un montant_ttc
  // MANUEL (staff, cf. précédent du 16/08 — « le miroir HT/TTC n'était pas un bug, le tarif était
  // manuel ») n'a pas de contrepartie HT fiable : mieux vaut alors ne montrer QUE le TTC que
  // d'afficher un HT halluciné à côté d'un montant qu'il ne recalcule plus.
  function fmtMontant(ttc, ht) {
    if (ttc == null) return null;
    return { ttc: Number(ttc).toFixed(2) + ' € TTC', ht: ht != null ? Number(ht).toFixed(2) + ' € HT' : null };
  }

  // ===================== RENDU =====================
  function render() {
    var body = '';
    if (state.vue === 'email') body = renderEmail();
    else if (state.vue === 'envoye') body = renderEnvoye();
    else if (state.vue === 'erreur') body = renderErreur();
    else if (state.vue === 'liste') body = renderListe();
    else if (state.vue === 'detail') body = renderDetail();
    else body = '<div class="spme-loading">Chargement…</div>';

    root.innerHTML = body;
    bind();
  }

  function renderEmail() {
    return h(['<div class="spme-card">',
      '<div class="spme-title">Mon espace S-PACE</div>',
      '<p class="spme-text">Retrouvez vos réservations, leur statut et vos demandes d\'annulation. ',
      'Indiquez votre email, vous recevez un lien de connexion valable 2 heures — aucun mot de passe.</p>',
      state.erreur ? h(['<div class="spme-banner spme-error">', esc(state.erreur), '</div>']) : '',
      '<div class="spme-identify-row">',
      '<input type="email" class="spme-email-input" placeholder="votre@email.fr" value="', esc(state.email), '">',
      '<button class="spme-btn spme-primary spme-btn-envoyer"', state.loading ? ' disabled' : '', '>',
      state.loading ? 'Envoi…' : 'Recevoir mon lien', '</button>',
      '</div></div>']);
  }

  function renderEnvoye() {
    return h(['<div class="spme-card">',
      '<div class="spme-title">Mon espace S-PACE</div>',
      '<div class="spme-banner spme-ok">Email envoyé ! Cliquez sur le lien reçu (valable 2 heures) pour retrouver vos réservations ici.</div>',
      '</div>']);
  }

  function renderErreur() {
    return h(['<div class="spme-card">',
      '<div class="spme-title">Mon espace S-PACE</div>',
      '<div class="spme-banner spme-error">', esc(state.erreur || 'Lien invalide ou expiré.'), '</div>',
      '<p class="spme-text">Redemandez un lien de connexion ci-dessous.</p>',
      '<div class="spme-identify-row">',
      '<input type="email" class="spme-email-input" placeholder="votre@email.fr" value="', esc(state.email), '">',
      '<button class="spme-btn spme-primary spme-btn-envoyer"', state.loading ? ' disabled' : '', '>',
      state.loading ? 'Envoi…' : 'Recevoir mon lien', '</button>',
      '</div></div>']);
  }

  // Lien vers le tunnel de réservation, IDENTIFIÉ : le token qui a ouvert cet espace (lien magique,
  // valable 2 heures) est repassé en ?space_token= — tunnel.js le lit au chargement (même paramètre,
  // même resoudreCompte() côté serveur) et le client n'a pas à redonner son email. Cf. réglage
  // « URL de la page de réservation ».
  function lienNouvelleReservation() {
    if (!RESERVATION_URL) return null;
    var sep = RESERVATION_URL.indexOf('?') >= 0 ? '&' : '?';
    return RESERVATION_URL + sep + 'space_token=' + encodeURIComponent(state.token);
  }

  function renderListe() {
    var lienResa = lienNouvelleReservation();
    var entete = h(['<div class="spme-header">',
      '<div>',
      '<div class="spme-title">Mes réservations</div>',
      state.moi && state.moi.raison_sociale ? h(['<div class="spme-sub">', esc(state.moi.raison_sociale), '</div>']) : '',
      '</div>',
      lienResa ? h(['<a class="spme-btn spme-primary" href="', esc(lienResa), '">+ Nouvelle réservation</a>']) : '',
      '</div>']);
    // Erreur venue du détail (ex. réservation devenue inaccessible) : affichée ici puis effacée,
    // pour ne pas la répéter à chaque retour sur la liste.
    var erreurHtml = state.erreur ? h(['<div class="spme-banner spme-error">', esc(state.erreur), '</div>']) : '';
    state.erreur = null;

    if (!state.reservations.length) {
      return h(['<div class="spme-card">', entete, erreurHtml,
        '<p class="spme-text">Aucune réservation trouvée pour ce compte.</p></div>']);
    }

    function ligneResa(r) {
      var badgeAnnul = r.statut_annulation && LABELS_ANNULATION[r.statut_annulation]
        ? h(['<span class="spme-badge spme-badge-warn">', esc(LABELS_ANNULATION[r.statut_annulation]), '</span>']) : '';
      return h(['<div class="spme-resa-row" data-id="', r.id, '">',
        '<div class="spme-resa-main">',
        '<div class="spme-resa-titre">', esc(r.espace_nom || 'Réservation'), ' — ', esc(r.numero_devis || ('#' + r.id)), '</div>',
        '<div class="spme-resa-dates">', esc(periodeLabel(r)), '</div></div>',
        '<div class="spme-resa-statuts">',
        '<span class="spme-badge">', esc(LABELS_RESERVATION[r.statut_reservation] || r.statut_reservation), '</span>',
        badgeAnnul,
        '</div></div>']);
    }

    // Ordre : plus proche au plus lointain, passées à part (même tri que
    // portail/sresa/public/espace-client.js::afficherListe, posé le 29/08 — l'API renvoie déjà
    // est_passee calculé côté SQL sur CURRENT_DATE, jamais new Date() ici, cf. piège UTC+2 pg). "À
    // venir" inclut les réservations en cours, triées du plus proche au plus lointain ; "Passées",
    // séparées, du plus récent au plus ancien.
    var aVenir = state.reservations.filter(function (r) { return !r.est_passee; })
      .sort(function (a, b) { return a.premier_jour < b.premier_jour ? -1 : 1; });
    var passees = state.reservations.filter(function (r) { return r.est_passee; })
      .sort(function (a, b) { return a.dernier_jour > b.dernier_jour ? -1 : 1; });

    function section(titre, liste) {
      return liste.length ? h(['<h3 class="spme-section-titre">', titre, '</h3>', liste.map(ligneResa).join('')]) : '';
    }

    var lignes = section('À venir', aVenir) + section('Passées', passees);

    return h(['<div class="spme-card">', entete, erreurHtml, '<div class="spme-resa-list">', lignes, '</div></div>']);
  }

  // Zone de confirmation deux-temps pour la suppression d'un jour (Cran 3, PRINCIPES.md — jamais
  // de modale). Même patron que le bloc annulation ci-dessous, scopé à CE jour plutôt qu'à toute
  // la fiche. libelleHtml vient de window.SresaEspaceClientCore.apercuSuppressionJour — DÉJÀ du
  // HTML sûr (même construction que le lien CGPS d'espace-client.js), jamais ré-échappé ici.
  function renderJourSupprZone(jourId) {
    var action = state.jourSupprConfirm;
    if (!action || action.jourId !== jourId) return '';
    if (action.loading) return '<p class="spme-text">Calcul en cours…</p>';
    if (action.deleting) return '<p class="spme-text">Suppression…</p>';
    if (action.error) return h(['<div class="spme-banner spme-error">', esc(action.error), '</div>']);
    if (action.confirmingDelete) {
      return h(['<div class="spme-annuler-box">',
        '<p class="spme-text">', action.libelleHtml, '</p>',
        '<button class="spme-btn spme-btn-danger spme-btn-jour-suppr-confirmer" data-jour-id="', jourId, '">Oui, supprimer ce jour</button>',
        '<button class="spme-btn spme-btn-jour-suppr-annuler" data-jour-id="', jourId, '">Non</button>',
        '</div>']);
    }
    return '';
  }

  function renderDetail() {
    var d = state.detail;
    if (!d) return '<div class="spme-loading">Chargement…</div>';

    var core = coreDisponible();
    // (30/08) fenêtre/verrous du geste effectif au niveau RÉSERVATION (même prédicat que
    // espace-client.js::effectifModifiable — jamais recalculé ici). "Supprimer ce jour" est un
    // prédicat PAR JOUR (window.SresaEspaceClientCore.jourSupprimable), évalué jour par jour
    // ci-dessous. Toutes les AUTRES règles (NANR, tarif fixé à la main, commande déjà partie,
    // stock déjà décrémenté…) restent arbitrées côté SERVEUR, jamais devinées ici.
    var peutEditerEffectif = core && window.SresaEspaceClientCore.effectifModifiable(d);
    var gestesIndisponibles = !core && d.statut_annulation === 'active';

    var jours = (d.jours || []).map(function (j) {
      var valeur = j.nombre_personnes_definitif != null ? j.nombre_personnes_definitif : j.nombre_personnes_devis;
      var peutSupprimerCeJour = core && window.SresaEspaceClientCore.jourSupprimable(d, j);
      var afficherBoutonSuppr = peutSupprimerCeJour && !(state.jourSupprConfirm && state.jourSupprConfirm.jourId === j.id);
      return h(['<div class="spme-jour-row"><span>', esc(formatDateFr(j.date_jour)), '</span>',
        '<span>', esc(valeur), ' pers.</span>',
        '<span class="spme-badge spme-badge-sm">', esc(LABELS_JOUR[j.statut_jour] || j.statut_jour || ''), '</span>',
        '</div>',
        core ? h(['<div class="spme-jour-gestes">',
          '<input type="number" min="0" class="spme-effectif-input" data-jour-id="', j.id, '" value="', esc(valeur), '"', peutEditerEffectif ? '' : ' disabled', '>',
          '<button class="spme-btn spme-btn-effectif" data-jour-id="', j.id, '"', peutEditerEffectif ? '' : ' disabled', '>Mettre à jour</button>',
          afficherBoutonSuppr ? h(['<button class="spme-btn spme-btn-danger spme-btn-jour-suppr" data-jour-id="', j.id, '">Supprimer ce jour</button>']) : '',
          '</div>',
          renderJourSupprZone(j.id)]) : '']);
    }).join('');

    var montantManuel = d.montant_ttc != null; // cf. fmtMontant ci-dessus
    var montant = fmtMontant(montantManuel ? d.montant_ttc : d.tarif_ttc, montantManuel ? null : d.tarif_ht_net);
    var peutAnnuler = d.statut_annulation === 'active' && d.statut_reservation !== 'annulee';

    var blocAnnulation = '';
    if (state.annulationEnvoyee) {
      blocAnnulation = h(['<div class="spme-banner spme-ok">Votre demande d\'annulation a bien été transmise',
        state.annulationEnvoyee.palier != null ? (' (remboursement indicatif : ' + esc(state.annulationEnvoyee.palier) + '%).') : '.',
        ' Notre équipe la traite.</div>']);
    } else if (peutAnnuler) {
      blocAnnulation = h(['<div class="spme-annuler-box">',
        '<div class="spme-identify-title">Demander l\'annulation</div>',
        '<textarea class="spme-motif" rows="2" placeholder="Motif (optionnel)">', esc(state.annulationMotif), '</textarea>',
        '<button class="spme-btn spme-btn-annuler"', state.loading ? ' disabled' : '', '>',
        state.loading ? 'Envoi…' : "Demander l'annulation", '</button>',
        '</div>']);
    } else if (d.statut_annulation && LABELS_ANNULATION[d.statut_annulation]) {
      blocAnnulation = h(['<div class="spme-banner spme-info">', esc(LABELS_ANNULATION[d.statut_annulation]), '</div>']);
    }

    return h(['<div class="spme-card">',
      '<button class="spme-btn spme-ghost spme-btn-retour">← Mes réservations</button>',
      '<div class="spme-title" style="margin-top:12px;">', esc(d.espace_nom || 'Réservation'), '</div>',
      '<div class="spme-sub">', esc(d.numero_devis || ('#' + d.id)), '</div>',
      state.erreur ? h(['<div class="spme-banner spme-error">', esc(state.erreur), '</div>']) : '',
      '<div class="spme-detail-line"><span>Statut</span><span>', esc(LABELS_RESERVATION[d.statut_reservation] || d.statut_reservation), '</span></div>',
      // (30/08) "Participants" : même calcul que espace-client.js::labelStatutParticipants
      // (à définir/définitifs/partiellement définitifs), une info DISTINCTE du "Statut" ci-dessus
      // (cycle de vie de la réservation) — jamais affichée ici avant ce chantier, ajoutée en tant
      // que complément (pas un remplacement), directement liée aux deux gestes ci-dessous.
      core ? h(['<div class="spme-detail-line"><span>Participants</span><span>', esc(window.SresaEspaceClientCore.labelStatutParticipants(d).texte), '</span></div>']) : '',
      '<div class="spme-detail-line"><span>Paiement</span><span>', esc(paiementLabel(d)), '</span></div>',
      montant ? h(['<div class="spme-detail-line"><span>Montant</span><span>',
        montant.ht ? h(['<span class="spme-montant-ht">', montant.ht, '</span> · ']) : '',
        montant.ttc, '</span></div>']) : '',
      gestesIndisponibles ? h(['<div class="spme-banner spme-info" style="margin-top:8px;">',
        "Modification de l'effectif et suppression de jour temporairement indisponibles. Contactez-nous si besoin.",
        '</div>']) : '',
      '<div class="spme-jours">', jours, '</div>',
      blocAnnulation,
      '</div>']);
  }

  // ===================== ÉVÉNEMENTS =====================
  function bind() {
    var envoyer = root.querySelector('.spme-btn-envoyer');
    if (envoyer) envoyer.onclick = doIdentify;
    var input = root.querySelector('.spme-email-input');
    if (input) input.onkeydown = function (e) { if (e.key === 'Enter') doIdentify(); };

    root.querySelectorAll('.spme-resa-row').forEach(function (row) {
      row.onclick = function () { ouvrirDetail(Number(row.getAttribute('data-id'))); };
    });

    var retour = root.querySelector('.spme-btn-retour');
    if (retour) retour.onclick = function () { state.vue = 'liste'; state.detail = null; state.annulationEnvoyee = null; state.jourSupprConfirm = null; render(); };

    var motif = root.querySelector('.spme-motif');
    if (motif) motif.onchange = function (e) { state.annulationMotif = e.target.value; };

    var btnAnnuler = root.querySelector('.spme-btn-annuler');
    if (btnAnnuler) btnAnnuler.onclick = doAnnuler;

    // (30/08) gestes 1 & 2 — chaque bouton porte data-jour-id, jamais de closure sur l'index de
    // boucle (root.innerHTML est régénéré à chaque render(), les boutons ne survivent jamais).
    root.querySelectorAll('.spme-btn-effectif').forEach(function (btn) {
      btn.onclick = function () { doDefinirEffectif(Number(btn.getAttribute('data-jour-id'))); };
    });
    root.querySelectorAll('.spme-btn-jour-suppr').forEach(function (btn) {
      btn.onclick = function () { doJourSupprimerDemander(Number(btn.getAttribute('data-jour-id'))); };
    });
    root.querySelectorAll('.spme-btn-jour-suppr-confirmer').forEach(function (btn) {
      btn.onclick = function () { doJourSupprimerConfirmer(Number(btn.getAttribute('data-jour-id'))); };
    });
    root.querySelectorAll('.spme-btn-jour-suppr-annuler').forEach(function (btn) {
      btn.onclick = function () { state.jourSupprConfirm = null; render(); };
    });
  }

  // ===================== ACTIONS =====================
  function doIdentify() {
    var input = root.querySelector('.spme-email-input');
    var email = input ? input.value.trim() : '';
    if (!email) { state.erreur = 'Merci de renseigner votre email.'; render(); return; }
    state.email = email;
    state.loading = true;
    state.erreur = null;
    render();

    api('/client/demander-lien', { method: 'POST', body: JSON.stringify({ email: email, redirect_url: RETURN_URL }) })
      .then(function () {
        state.loading = false;
        state.vue = 'envoye';
        render();
      }).catch(function (err) {
        state.loading = false;
        state.erreur = err.message;
        render();
      });
  }

  function chargerEspace() {
    state.vue = 'chargement';
    render();
    api(withToken('/client/moi')).then(function (moi) {
      state.moi = moi;
      return api(withToken('/client/reservations'));
    }).then(function (reservations) {
      state.reservations = reservations;
      state.vue = 'liste';
      render();
    }).catch(function (err) {
      state.vue = 'erreur';
      state.erreur = err.status === 401
        ? 'Ce lien de connexion est invalide ou a expiré (validité : 2 heures). Redemandez-en un.'
        : (err.message || 'Erreur de chargement.');
      render();
    });
  }

  function ouvrirDetail(id) {
    state.vue = 'chargement';
    state.annulationEnvoyee = null;
    state.annulationMotif = '';
    state.jourSupprConfirm = null;
    state.erreur = null;
    render();
    api(withToken('/client/reservations/' + encodeURIComponent(id))).then(function (data) {
      state.detail = data;
      state.vue = 'detail';
      render();
    }).catch(function (err) {
      state.vue = 'liste';
      state.erreur = err.message;
      render();
    });
  }

  function doAnnuler() {
    if (!state.detail) return;
    state.loading = true;
    render();
    api(withToken('/client/reservations/' + encodeURIComponent(state.detail.id) + '/annuler'), {
      method: 'POST', body: JSON.stringify({ token: state.token, motif: state.annulationMotif || undefined }),
    }).then(function (data) {
      state.loading = false;
      state.annulationEnvoyee = { palier: data.palier };
      render();
    }).catch(function (err) {
      state.loading = false;
      state.erreur = err.message;
      render();
    });
  }

  // (30/08, module partagé) — gestes 1 & 2 : chaque fonction appelle UNIQUEMENT
  // window.SresaEspaceClientCore (aucun appel api()/fetch direct ici, aucune règle de verrou
  // recopiée) puis fait son propre rendu à partir du résultat structuré { ok, ... }. Recharge la
  // fiche après succès — même comportement que espace-client.js::jourSupprimerConfirmer/
  // definirJourEffectif (afficherDetail(id) après écriture).
  function doDefinirEffectif(jourId) {
    if (!coreDisponible() || !state.detail) return;
    var input = root.querySelector('.spme-effectif-input[data-jour-id="' + jourId + '"]');
    var valeur = input ? Number(input.value) : NaN;
    if (!isFinite(valeur) || valeur < 0) return;
    var id = state.detail.id;
    window.SresaEspaceClientCore.definirJourEffectif(id, jourId, valeur, { token: state.token, apiBase: apiBaseClient() })
      .then(function (r) {
        if (r.ok) { ouvrirDetail(id); return; }
        state.erreur = r.message;
        render();
      });
  }

  function doJourSupprimerDemander(jourId) {
    if (!coreDisponible() || !state.detail) return;
    state.jourSupprConfirm = { jourId: jourId, loading: true };
    render();
    window.SresaEspaceClientCore.apercuSuppressionJour(state.detail.id, jourId, { token: state.token, apiBase: apiBaseClient() })
      .then(function (r) {
        state.jourSupprConfirm = r.ok
          ? { jourId: jourId, confirmingDelete: true, libelleHtml: r.libelle }
          : { jourId: jourId, error: r.message };
        render();
      });
  }

  function doJourSupprimerConfirmer(jourId) {
    if (!coreDisponible() || !state.detail) return;
    var id = state.detail.id;
    state.jourSupprConfirm = { jourId: jourId, deleting: true };
    render();
    window.SresaEspaceClientCore.supprimerJour(id, jourId, { token: state.token, apiBase: apiBaseClient() })
      .then(function (r) {
        if (r.ok) { state.jourSupprConfirm = null; ouvrirDetail(id); return; }
        state.jourSupprConfirm = { jourId: jourId, error: r.message };
        render();
      });
  }

  // ===================== INIT =====================
  function init() {
    var params = new URLSearchParams(window.location.search);
    var tokenFromUrl = params.get('space_token');
    if (tokenFromUrl) {
      state.token = tokenFromUrl;
      chargerEspace();
      return;
    }
    render();
  }

  init();
})();
