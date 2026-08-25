(function () {
  'use strict';

  // [space_disponibilite] (1.5.0 ; 25/08 : durées filtrées par salle, bouton Réserver actif via le
  // réglage global, calendrier, HT+TTC — §4 « trois défauts ») — « quand puis-je venir dans cette
  // salle ? ». Un widget PAR OCCURRENCE (une page peut lister plusieurs salles) : chaque .spd-app se
  // comporte de façon indépendante, rien de partagé.

  var cfg = window.SpaceDispoConfig || {};
  var API_URL = (cfg.apiUrl || 'https://portail.s-pace.fr/sresa/api').replace(/\/$/, '');
  var API_KEY = cfg.apiKey || '';
  var RESERVATION_URL_GLOBALE = cfg.reservationUrl || '';

  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var JOURS_SEM = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  var LIBELLES_UNITE = { journee: 'Journée complète', demi_journee: 'Demi-journée', heure: 'Heures précises' };
  var TOUTES_UNITES = ['journee', 'demi_journee', 'heure'];

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-Space-Api-Key'] = API_KEY;
    return fetch(API_URL + path, Object.assign({ headers: headers, cache: 'no-store' }, opts))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'Erreur serveur');
            err.payload = data; // §31ter — un 422 « durée non autorisée » porte unites_autorisees
            throw err;
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

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatDateFr(iso) {
    var d = new Date(iso + 'T00:00:00');
    return d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear();
  }

  // Un jour ISO ('YYYY-MM-DD') moins n jours, en arithmétique UTC pure (même méthode que
  // isoPlusJoursUTC côté serveur, routes/tunnel.js — jamais toISOString() sur une date locale,
  // CONVENTIONS.md § piège UTC+2). Sert uniquement à retrouver, via /prochaine-disponibilite, le
  // détail complet (tarif, bornes horaires) d'une date déjà annoncée LIBRE par le calendrier — sans
  // recalculer nous-mêmes une disponibilité déjà établie côté serveur (§4, « réutiliser le prédicat »).
  function isoMoinsJoursUTC(dateIso, n) {
    var p = dateIso.split('-').map(Number);
    var t = Date.UTC(p[0], p[1] - 1, p[2]) - n * 86400000;
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function moisDecale(mois, delta) {
    var y = Number(mois.slice(0, 4));
    var m = Number(mois.slice(5, 7)) + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return y + '-' + pad2(m);
  }

  // HT « en gros » + TTC en information (§4) — hiérarchie reprise des fiches salle du site public
  // (s-pace.fr), qui affichent le prix HT en avant sur leurs propres cartes tarifaires ; à confirmer
  // avec Olivier si une autre page du site fait dominer le TTC ailleurs (non trouvée à l'audit du
  // 25/08). Le TTC reste néanmoins toujours visible — jamais masqué.
  function tarifHtml(tarif) {
    if (!tarif || tarif.erreur || tarif.tarif_ttc == null) return '';
    var ttc = Number(tarif.tarif_ttc).toFixed(2) + ' € TTC';
    var ht = tarif.tarif_ht_net != null ? Number(tarif.tarif_ht_net).toFixed(2) + ' € HT' : null;
    return h(['<div class="spd-result-tarif">',
      ht ? h(['<span class="spd-tarif-ht">', ht, '</span>']) : '',
      '<span class="spd-tarif-ttc">', ttc, '</span>',
      '</div>']);
  }

  function initWidget(root) {
    var salle = root.getAttribute('data-salle') || '';
    // §4.2 — attribut du shortcode d'abord (une page peut viser une autre destination que le
    // réglage global), repli sur « URL de la page de réservation » (réglage du plugin, posé en
    // v1.6.0) : jusqu'ici ce réglage existait mais n'était PAS lu par ce shortcode — sans l'attribut
    // `tunnel`, le bouton « Réserver » ne s'affichait donc jamais, quand bien même la page de
    // réservation était connue. Si NI l'un NI l'autre n'est renseigné, pas de destination devinée
        // (§4.2, « jamais un bouton mort ») — l'indication texte de repli reste affichée.
    var tunnelUrl = root.getAttribute('data-tunnel') || RESERVATION_URL_GLOBALE || '';

    var state = {
      unite: 'journee', demiPeriode: 'matin', heureDebut: '', heureFin: '',
      loading: true, error: null, resultat: null,
      unitesAutorisees: null, // connu dès la 1ère réponse serveur (§4.1) — tant que null, on ne sait
      // pas encore ce que la salle accepte : le sélecteur affiche provisoirement les 3 durées.
      corrige: false, // garde anti-boucle du repli 422 (cf. chercher())
      vue: 'resultat', // 'resultat' | 'calendrier'
      calMois: null, calMoisMin: null, calLoading: false, calError: null, calCache: {},
    };

    // §4.1 — Durées proposées : UNIQUEMENT celles que la salle accepte (espaces.unites_autorisees,
    // lu côté serveur — jamais deviné ici). Une seule durée acceptée → l'ANNONCER (pas un sélecteur
    // à un choix, §4.1 dernier paragraphe).
    function champDuree() {
      var options = state.unitesAutorisees || TOUTES_UNITES;
      if (options.length <= 1) {
        var seule = options[0] || 'journee';
        return h(['<div class="spd-field"><label>Durée</label><div class="spd-duree-unique">',
          esc(LIBELLES_UNITE[seule] || seule), '</div></div>']);
      }
      return h(['<div class="spd-field"><label>Durée</label><select class="spd-unite">',
        options.map(function (u) {
          return '<option value="' + u + '"' + (state.unite === u ? ' selected' : '') + '>' + esc(LIBELLES_UNITE[u] || u) + '</option>';
        }).join(''),
        '</select></div>']);
    }

    function render() {
      if (state.vue === 'calendrier') {
        root.innerHTML = h(['<div class="spd-card">', renderCalendrier(), '</div>']);
        bindCalendrier();
        return;
      }

      var options = state.unitesAutorisees || TOUTES_UNITES;
      var demiField = (state.unite === 'demi_journee' && options.indexOf('demi_journee') !== -1)
        ? h(['<div class="spd-field"><label>Période</label><select class="spd-demi">',
          '<option value="matin"', state.demiPeriode === 'matin' ? ' selected' : '', '>Matin</option>',
          '<option value="apres_midi"', state.demiPeriode === 'apres_midi' ? ' selected' : '', '>Après-midi</option>',
          '</select></div>']) : '';
      var heureFields = (state.unite === 'heure' && options.indexOf('heure') !== -1)
        ? h(['<div class="spd-grid-2">',
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
        var reserverHref = tunnelUrl ? construireLienTunnel(tunnelUrl, r) : null;
        resultHtml = h(['<div class="spd-result">',
          '<div class="spd-result-label">Prochaine disponibilité</div>',
          '<div class="spd-result-date">', esc(formatDateFr(r.date)), '</div>',
          tarifHtml(r.tarif),
          '<div class="spd-actions">',
          reserverHref
            ? h(['<a class="spd-btn spd-primary" href="', esc(reserverHref), '">Réserver cette date</a>'])
            : '<span class="spd-hint">Réservation : voir la page de réservation du site.</span>',
          '<button type="button" class="spd-btn spd-ghost spd-btn-autre">Voir un calendrier →</button>',
          '</div></div>']);
      } else if (state.resultat) {
        resultHtml = h(['<div class="spd-banner spd-info">', esc(state.resultat.message || 'Aucune disponibilité trouvée pour le moment.'), '</div>',
          '<div class="spd-actions"><button type="button" class="spd-btn spd-ghost spd-btn-autre">Voir un calendrier →</button></div>']);
      }

      root.innerHTML = h(['<div class="spd-card">', champDuree(), demiField, heureFields, resultHtml, '</div>']);
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
      if (autre) autre.onclick = function () { ouvrirCalendrier(); };
    }

    // Query string du tunnel préempli (§4.2, « il bascule vers le tunnel, préempli ») — lu par
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
      // Défensif : ne jamais interroger une durée déjà connue comme refusée par la salle (peut
      // arriver après un premier repli 422, cf. plus bas).
      var options = state.unitesAutorisees || TOUTES_UNITES;
      if (options.indexOf(state.unite) === -1) state.unite = options[0] || 'journee';

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
        if (data.espace && data.espace.unites_autorisees) state.unitesAutorisees = data.espace.unites_autorisees;
        state.resultat = data;
        render();
      }).catch(function (err) {
        // §31ter — 422 « cette salle ne propose pas cette durée » : ne devrait plus se produire via
        // l'UI normale (le sélecteur est déjà filtré dès la 1ère réponse), mais reste possible sur le
        // tout premier appel (avant que unitesAutorisees soit connu, défaut 'journee' toujours valide
        // aujourd'hui — mais pas garanti pour une salle future). Repli SILENCIEUX sur la première
        // durée réellement acceptée plutôt que de montrer une erreur technique au visiteur.
        if (err.payload && err.payload.unites_autorisees && !state.corrige) {
          state.corrige = true;
          state.unitesAutorisees = err.payload.unites_autorisees;
          state.unite = state.unitesAutorisees[0] || 'journee';
          chercher(apres);
          return;
        }
        state.loading = false;
        state.resultat = null;
        state.error = err.message || 'Recherche indisponible pour le moment.';
        render();
      });
    }

    // §4.3 — « Voir une autre date » ouvre désormais un calendrier (choix), plus un défilement
    // jour par jour.
    function ouvrirCalendrier() {
      state.vue = 'calendrier';
      var base = (state.resultat && state.resultat.date) ? state.resultat.date : todayIsoApprox();
      state.calMoisMin = todayIsoApprox().slice(0, 7);
      state.calMois = base.slice(0, 7);
      render();
      chargerMois(state.calMois);
    }

    // Horloge CLIENT, uniquement pour borner la navigation du calendrier (désactiver "précédent"
    // avant le mois courant) — jamais utilisée pour calculer une disponibilité : le serveur
    // (CURRENT_DATE Postgres) reste seul juge de ce qui est passé ou non (cf. /disponibilite-mois).
    function todayIsoApprox() {
      var d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function chargerMois(mois) {
      if (state.calCache[mois]) { render(); return; }
      state.calLoading = true;
      state.calError = null;
      render();
      var qs = '?espace=' + encodeURIComponent(salle) + '&unite=' + encodeURIComponent(state.unite) + '&mois=' + encodeURIComponent(mois);
      if (state.unite === 'demi_journee') qs += '&creneau=' + encodeURIComponent(state.demiPeriode);
      if (state.unite === 'heure') qs += '&heure_debut=' + encodeURIComponent(state.heureDebut) + '&heure_fin=' + encodeURIComponent(state.heureFin);
      api('/tunnel/disponibilite-mois' + qs).then(function (data) {
        state.calLoading = false;
        state.calCache[mois] = data.jours;
        render();
      }).catch(function (err) {
        state.calLoading = false;
        state.calError = err.message || 'Calendrier indisponible pour le moment.';
        render();
      });
    }

    function renderCalendrier() {
      var jours = state.calCache[state.calMois];
      var corps;
      if (state.calLoading && !jours) {
        corps = '<div class="spd-loading">Chargement du calendrier…</div>';
      } else if (state.calError) {
        corps = h(['<div class="spd-banner spd-error">', esc(state.calError), '</div>']);
      } else if (jours) {
        corps = renderGrille(jours);
      } else {
        corps = '';
      }
      var y = state.calMois.slice(0, 4);
      var m = Number(state.calMois.slice(5, 7));
      var titreMois = MOIS[m - 1] + ' ' + y;
      var precDesactive = state.calMois <= state.calMoisMin;

      return h(['<div class="spd-cal">',
        '<button type="button" class="spd-cal-retour">← Retour</button>',
        '<div class="spd-cal-sous-titre">', esc(LIBELLES_UNITE[state.unite] || state.unite), '</div>',
        '<div class="spd-cal-mois-nav">',
        '<button type="button" class="spd-cal-nav spd-cal-prec"', precDesactive ? ' disabled' : '', ' aria-label="Mois précédent">‹</button>',
        '<span class="spd-cal-titre">', esc(titreMois), '</span>',
        '<button type="button" class="spd-cal-nav spd-cal-suiv" aria-label="Mois suivant">›</button>',
        '</div>',
        corps,
        '<div class="spd-cal-legende"><span class="spd-cal-puce spd-cal-puce-dispo"></span>disponible',
        '<span class="spd-cal-puce spd-cal-puce-indispo"></span>indisponible</div>',
        '</div>']);
    }

    function renderGrille(jours) {
      if (!jours.length) return '';
      var premier = jours[0].date;
      var y = Number(premier.slice(0, 4));
      var m = Number(premier.slice(5, 7));
      var offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // 0 = lundi
      var cells = [];
      for (var i = 0; i < offset; i++) cells.push('<span class="spd-cal-cell spd-cal-vide"></span>');
      jours.forEach(function (j) {
        var num = Number(j.date.slice(8, 10));
        if (j.disponible) {
          cells.push(h(['<button type="button" class="spd-cal-cell spd-cal-dispo" data-date="', j.date, '">', num, '</button>']));
        } else {
          cells.push(h(['<span class="spd-cal-cell spd-cal-indispo">', num, '</span>']));
        }
      });
      return h(['<div class="spd-cal-entetesem">', JOURS_SEM.map(function (j) { return '<span>' + j + '</span>'; }).join(''), '</div>',
        '<div class="spd-cal-grille">', cells.join(''), '</div>']);
    }

    function bindCalendrier() {
      var retour = root.querySelector('.spd-cal-retour');
      if (retour) retour.onclick = function () { state.vue = 'resultat'; render(); };
      var prec = root.querySelector('.spd-cal-prec');
      if (prec) prec.onclick = function () { if (prec.disabled) return; state.calMois = moisDecale(state.calMois, -1); render(); chargerMois(state.calMois); };
      var suiv = root.querySelector('.spd-cal-suiv');
      if (suiv) suiv.onclick = function () { state.calMois = moisDecale(state.calMois, 1); render(); chargerMois(state.calMois); };
      root.querySelectorAll('.spd-cal-dispo').forEach(function (btn) {
        btn.onclick = function () {
          var dateIso = btn.getAttribute('data-date');
          state.vue = 'resultat';
          // Ré-appelle /prochaine-disponibilite juste avant la date choisie : elle est déjà connue
          // libre (le calendrier vient de le dire), on RETROUVE son détail complet (tarif, bornes)
          // via le MÊME endpoint plutôt que d'improviser un second calcul côté widget (§4.3).
          chercher(isoMoinsJoursUTC(dateIso, 1));
        };
      });
    }

    chercher();
  }

  document.querySelectorAll('.spd-app').forEach(initWidget);
})();
