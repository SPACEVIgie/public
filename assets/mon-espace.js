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

  function fmtMontant(n) {
    return n == null ? null : Number(n).toFixed(2) + ' € TTC';
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

    var lignes = state.reservations.map(function (r) {
      var badgeAnnul = r.statut_annulation && LABELS_ANNULATION[r.statut_annulation]
        ? h(['<span class="spme-badge spme-badge-warn">', esc(LABELS_ANNULATION[r.statut_annulation]), '</span>']) : '';
      return h(['<div class="spme-resa-row" data-id="', r.id, '">',
        '<div class="spme-resa-main">',
        '<div class="spme-resa-titre">', esc(r.espace_nom || 'Réservation'), ' — ', esc(r.numero_devis || ('#' + r.id)), '</div>',
        '<div class="spme-resa-dates">', esc(formatDateFr(r.date_debut)),
        (r.date_fin && String(r.date_fin).slice(0, 10) !== String(r.date_debut).slice(0, 10)) ? (' – ' + esc(formatDateFr(r.date_fin))) : '',
        '</div></div>',
        '<div class="spme-resa-statuts">',
        '<span class="spme-badge">', esc(LABELS_RESERVATION[r.statut_reservation] || r.statut_reservation), '</span>',
        badgeAnnul,
        '</div></div>']);
    }).join('');

    return h(['<div class="spme-card">', entete, erreurHtml, '<div class="spme-resa-list">', lignes, '</div></div>']);
  }

  function renderDetail() {
    var d = state.detail;
    if (!d) return '<div class="spme-loading">Chargement…</div>';

    var jours = (d.jours || []).map(function (j) {
      return h(['<div class="spme-jour-row"><span>', esc(formatDateFr(j.date_jour)), '</span>',
        '<span>', esc(j.nombre_personnes_definitif != null ? j.nombre_personnes_definitif : j.nombre_personnes_devis), ' pers.</span>',
        '<span class="spme-badge spme-badge-sm">', esc(LABELS_JOUR[j.statut_jour] || j.statut_jour || ''), '</span>',
        '</div>']);
    }).join('');

    var montant = fmtMontant(d.montant_ttc != null ? d.montant_ttc : d.tarif_ttc);
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
      '<div class="spme-detail-line"><span>Paiement</span><span>', esc(LABELS_PAIEMENT[d.statut_paiement] || d.statut_paiement || '—'), '</span></div>',
      montant ? h(['<div class="spme-detail-line"><span>Montant TTC</span><span>', montant, '</span></div>']) : '',
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
    if (retour) retour.onclick = function () { state.vue = 'liste'; state.detail = null; state.annulationEnvoyee = null; render(); };

    var motif = root.querySelector('.spme-motif');
    if (motif) motif.onchange = function (e) { state.annulationMotif = e.target.value; };

    var btnAnnuler = root.querySelector('.spme-btn-annuler');
    if (btnAnnuler) btnAnnuler.onclick = doAnnuler;
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
