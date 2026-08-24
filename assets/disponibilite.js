(function () {
  'use strict';

  // [space_disponibilite] (1.5.0) — « quand puis-je venir dans cette salle ? ». Un widget PAR
  // OCCURRENCE (une page peut lister plusieurs salles) : chaque .spd-app se comporte de façon
  // indépendante, rien de partagé. Mêmes 3 durées que le tunnel [space_reservation]
  // (journee / demi_journee / heure) — reprises telles quelles, aucune inventée ici.

  var cfg = window.SpaceDispoConfig || {};
  var API_URL = (cfg.apiUrl || 'https://portail.s-pace.fr/sresa/api').replace(/\/$/, '');
  var API_KEY = cfg.apiKey || '';

  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
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

  function formatDateFr(iso) {
    var d = new Date(iso + 'T00:00:00');
    return d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtTarif(tarif) {
    if (!tarif || tarif.erreur || tarif.tarif_ttc == null) return null;
    return Number(tarif.tarif_ttc).toFixed(2) + ' € TTC';
  }

  function initWidget(root) {
    var salle = root.getAttribute('data-salle') || '';
    var tunnelUrl = root.getAttribute('data-tunnel') || '';

    var state = {
      unite: 'journee', demiPeriode: 'matin', heureDebut: '', heureFin: '',
      loading: true, error: null, resultat: null,
    };

    function render() {
      var demiField = state.unite === 'demi_journee' ? h(['<div class="spd-field"><label>Période</label><select class="spd-demi">',
        '<option value="matin"', state.demiPeriode === 'matin' ? ' selected' : '', '>Matin</option>',
        '<option value="apres_midi"', state.demiPeriode === 'apres_midi' ? ' selected' : '', '>Après-midi</option>',
        '</select></div>']) : '';
      var heureFields = state.unite === 'heure' ? h(['<div class="spd-grid-2">',
        '<div class="spd-field"><label>Heure de début</label><input type="time" class="spd-heure-debut" value="', esc(state.heureDebut), '"></div>',
        '<div class="spd-field"><label>Heure de fin</label><input type="time" class="spd-heure-fin" value="', esc(state.heureFin), '"></div>',
        '</div>']) : '';

      var resultHtml = '';
      if (state.loading) {
        resultHtml = '<div class="spd-loading">Recherche de la prochaine date libre…</div>';
      } else if (state.error) {
        resultHtml = h(['<div class="spd-banner spd-error">', esc(state.error), '</div>']);
      } else if (state.resultat && state.resultat.date) {
        var r = state.resultat;
        var tarif = fmtTarif(r.tarif);
        var reserverHref = tunnelUrl ? construireLienTunnel(tunnelUrl, r) : null;
        resultHtml = h(['<div class="spd-result">',
          '<div class="spd-result-label">Prochaine disponibilité</div>',
          '<div class="spd-result-date">', esc(formatDateFr(r.date)), '</div>',
          tarif ? h(['<div class="spd-result-tarif">', tarif, '</div>']) : '',
          '<div class="spd-actions">',
          reserverHref
            ? h(['<a class="spd-btn spd-primary" href="', esc(reserverHref), '">Réserver cette date</a>'])
            : '<span class="spd-hint">Réservation : voir la page de réservation du site.</span>',
          '<button class="spd-btn spd-ghost spd-btn-autre">Voir une autre date →</button>',
          '</div></div>']);
      } else if (state.resultat) {
        resultHtml = h(['<div class="spd-banner spd-info">', esc(state.resultat.message || 'Aucune disponibilité trouvée pour le moment.'), '</div>']);
      }

      root.innerHTML = h(['<div class="spd-card">',
        '<div class="spd-field"><label>Durée</label><select class="spd-unite">',
        '<option value="journee"', state.unite === 'journee' ? ' selected' : '', '>Journée complète</option>',
        '<option value="demi_journee"', state.unite === 'demi_journee' ? ' selected' : '', '>Demi-journée</option>',
        '<option value="heure"', state.unite === 'heure' ? ' selected' : '', '>Heures précises</option>',
        '</select></div>',
        demiField, heureFields,
        resultHtml,
        '</div>']);

      bind();
    }

    function bind() {
      var uniteSel = root.querySelector('.spd-unite');
      if (uniteSel) uniteSel.onchange = function (e) { state.unite = e.target.value; chercher(); };
      var demiSel = root.querySelector('.spd-demi');
      if (demiSel) demiSel.onchange = function (e) { state.demiPeriode = e.target.value; chercher(); };
      var hd = root.querySelector('.spd-heure-debut');
      if (hd) hd.onchange = function (e) { state.heureDebut = e.target.value; if (state.heureDebut && state.heureFin) chercher(); else render(); };
      var hf = root.querySelector('.spd-heure-fin');
      if (hf) hf.onchange = function (e) { state.heureFin = e.target.value; if (state.heureDebut && state.heureFin) chercher(); else render(); };
      var autre = root.querySelector('.spd-btn-autre');
      if (autre) autre.onclick = function () { chercher(state.resultat && state.resultat.date); };
    }

    // Query string du tunnel préempli (§4, « il bascule vers le tunnel, préempli ») — lu par
    // assets/tunnel.js au chargement (spr_espace/spr_date/spr_unite/spr_creneau/spr_heure_*).
    function construireLienTunnel(base, r) {
      try {
        var url = new URL(base, window.location.href);
        url.searchParams.set('spr_espace', r.espace.code || r.espace.id);
        url.searchParams.set('spr_date', r.date);
        url.searchParams.set('spr_unite', r.unite);
        if (r.creneau) url.searchParams.set('spr_creneau', r.creneau);
        if (r.heure_debut) url.searchParams.set('spr_heure_debut', r.heure_debut);
        if (r.heure_fin) url.searchParams.set('spr_heure_fin', r.heure_fin);
        if (r.espace.capacite) url.searchParams.set('spr_capacite', r.espace.capacite);
        return url.toString();
      } catch (e) {
        return base;
      }
    }

    function chercher(apres) {
      if (!salle) {
        state.loading = false;
        state.error = 'Salle non configurée (attribut "salle" manquant sur le shortcode).';
        render();
        return;
      }
      var estHeure = state.unite === 'heure';
      if (estHeure && (!state.heureDebut || !state.heureFin)) {
        state.loading = false;
        render();
        return;
      }
      state.loading = true;
      state.error = null;
      render();

      var qs = '?espace=' + encodeURIComponent(salle) + '&unite=' + encodeURIComponent(state.unite);
      if (state.unite === 'demi_journee') qs += '&creneau=' + encodeURIComponent(state.demiPeriode);
      if (estHeure) qs += '&heure_debut=' + encodeURIComponent(state.heureDebut) + '&heure_fin=' + encodeURIComponent(state.heureFin);
      if (apres) qs += '&apres=' + encodeURIComponent(apres);

      api('/tunnel/prochaine-disponibilite' + qs).then(function (data) {
        state.loading = false;
        state.resultat = data;
        render();
      }).catch(function (err) {
        state.loading = false;
        state.resultat = null;
        state.error = err.message || 'Recherche indisponible pour le moment.';
        render();
      });
    }

    chercher();
  }

  document.querySelectorAll('.spd-app').forEach(initWidget);
})();
