(function () {
  'use strict';

  var cfg = window.SpaceReservationConfig || {};
  var API_URL = (cfg.apiUrl || 'https://portail.s-pace.fr/sresa/api').replace(/\/$/, '');
  var PAGE_URL = cfg.pageUrl || window.location.href.split('?')[0];
  var SNAPSHOT_KEY = 'spr_pending_snapshot';

  var root = document.getElementById('space-reservation-app');
  if (!root) return;

  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  var state = {
    step: 1,
    config: null,
    search: { date: '', unite: 'journee', demiPeriode: 'matin', heureDebut: '', heureFin: '', typeReservation: 'salle_reunion', capaciteMin: '' },
    disponibilite: null,
    selectedEspaceId: null,
    optionsCatalogue: null,
    selectedPauses: {},
    selectedRestauration: 0,
    selectedAmenagementId: null,
    token: null,
    identifie: false,
    identiteInfo: null,
    optionsPaiement: null,
    modePaiement: 'devis',
    contact: { raison_sociale: '', nom: '', email: '', telephone: '' },
    commentaire: '',
    loading: false,
    error: null,
    resultat: null,
  };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    return fetch(API_URL + path, Object.assign({ headers: headers, cache: 'no-store' }, opts))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Erreur serveur');
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

  // ===================== UTILITAIRES DATE/HEURE =====================
  function computeCreneauHoraires() {
    var c = state.config || {};
    if (state.search.unite === 'journee') {
      return { debut: c.journee_debut || '08:00', fin: c.journee_fin || '18:00' };
    }
    if (state.search.unite === 'demi_journee') {
      return state.search.demiPeriode === 'matin'
        ? { debut: c.matin_debut || '08:00', fin: c.matin_fin || '12:00' }
        : { debut: c.apresmidi_debut || '13:30', fin: c.apresmidi_fin || '17:30' };
    }
    return { debut: state.search.heureDebut, fin: state.search.heureFin };
  }

  function heuresEntre(debut, fin) {
    var d = debut.split(':').map(Number);
    var f = fin.split(':').map(Number);
    return ((f[0] * 60 + f[1]) - (d[0] * 60 + d[1])) / 60;
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

  // ===================== RENDU =====================
  function render() {
    var stepsHtml = h(['<div class="spr-steps">',
      renderDot(1, 'Recherche'), '<div class="spr-step-line"></div>',
      renderDot(2, 'Salle'), '<div class="spr-step-line"></div>',
      renderDot(3, 'Options'), '<div class="spr-step-line"></div>',
      renderDot(4, 'Paiement'), '<div class="spr-step-line"></div>',
      renderDot(5, 'Confirmation'),
      '</div>']);

    var body = '';
    if (state.step === 1) body = renderStepRecherche();
    else if (state.step === 2) body = renderStepSalle();
    else if (state.step === 3) body = renderStepOptions();
    else if (state.step === 4) body = renderStepPaiement();
    else if (state.step === 5) body = renderStepRecap();
    else if (state.step === 6) body = renderStepConfirmation();

    var errorHtml = state.error ? h(['<div class="spr-banner spr-error">', esc(state.error), '</div>']) : '';

    root.innerHTML = (state.step < 6 ? stepsHtml : '') + errorHtml + body;
    bindEvents();
  }

  function renderDot(n, label) {
    var cls = state.step > n ? 'done' : (state.step === n ? 'active' : '');
    return '<div class="spr-step-dot ' + cls + '" title="' + esc(label) + '">' + (state.step > n ? '✓' : n) + '</div>';
  }

  // ---- Étape 1 : recherche ----
  function renderStepRecherche() {
    var s = state.search;
    var demiField = s.unite === 'demi_journee' ? h(['<div class="spr-field"><label>Période</label><select id="spr-demi">',
      '<option value="matin"', s.demiPeriode === 'matin' ? ' selected' : '', '>Matin</option>',
      '<option value="apresmidi"', s.demiPeriode === 'apresmidi' ? ' selected' : '', '>Après-midi</option>',
      '</select></div>']) : '';
    var heureFields = s.unite === 'heure' ? h(['<div class="spr-grid-2">',
      '<div class="spr-field"><label>Heure de début</label><input type="time" id="spr-heure-debut" value="', esc(s.heureDebut), '"></div>',
      '<div class="spr-field"><label>Heure de fin</label><input type="time" id="spr-heure-fin" value="', esc(s.heureFin), '"></div>',
      '</div>']) : '';

    return h(['<div class="spr-card">',
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
      '<div class="spr-actions spr-end"><button class="spr-btn spr-primary" id="spr-btn-rechercher"', state.loading ? ' disabled' : '', '>', state.loading ? 'Recherche…' : 'Rechercher', '</button></div>',
      '</div>']);
  }

  // ---- Étape 2 : choix de la salle ----
  function renderStepSalle() {
    var d = state.disponibilite;
    if (!d || !d.espaces.length) {
      return h(['<div class="spr-card">',
        '<div class="spr-title">Aucune disponibilité</div>',
        '<div class="spr-subtitle">Aucun espace n\'est libre pour ces critères. Laissez-nous vos coordonnées et nous vous recontacterons dès qu\'un créneau se libère.</div>',
        renderListeAttenteBox(),
        '<div class="spr-actions"><button class="spr-btn" id="spr-btn-retour1">← Modifier la recherche</button></div>',
        '</div>']);
    }
    var roomsHtml = d.espaces.map(function (e) {
      var sel = state.selectedEspaceId === e.id;
      return h(['<label class="spr-room-option', sel ? ' spr-selected' : '', '">',
        '<input type="radio" name="spr-espace" value="', e.id, '"', sel ? ' checked' : '', '>',
        '<div><div class="spr-room-name">', esc(e.nom), e.surclasse ? '<span class="spr-room-tag">Surclassement offert</span>' : '', '</div>',
        '<div class="spr-room-cap">Capacité ', esc(e.capacite), ' personnes</div></div>',
        '</label>']);
    }).join('');

    return h(['<div class="spr-card">',
      '<div class="spr-title">Choisissez votre espace</div>',
      '<div class="spr-subtitle">', formatDateFr(state.search.date), '</div>',
      roomsHtml,
      d.tarif && !d.tarif.erreur ? h(['<div class="spr-tarif-box"><span class="spr-tarif-lbl">Tarif estimé</span><span class="spr-tarif-val">', d.tarif.tarif_ttc.toFixed(2), ' € TTC</span></div>']) : '',
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

  // ---- Étape 3 : options ----
  function renderStepOptions() {
    var cat = state.optionsCatalogue;
    if (!cat) return '<div class="spr-card spr-loading">Chargement des options…</div>';

    var pausesHtml = cat.pauses.length ? cat.pauses.map(function (p) {
      var qty = state.selectedPauses[p.id] || 0;
      return h(['<div class="spr-option-row"><div><div class="spr-option-name">', esc(p.nom), '</div>',
        '<div class="spr-option-price">', Number(p.prix_ht).toFixed(2), ' € HT / personne</div></div>',
        '<div class="spr-qty"><button class="spr-qty-minus" data-pause="', p.id, '">−</button><span>', qty, '</span><button class="spr-qty-plus" data-pause="', p.id, '">+</button></div>',
        '</div>']);
    }).join('') : '<div class="spr-subtitle">Aucune pause disponible.</div>';

    var restauRow = cat.restauration.length ? h(['<div class="spr-option-row"><div><div class="spr-option-name">Plateau repas</div>',
      '<div class="spr-option-price">', Number(cat.restauration[0].prix_ht).toFixed(2), ' € HT / personne</div></div>',
      '<div class="spr-qty"><button id="spr-restau-minus">−</button><span>', state.selectedRestauration, '</span><button id="spr-restau-plus">+</button></div>',
      '</div>']) : '';

    var amenagementHtml = cat.amenagements.length ? h(['<div class="spr-field"><label>Aménagement</label><select id="spr-amenagement">',
      '<option value="">Aucun</option>',
      cat.amenagements.map(function (a) {
        return '<option value="' + a.id + '"' + (state.selectedAmenagementId === a.id ? ' selected' : '') + '>' + esc(a.nom) + ' (+' + Number(a.prix_ht).toFixed(2) + ' € HT)</option>';
      }).join(''),
      '</select></div>']) : '';

    return h(['<div class="spr-card">',
      '<div class="spr-title">Options complémentaires</div>',
      '<div class="spr-subtitle">Facultatif — vous pouvez continuer sans rien sélectionner.</div>',
      pausesHtml, restauRow, amenagementHtml,
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour2">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-continuer3">Continuer →</button>',
      '</div></div>']);
  }

  // ---- Étape 4 : identification + mode de paiement + coordonnées ----
  function renderStepPaiement() {
    var identifBlock;
    if (state.identifie) {
      identifBlock = h(['<div class="spr-identified-chip">✓ Connecté', state.identiteInfo && state.identiteInfo.raison_sociale ? (' — ' + esc(state.identiteInfo.raison_sociale)) : '', '</div>']);
    } else {
      identifBlock = h(['<div class="spr-identify-box">',
        '<div class="spr-identify-title">Vous êtes déjà locataire S-PACE ?</div>',
        '<div class="spr-identify-sub">Identifiez-vous pour accéder à votre crédit salle ou à la facturation fin de mois.</div>',
        '<div class="spr-identify-row"><input type="email" id="spr-identify-email" placeholder="votre@email.fr">',
        '<button class="spr-btn" id="spr-btn-identify">Recevoir mon lien</button></div>',
        '</div>']);
    }

    var options = [{ value: 'devis', title: 'Demande de devis', sub: 'Nous vous recontactons pour finaliser votre réservation.' }];
    if (state.optionsPaiement && state.optionsPaiement.credit_disponible) {
      options.push({ value: 'credit_salle', title: 'Crédit salle', sub: 'Solde disponible : ' + state.optionsPaiement.credit_solde_heures + ' h' });
    }
    if (state.optionsPaiement && state.optionsPaiement.paiement_fin_mois_disponible) {
      options.push({ value: 'sur_facture', title: 'Facture fin de mois', sub: 'Réservation confirmée immédiatement.' });
    }
    var paymentHtml = options.map(function (o) {
      var sel = state.modePaiement === o.value;
      return h(['<label class="spr-payment-option', sel ? ' spr-selected' : '', '">',
        '<input type="radio" name="spr-mode" value="', o.value, '"', sel ? ' checked' : '', '>',
        '<div><div class="spr-po-title">', esc(o.title), '</div><div class="spr-po-sub">', esc(o.sub), '</div></div>',
        '</label>']);
    }).join('');

    var contactHtml = state.identifie ? '' : h(['<div class="spr-grid-2">',
      '<div class="spr-field"><label>Société</label><input type="text" id="spr-c-raison" value="', esc(state.contact.raison_sociale), '"></div>',
      '<div class="spr-field"><label>Nom du contact</label><input type="text" id="spr-c-nom" value="', esc(state.contact.nom), '"></div>',
      '</div><div class="spr-grid-2">',
      '<div class="spr-field"><label>Email</label><input type="email" id="spr-c-email" value="', esc(state.contact.email), '"></div>',
      '<div class="spr-field"><label>Téléphone</label><input type="tel" id="spr-c-telephone" value="', esc(state.contact.telephone), '"></div>',
      '</div>']);

    return h(['<div class="spr-card">',
      '<div class="spr-title">Paiement &amp; coordonnées</div>',
      identifBlock,
      '<div class="spr-payment-choice">', paymentHtml, '</div>',
      contactHtml,
      '<div class="spr-field"><label>Commentaire (optionnel)</label><textarea id="spr-commentaire" rows="3">', esc(state.commentaire), '</textarea></div>',
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour3">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-continuer4">Continuer →</button>',
      '</div></div>']);
  }

  // ---- Étape 5 : récapitulatif ----
  function renderStepRecap() {
    var espace = state.disponibilite.espaces.filter(function (e) { return e.id === state.selectedEspaceId; })[0];
    var tarif = state.disponibilite.tarif;
    var modeLabels = { devis: 'Demande de devis', credit_salle: 'Crédit salle', sur_facture: 'Facture fin de mois' };

    return h(['<div class="spr-card">',
      '<div class="spr-title">Récapitulatif</div>',
      '<div class="spr-recap-line"><span>Espace</span><span>', esc(espace ? espace.nom : ''), '</span></div>',
      '<div class="spr-recap-line"><span>Date</span><span>', formatDateFr(state.search.date), '</span></div>',
      '<div class="spr-recap-line"><span>Effectif</span><span>', esc(state.search.capaciteMin), ' personnes</span></div>',
      '<div class="spr-recap-line"><span>Paiement</span><span>', modeLabels[state.modePaiement] || state.modePaiement, '</span></div>',
      tarif && !tarif.erreur ? h(['<div class="spr-recap-line"><span>Montant estimé TTC</span><span>', tarif.tarif_ttc.toFixed(2), ' €</span></div>']) : '',
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour4">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-envoyer"', state.loading ? ' disabled' : '', '>', state.loading ? 'Envoi…' : 'Envoyer ma demande', '</button>',
      '</div></div>']);
  }

  // ---- Étape 6 : confirmation ----
  function renderStepConfirmation() {
    var r = state.resultat;
    return h(['<div class="spr-card spr-confirm-box">',
      '<div class="spr-confirm-icon">✓</div>',
      '<div class="spr-title">Demande envoyée</div>',
      '<div class="spr-subtitle">Référence : ', esc(r && r.reservation ? r.reservation.numero_devis : ''), '. Vous recevrez une confirmation par email très prochainement.</div>',
      '</div>']);
  }

  // ===================== ÉVÉNEMENTS =====================
  function bindEvents() {
    var byId = function (id) { return document.getElementById(id); };

    if (state.step === 1) {
      if (byId('spr-date')) byId('spr-date').onchange = function (e) { state.search.date = e.target.value; };
      if (byId('spr-type')) byId('spr-type').onchange = function (e) { state.search.typeReservation = e.target.value; };
      if (byId('spr-unite')) byId('spr-unite').onchange = function (e) { state.search.unite = e.target.value; render(); };
      if (byId('spr-capacite')) byId('spr-capacite').onchange = function (e) { state.search.capaciteMin = e.target.value; };
      if (byId('spr-demi')) byId('spr-demi').onchange = function (e) { state.search.demiPeriode = e.target.value; };
      if (byId('spr-heure-debut')) byId('spr-heure-debut').onchange = function (e) { state.search.heureDebut = e.target.value; };
      if (byId('spr-heure-fin')) byId('spr-heure-fin').onchange = function (e) { state.search.heureFin = e.target.value; };
      if (byId('spr-btn-rechercher')) byId('spr-btn-rechercher').onclick = doRecherche;
    } else if (state.step === 2) {
      document.querySelectorAll('input[name="spr-espace"]').forEach(function (r) {
        r.onchange = function (e) { state.selectedEspaceId = Number(e.target.value); render(); };
      });
      if (byId('spr-btn-retour1')) byId('spr-btn-retour1').onclick = function () { state.step = 1; render(); };
      if (byId('spr-btn-continuer2')) byId('spr-btn-continuer2').onclick = function () { state.step = 3; loadOptions(); };
      if (byId('spr-btn-attente')) byId('spr-btn-attente').onclick = doListeAttente;
    } else if (state.step === 3) {
      document.querySelectorAll('.spr-qty-plus').forEach(function (b) {
        b.onclick = function () { var id = b.dataset.pause; state.selectedPauses[id] = (state.selectedPauses[id] || 0) + 1; render(); };
      });
      document.querySelectorAll('.spr-qty-minus').forEach(function (b) {
        b.onclick = function () { var id = b.dataset.pause; state.selectedPauses[id] = Math.max(0, (state.selectedPauses[id] || 0) - 1); render(); };
      });
      if (byId('spr-restau-plus')) byId('spr-restau-plus').onclick = function () { state.selectedRestauration++; render(); };
      if (byId('spr-restau-minus')) byId('spr-restau-minus').onclick = function () { state.selectedRestauration = Math.max(0, state.selectedRestauration - 1); render(); };
      if (byId('spr-amenagement')) byId('spr-amenagement').onchange = function (e) { state.selectedAmenagementId = e.target.value ? Number(e.target.value) : null; };
      if (byId('spr-btn-retour2')) byId('spr-btn-retour2').onclick = function () { state.step = 2; render(); };
      if (byId('spr-btn-continuer3')) byId('spr-btn-continuer3').onclick = function () { state.step = 4; chargerOptionsPaiement(); };
    } else if (state.step === 4) {
      if (byId('spr-btn-identify')) byId('spr-btn-identify').onclick = doIdentify;
      document.querySelectorAll('input[name="spr-mode"]').forEach(function (r) {
        r.onchange = function (e) { state.modePaiement = e.target.value; render(); };
      });
      ['spr-c-raison', 'spr-c-nom', 'spr-c-email', 'spr-c-telephone'].forEach(function (id) {
        var field = { 'spr-c-raison': 'raison_sociale', 'spr-c-nom': 'nom', 'spr-c-email': 'email', 'spr-c-telephone': 'telephone' }[id];
        if (byId(id)) byId(id).onchange = function (e) { state.contact[field] = e.target.value; };
      });
      if (byId('spr-commentaire')) byId('spr-commentaire').onchange = function (e) { state.commentaire = e.target.value; };
      if (byId('spr-btn-retour3')) byId('spr-btn-retour3').onclick = function () { state.step = 3; render(); };
      if (byId('spr-btn-continuer4')) byId('spr-btn-continuer4').onclick = function () {
        if (!state.identifie && (!state.contact.raison_sociale || !state.contact.email)) {
          state.error = 'Merci de renseigner au moins la société et l\'email de contact.';
          render();
          return;
        }
        state.error = null;
        state.step = 5;
        render();
      };
    } else if (state.step === 5) {
      if (byId('spr-btn-retour4')) byId('spr-btn-retour4').onclick = function () { state.step = 4; render(); };
      if (byId('spr-btn-envoyer')) byId('spr-btn-envoyer').onclick = doReserver;
    }
  }

  // ===================== ACTIONS =====================
  function doRecherche() {
    var s = state.search;
    if (!s.date || !s.capaciteMin) {
      state.error = 'Merci de renseigner une date et un effectif.';
      render();
      return;
    }
    var horaires = computeCreneauHoraires();
    if (s.unite === 'heure' && (!horaires.debut || !horaires.fin)) {
      state.error = 'Merci de renseigner une heure de début et de fin.';
      render();
      return;
    }
    state.loading = true;
    state.error = null;
    render();

    var dateDebut = s.date + 'T' + horaires.debut + ':00';
    var dateFin = s.date + 'T' + horaires.fin + ':00';
    var qs = '?date_debut=' + encodeURIComponent(dateDebut) + '&date_fin=' + encodeURIComponent(dateFin)
      + '&capacite_min=' + encodeURIComponent(s.capaciteMin) + '&unite=' + encodeURIComponent(s.unite)
      + '&duree=' + encodeURIComponent(computeDuree()) + '&type_reservation=' + encodeURIComponent(s.typeReservation);

    api('/tunnel/disponibilite' + qs).then(function (data) {
      state.disponibilite = data;
      state.selectedEspaceId = data.espaces.length ? data.espaces[0].id : null;
      state.loading = false;
      state.step = 2;
      render();
    }).catch(function (err) {
      state.loading = false;
      state.error = err.message;
      render();
    });
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

  function chargerOptionsPaiement() {
    if (!state.token) { render(); return; }
    var montant = state.disponibilite && state.disponibilite.tarif && !state.disponibilite.tarif.erreur ? state.disponibilite.tarif.tarif_ttc : null;
    api('/tunnel/options-paiement', { method: 'POST', body: JSON.stringify({ token: state.token, montant_ttc: montant }) })
      .then(function (data) {
        state.optionsPaiement = data;
        state.identifie = data.identifie;
        if (data.identifie && data.credit_disponible) state.modePaiement = 'credit_salle';
        else if (data.identifie && data.paiement_fin_mois_disponible) state.modePaiement = 'sur_facture';
        if (data.identifie) {
          api('/client/moi?token=' + encodeURIComponent(state.token)).then(function (moi) {
            state.identiteInfo = moi;
            render();
          }).catch(function () { render(); });
        } else {
          render();
        }
      }).catch(function () { render(); });
  }

  function doIdentify() {
    var email = document.getElementById('spr-identify-email').value.trim();
    if (!email) { state.error = 'Merci de renseigner votre email.'; render(); return; }
    try {
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        search: state.search, disponibilite: state.disponibilite, selectedEspaceId: state.selectedEspaceId,
        selectedPauses: state.selectedPauses, selectedRestauration: state.selectedRestauration,
        selectedAmenagementId: state.selectedAmenagementId, step: 4,
      }));
    } catch (e) { /* sessionStorage indisponible : tant pis, pas bloquant */ }

    api('/client/demander-lien', { method: 'POST', body: JSON.stringify({ email: email, redirect_url: PAGE_URL }) })
      .then(function () {
        state.error = null;
        root.innerHTML = '<div class="spr-card"><div class="spr-banner spr-ok">Email envoyé ! Cliquez sur le lien reçu pour revenir ici identifié(e) (valable 2 heures).</div></div>';
      }).catch(function (err) {
        state.error = err.message;
        render();
      });
  }

  function doReserver() {
    state.loading = true;
    state.error = null;
    render();

    var s = state.search;
    var horaires = computeCreneauHoraires();
    var options = { pauses: [], restauration: [], amenagement_id: state.selectedAmenagementId || undefined };
    Object.keys(state.selectedPauses).forEach(function (id) {
      if (state.selectedPauses[id] > 0) {
        options.pauses.push({ date_jour: s.date, heure_pause: '10:30', recette_id: Number(id), nombre_personnes: state.selectedPauses[id] });
      }
    });
    if (state.selectedRestauration > 0 && state.optionsCatalogue.restauration.length) {
      options.restauration.push({ date_jour: s.date, nombre_personnes: state.selectedRestauration, heure_livraison: '12:30' });
    }

    var payload = {
      token: state.token || undefined,
      espace_id: state.selectedEspaceId,
      unite_choisie: s.unite,
      heure_debut: horaires.debut,
      heure_fin: horaires.fin,
      jours: [{ date_jour: s.date, nombre_personnes_devis: Number(s.capaciteMin) }],
      taille_demandee_id: state.disponibilite.taille_demandee.id,
      unite: s.unite,
      duree: computeDuree(),
      mode_paiement: state.modePaiement,
      commentaire_general: state.commentaire || undefined,
      options: options,
    };
    if (!state.identifie) {
      payload.contact = state.contact;
    }

    api('/tunnel/reserver', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (data) {
        state.resultat = data;
        state.loading = false;
        state.step = 6;
        render();
      }).catch(function (err) {
        state.loading = false;
        state.error = err.message;
        render();
      });
  }

  // ===================== INIT =====================
  function init() {
    var params = new URLSearchParams(window.location.search);
    var tokenFromUrl = params.get('space_token');

    var afterConfig = function () {
      if (tokenFromUrl) {
        state.token = tokenFromUrl;
        var raw = null;
        try { raw = sessionStorage.getItem(SNAPSHOT_KEY); } catch (e) { /* noop */ }
        if (raw) {
          try {
            var snap = JSON.parse(raw);
            Object.assign(state, {
              search: snap.search, disponibilite: snap.disponibilite, selectedEspaceId: snap.selectedEspaceId,
              selectedPauses: snap.selectedPauses, selectedRestauration: snap.selectedRestauration,
              selectedAmenagementId: snap.selectedAmenagementId,
            });
            sessionStorage.removeItem(SNAPSHOT_KEY);
            state.step = 4;
            loadOptions();
            chargerOptionsPaiement();
            return;
          } catch (e) { /* snapshot invalide, on repart de l'étape 1 */ }
        }
      }
      render();
    };

    api('/config/creneaux').then(function (data) {
      state.config = data;
      afterConfig();
    }).catch(function () {
      afterConfig();
    });
  }

  init();
})();
