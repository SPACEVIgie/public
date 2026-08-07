(function () {
  'use strict';

  var cfg = window.SpaceReservationConfig || {};
  var API_URL = (cfg.apiUrl || 'https://portail.s-pace.fr/sresa/api').replace(/\/$/, '');
  var PAGE_URL = cfg.pageUrl || window.location.href.split('?')[0];
  var API_KEY = cfg.apiKey || '';
  var SNAPSHOT_KEY = 'spr_pending_snapshot';
  var STRIPE_JS = 'https://js.stripe.com/v3/';

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

  // Montant TTC formaté « 216.00 € TTC » (cohérent avec le style existant du tunnel), ou null.
  function fmtTtc(tarif) {
    if (!tarif || tarif.erreur || tarif.tarif_ttc == null) return null;
    return Number(tarif.tarif_ttc).toFixed(2) + ' € TTC';
  }

  // ===================== SÉLECTION / TARIF PAR SALLE (§17.17.4, release v1.2.0) =====================
  // Chaque salle proposée porte SON PROPRE tarif (e.tarif, calculé à sa taille réelle côté serveur).
  // Le montant affiché suit la salle SÉLECTIONNÉE et se recalcule à chaque changement de choix. La
  // facturation est ancrée côté serveur sur la même taille réelle → prix affiché = prix facturé.
  function espaceSelectionne() {
    if (!state.disponibilite || !state.disponibilite.espaces) return null;
    var id = state.selectedEspaceId;
    return state.disponibilite.espaces.filter(function (e) { return e.id === id; })[0] || null;
  }

  // Tarif de la salle choisie (repli sur le tarif global informatif si la salle n'en porte pas).
  function tarifSelection() {
    var e = espaceSelectionne();
    if (e && e.tarif) return e.tarif;
    return state.disponibilite ? state.disponibilite.tarif : null;
  }

  function montantSelection() {
    var t = tarifSelection();
    return t && !t.erreur && t.tarif_ttc != null ? Number(t.tarif_ttc) : null;
  }

  // ===================== UTILITAIRES DATE/HEURE =====================
  // Les horaires par défaut ci-dessous ne servent QU'À L'AFFICHAGE, en repli si /tunnel/creneaux
  // n'a pas répondu. Ils sont alignés sur la grille S-RESA (§17.1bis). La requête, elle, ne les
  // embarque jamais pour la journée/demi-journée : elle transmet le créneau, et c'est le serveur
  // qui applique la grille (source unique, clés vigie_config sresa_horaire_*).
  function computeCreneauHoraires() {
    var c = state.config || {};
    if (state.search.unite === 'journee') {
      return { debut: c.journee_debut || '08:30', fin: c.journee_fin || '18:00' };
    }
    if (state.search.unite === 'demi_journee') {
      return state.search.demiPeriode === 'matin'
        ? { debut: c.matin_debut || '08:30', fin: c.matin_fin || '12:30' }
        : { debut: c.apresmidi_debut || '14:00', fin: c.apresmidi_fin || '18:00' };
    }
    return { debut: state.search.heureDebut, fin: state.search.heureFin };
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

    root.innerHTML = (state.step < 6 || state.step === 7 ? stepsHtml : '') + errorHtml + body;
    bindEvents();
  }

  function renderDot(n, label, dotStep) {
    var cur = dotStep === undefined ? state.step : dotStep;
    var cls = cur > n ? 'done' : (cur === n ? 'active' : '');
    return '<div class="spr-step-dot ' + cls + '" title="' + esc(label) + '">' + (cur > n ? '✓' : n) + '</div>';
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
      (s.unite !== 'heure' && libelleCreneau()) ? h(['<div class="spr-hint">Horaires : ', esc(libelleCreneau()), '</div>']) : '',
      '<div class="spr-actions spr-end"><button class="spr-btn spr-primary" id="spr-btn-rechercher"', state.loading ? ' disabled' : '', '>', state.loading ? 'Recherche…' : 'Rechercher', '</button></div>',
      '</div>']);
  }

  // ---- Étape 2 : choix de la salle (tarif PAR SALLE) ----
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
      var prixHtml = prixTtc
        ? h(['<div class="spr-room-price">', prixTtc, '</div>'])
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
    var recapSel = sel ? h(['<div class="spr-tarif-box">',
      '<span class="spr-tarif-lbl">', esc(sel.nom), sel.surclasse ? ' · plus grande que votre besoin' : '', '</span>',
      '<span class="spr-tarif-val">', montantTtc || 'Sur devis', '</span>',
      '</div>']) : '';

    return h(['<div class="spr-card">',
      '<div class="spr-title">Choisissez votre espace</div>',
      '<div class="spr-subtitle">', formatDateFr(state.search.date), ' — chaque salle est affichée à son tarif.</div>',
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

    var op = state.optionsPaiement || {};
    var options = [{ value: 'devis', title: 'Demande de devis', sub: 'Nous vous recontactons pour finaliser votre réservation.' }];
    // §4.9 — Paiement en ligne par carte : proposé UNIQUEMENT si le SERVEUR le déclare possible
    // (Stripe configuré, réservation sur un seul jour…). La règle est portée par l'endpoint
    // /options-paiement (§17.14 : pas de règle de bascule figée côté plugin). Visible DÈS LE CHOIX.
    if (op.paiement_en_ligne_disponible) {
      options.push({ value: 'en_ligne', title: 'Paiement en ligne par carte', sub: 'Réservation confirmée immédiatement après le paiement (paiement sécurisé Stripe).' });
    }
    if (op.credit_disponible) {
      options.push({ value: 'credit_salle', title: 'Crédit salle', sub: 'Solde disponible : ' + op.credit_solde_heures + ' h' });
    }
    if (op.paiement_fin_mois_disponible) {
      options.push({ value: 'sur_facture', title: 'Facture fin de mois', sub: 'Réservation confirmée immédiatement.' });
    }
    // Message clair, dès le choix, quand le paiement en ligne n'est pas proposé pour une raison connue
    // (ex. multi-jours) — le client comprend tout de suite que sa demande passera par notre équipe.
    var indispoNote = (!op.paiement_en_ligne_disponible && op.paiement_en_ligne_motif === 'multi_jours')
      ? '<div class="spr-hint">Le paiement en ligne n\'est pas disponible pour une réservation sur plusieurs jours : votre demande sera validée par notre équipe.</div>'
      : '';

    var paymentHtml = options.map(function (o) {
      var selp = state.modePaiement === o.value;
      return h(['<label class="spr-payment-option', selp ? ' spr-selected' : '', '">',
        '<input type="radio" name="spr-mode" value="', o.value, '"', selp ? ' checked' : '', '>',
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
      indispoNote,
      contactHtml,
      '<div class="spr-field"><label>Commentaire (optionnel)</label><textarea id="spr-commentaire" rows="3">', esc(state.commentaire), '</textarea></div>',
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour3">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-continuer4">Continuer →</button>',
      '</div></div>']);
  }

  // ---- Étape 5 : récapitulatif ----
  function renderStepRecap() {
    var espace = espaceSelectionne();
    var montantTtc = fmtTtc(tarifSelection());
    var modeLabels = { devis: 'Demande de devis', en_ligne: 'Paiement en ligne par carte', credit_salle: 'Crédit salle', sur_facture: 'Facture fin de mois' };
    var enLigne = state.modePaiement === 'en_ligne';

    return h(['<div class="spr-card">',
      '<div class="spr-title">Récapitulatif</div>',
      '<div class="spr-recap-line"><span>Espace</span><span>', esc(espace ? espace.nom : ''), espace && espace.surclasse ? ' (plus grande)' : '', '</span></div>',
      '<div class="spr-recap-line"><span>Date</span><span>', formatDateFr(state.search.date), '</span></div>',
      '<div class="spr-recap-line"><span>Effectif</span><span>', esc(state.search.capaciteMin), ' personnes</span></div>',
      '<div class="spr-recap-line"><span>Paiement</span><span>', modeLabels[state.modePaiement] || state.modePaiement, '</span></div>',
      montantTtc ? h(['<div class="spr-recap-line"><span>Montant', enLigne ? ' à régler' : ' estimé', ' TTC</span><span>', montantTtc, '</span></div>']) : '',
      '<div class="spr-actions">',
      '<button class="spr-btn" id="spr-btn-retour4">← Retour</button>',
      '<button class="spr-btn spr-primary" id="spr-btn-envoyer"', state.loading ? ' disabled' : '', '>',
      state.loading ? 'Envoi…' : (enLigne ? 'Continuer vers le paiement →' : 'Envoyer ma demande'), '</button>',
      '</div></div>']);
  }

  // ---- Étape 6 : confirmation (ou prise en compte si conflit §17.14) ----
  function renderStepConfirmation() {
    var r = state.resultat;
    // §17.14 — prise en compte : un conflit d'agenda a été détecté à la confirmation. On ne montre
    // JAMAIS un refus sec (le client a rempli tout son parcours) : on affiche le message de prise en
    // compte renvoyé par le serveur, l'équipe revient vers lui.
    if (state.aRevoir) {
      return h(['<div class="spr-card spr-confirm-box">',
        '<div class="spr-confirm-icon">⏳</div>',
        '<div class="spr-title">Demande prise en compte</div>',
        '<div class="spr-subtitle">', esc(state.messageClient || 'Votre demande a bien été prise en compte. Notre équipe revient vers vous très vite pour la confirmer.'),
        r && r.reservation && r.reservation.numero_devis ? h([' Référence : ', esc(r.reservation.numero_devis), '.']) : '',
        '</div>',
        '</div>']);
    }
    var paye = r && r.reservation && (r.reservation.statut_paiement === 'paye' || state.modePaiement === 'en_ligne');
    return h(['<div class="spr-card spr-confirm-box">',
      '<div class="spr-confirm-icon">✓</div>',
      '<div class="spr-title">', paye ? 'Paiement confirmé' : 'Demande envoyée', '</div>',
      '<div class="spr-subtitle">Référence : ', esc(r && r.reservation ? r.reservation.numero_devis : ''), '. ',
      paye ? 'Votre réservation est confirmée.' : 'Vous recevrez une confirmation par email très prochainement.',
      ' Un email vous a été adressé.</div>',
      '</div>']);
  }

  // ---- Étape 7 : paiement en ligne (Stripe Payment Element) ----
  function renderStepPaiementStripe() {
    var montantTtc = fmtTtc(tarifSelection());
    return h(['<div class="spr-card">',
      '<div class="spr-title">Paiement sécurisé</div>',
      '<div class="spr-subtitle">', montantTtc ? ('Montant à régler : ' + montantTtc + '.') : '', ' Paiement par carte via Stripe.</div>',
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

    if (state.step === 1) {
      if (byId('spr-date')) byId('spr-date').onchange = function (e) { state.search.date = e.target.value; };
      if (byId('spr-type')) byId('spr-type').onchange = function (e) { state.search.typeReservation = e.target.value; };
      if (byId('spr-unite')) byId('spr-unite').onchange = function (e) { state.search.unite = e.target.value; render(); };
      if (byId('spr-capacite')) byId('spr-capacite').onchange = function (e) { state.search.capaciteMin = e.target.value; };
      if (byId('spr-demi')) byId('spr-demi').onchange = function (e) { state.search.demiPeriode = e.target.value; render(); };
      if (byId('spr-heure-debut')) byId('spr-heure-debut').onchange = function (e) { state.search.heureDebut = e.target.value; render(); };
      if (byId('spr-heure-fin')) byId('spr-heure-fin').onchange = function (e) { state.search.heureFin = e.target.value; render(); };
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
  function doRecherche() {
    var s = state.search;
    if (!s.date || !s.capaciteMin) {
      state.error = 'Merci de renseigner une date et un effectif.';
      render();
      return;
    }
    var estHeure = s.unite === 'heure';
    if (estHeure && (!s.heureDebut || !s.heureFin)) {
      state.error = 'Merci de renseigner une heure de début et de fin.';
      render();
      return;
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
      + (estHeure ? '&heure_debut=' + encodeURIComponent(s.heureDebut) + '&heure_fin=' + encodeURIComponent(s.heureFin) : '');

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

  // Charge les modes de paiement disponibles — POUR TOUS (anonyme inclus), afin que le paiement en
  // ligne (qui n'exige pas d'identification) s'affiche dès le choix. Le serveur décide de sa
  // disponibilité (§17.14). Un client identifié y ajoute crédit salle / facture fin de mois.
  function chargerOptionsPaiement() {
    var montant = montantSelection();
    var nbJours = 1; // tunnel public = une seule journée / demi-journée / plage à la fois
    api('/tunnel/options-paiement', {
      method: 'POST',
      body: JSON.stringify({ token: state.token || undefined, montant_ttc: montant, nb_jours: nbJours }),
    }).then(function (data) {
      state.optionsPaiement = data;
      state.identifie = !!data.identifie;
      // Pré-sélection raisonnable du mode par défaut selon ce qui est réellement proposé.
      if (data.identifie && data.credit_disponible) state.modePaiement = 'credit_salle';
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

  function construirePayload() {
    var s = state.search;
    var estHeure = s.unite === 'heure';
    var options = { pauses: [], restauration: [], amenagement_id: state.selectedAmenagementId || undefined };
    Object.keys(state.selectedPauses).forEach(function (id) {
      if (state.selectedPauses[id] > 0) {
        options.pauses.push({ date_jour: s.date, heure_pause: '10:30', formule_id: Number(id), nombre_personnes: state.selectedPauses[id] });
      }
    });
    if (state.selectedRestauration > 0 && state.optionsCatalogue.restauration.length) {
      options.restauration.push({ date_jour: s.date, nombre_personnes: state.selectedRestauration, heure_livraison: '12:30' });
    }

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
      jours: [{ date_jour: s.date, nombre_personnes_devis: Number(s.capaciteMin) }],
      // Catégorie initialement demandée (trace + surclassement). La FACTURATION est ancrée côté
      // serveur sur la taille RÉELLE de la salle choisie (release v1.2.0) → prix affiché = prix facturé.
      taille_demandee_id: state.disponibilite.taille_demandee.id,
      unite: s.unite,
      duree: computeDuree(),
      mode_paiement: state.modePaiement,
      commentaire_general: state.commentaire || undefined,
      options: options,
    };
    if (!state.identifie) payload.contact = state.contact;
    return payload;
  }

  function doReserver() {
    state.loading = true;
    state.error = null;
    render();

    api('/tunnel/reserver', { method: 'POST', body: JSON.stringify(construirePayload()) })
      .then(function (data) {
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
        var paymentElement = state.stripeElements.create('payment');
        var mountEl = document.getElementById('spr-stripe-element');
        if (mountEl) { mountEl.innerHTML = ''; paymentElement.mount('#spr-stripe-element'); }
      })
      .catch(function (err) {
        state.stripeMounted = false;
        stripeStatus(err.message || 'Le paiement en ligne est indisponible pour le moment.');
      });
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
