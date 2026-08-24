<?php
/**
 * Plugin Name: S-PACE Réservation
 * Description: Tunnel de réservation en ligne S-PACE Business Center — shortcode [space_reservation]. Shortcode [space_mon_espace] : espace client complet, sur le site (email → lien → réservations). Shortcode [space_disponibilite] : prochaine date libre d'une salle. Consomme l'API S-RESA (bloc 9 de la spec).
 * Version: 1.5.0
 * Author: S-PACE Business Center
 * Text Domain: space-reservation
 * Update URI: https://github.com/SPACEVIgie/public
 */

if (!defined('ABSPATH')) {
    exit;
}

define('SPACE_RESERVATION_VERSION', '1.5.0');
// Espace client S-RESA HISTORIQUE (portail Vigie, autre domaine) — repli UNIQUEMENT : n'est plus
// utilisé quand SPACE_RESERVATION_OPTION_ESPACE_CLIENT_URL (réglage ci-dessous) est renseigné.
// Conservé pour ne rien casser tant qu'Olivier n'a pas créé la page « Mon espace » du site.
define('SPACE_RESERVATION_ESPACE_CLIENT_URL', 'https://portail.s-pace.fr/sresa/espace-client/');
define('SPACE_RESERVATION_OPTION_API_URL', 'space_reservation_api_url');
define('SPACE_RESERVATION_DEFAULT_API_URL', 'https://portail.s-pace.fr/sresa/api');
// §17.15 — clé d'API par installation. Optionnelle pendant la transition (le serveur accepte un
// appel sans clé mais le journalise). La clé IDENTIFIE l'installation et sert d'accroche au
// rate-limit ; elle n'authentifie pas (un tunnel public l'expose forcément côté navigateur).
define('SPACE_RESERVATION_OPTION_API_KEY', 'space_reservation_api_key');
// (24/08) « Ce qui se passe sur le site reste sur le site » — le lien « Déjà client ? » du tunnel
// (étape 1) et le shortcode [space_mon_espace] doivent rester sur s-pace.fr. Deux réglages :
//   - ESPACE_CLIENT_URL : où mène « Déjà client ? Retrouvez vos réservations » (tunnel, étape 1).
//     Normalement l'URL de la page WordPress qui porte [space_mon_espace]. Vide → repli sur
//     l'espace client Vigie historique (portail.s-pace.fr), comportement identique à avant ce réglage.
//   - MAGIC_RETURN_URL : où le lien reçu par email (depuis [space_mon_espace]) doit ramener le
//     client. Vide → repli sur la page qui contient le shortcode (cas normal, rien à régler) ; à
//     renseigner seulement si cette page n'est pas la bonne URL canonique (proxy, AMP…).
define('SPACE_RESERVATION_OPTION_ESPACE_CLIENT_URL', 'space_reservation_espace_client_url');
define('SPACE_RESERVATION_OPTION_MAGIC_RETURN_URL', 'space_reservation_magic_return_url');

/**
 * Mises à jour automatiques depuis les Releases du dépôt public GitHub SPACEVIgie/public.
 */
require_once __DIR__ . '/includes/github-updater.php';
if (is_admin()) {
    new SPR_GitHub_Updater(__FILE__, 'SPACEVIgie/public', SPACE_RESERVATION_VERSION);
}

/**
 * Réglages : URL de base de l'API S-RESA (le plugin ne stocke aucune donnée client — tout transite
 * directement vers l'API S-RESA côté navigateur), plus les deux URL du parcours espace client
 * (§ « ce qui se passe sur le site reste sur le site », ajout 1.5.0).
 */
function space_reservation_register_settings() {
    register_setting('space_reservation', SPACE_RESERVATION_OPTION_API_URL, [
        'type' => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default' => SPACE_RESERVATION_DEFAULT_API_URL,
    ]);
    register_setting('space_reservation', SPACE_RESERVATION_OPTION_API_KEY, [
        'type' => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default' => '',
    ]);
    register_setting('space_reservation', SPACE_RESERVATION_OPTION_ESPACE_CLIENT_URL, [
        'type' => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default' => '',
    ]);
    register_setting('space_reservation', SPACE_RESERVATION_OPTION_MAGIC_RETURN_URL, [
        'type' => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default' => '',
    ]);
}
add_action('admin_init', 'space_reservation_register_settings');

function space_reservation_add_settings_page() {
    add_options_page(
        'S-PACE Réservation',
        'S-PACE Réservation',
        'manage_options',
        'space-reservation',
        'space_reservation_render_settings_page'
    );
}
add_action('admin_menu', 'space_reservation_add_settings_page');

// Liste des shortcodes du plugin, à UN seul endroit (§ demande Olivier, page de réglages) — un
// shortcode ajouté demain n'a qu'une ligne à ajouter ici pour apparaître dans le tableau.
function space_reservation_liste_shortcodes() {
    return [
        [
            'shortcode' => '[space_reservation]',
            'role' => "Le tunnel de réservation complet (recherche, salle, options, paiement ou devis). À placer sur la page « Réserver » du site.",
        ],
        [
            'shortcode' => '[space_mon_espace]',
            'role' => "L'espace client complet, sur le site : email → lien reçu → liste des réservations → détail → demande d'annulation. À placer sur une page dédiée (ex. « Mon espace »).",
        ],
        [
            'shortcode' => '[space_disponibilite salle="CODE" tunnel="https://…/reserver/"]',
            'role' => "Sur la page d'une salle : le visiteur choisit une durée, la prochaine date libre s'affiche (« Voir une autre date » pour la suivante), avec un lien vers le tunnel préempli.",
        ],
    ];
}

function space_reservation_render_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>S-PACE Réservation</h1>
        <form method="post" action="options.php">
            <?php settings_fields('space_reservation'); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="space_reservation_api_url">URL de l'API S-RESA</label></th>
                    <td>
                        <input type="url" id="space_reservation_api_url" name="<?php echo esc_attr(SPACE_RESERVATION_OPTION_API_URL); ?>"
                               value="<?php echo esc_attr(get_option(SPACE_RESERVATION_OPTION_API_URL, SPACE_RESERVATION_DEFAULT_API_URL)); ?>"
                               class="regular-text" placeholder="https://portail.s-pace.fr/sresa/api">
                        <p class="description">Base de l'API S-RESA (sans slash final). Tous les shortcodes de ce plugin l'utilisent pour leurs requêtes.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="space_reservation_api_key">Clé d'API</label></th>
                    <td>
                        <input type="text" id="space_reservation_api_key" name="<?php echo esc_attr(SPACE_RESERVATION_OPTION_API_KEY); ?>"
                               value="<?php echo esc_attr(get_option(SPACE_RESERVATION_OPTION_API_KEY, '')); ?>"
                               class="regular-text" autocomplete="off" placeholder="fournie par S-PACE">
                        <p class="description">Clé d'API fournie par S-PACE, propre à cette installation. Facultative pour l'instant :
                        laissée vide, les shortcodes continuent de fonctionner. Elle identifie l'installation et protège l'API
                        contre les usages abusifs. À renseigner dès que S-PACE vous l'a communiquée.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="space_reservation_espace_client_url">URL de l'espace client</label></th>
                    <td>
                        <input type="url" id="space_reservation_espace_client_url" name="<?php echo esc_attr(SPACE_RESERVATION_OPTION_ESPACE_CLIENT_URL); ?>"
                               value="<?php echo esc_attr(get_option(SPACE_RESERVATION_OPTION_ESPACE_CLIENT_URL, '')); ?>"
                               class="regular-text" placeholder="https://s-pace.fr/mon-espace/">
                        <p class="description">L'URL de la page qui porte le shortcode <code>[space_mon_espace]</code> — c'est là que mène
                        le lien « Déjà client ? Retrouvez vos réservations » affiché à l'étape 1 du tunnel <code>[space_reservation]</code>.
                        <strong>Si ce champ est vide, ce lien renvoie vers l'espace client S-RESA historique, sur un autre domaine
                        (<code><?php echo esc_html(SPACE_RESERVATION_ESPACE_CLIENT_URL); ?></code>)</strong> — le client quitte alors le site,
                        comportement identique à avant ce réglage. Renseignez-le dès que la page « Mon espace » existe.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="space_reservation_magic_return_url">URL de retour du lien magique</label></th>
                    <td>
                        <input type="url" id="space_reservation_magic_return_url" name="<?php echo esc_attr(SPACE_RESERVATION_OPTION_MAGIC_RETURN_URL); ?>"
                               value="<?php echo esc_attr(get_option(SPACE_RESERVATION_OPTION_MAGIC_RETURN_URL, '')); ?>"
                               class="regular-text" placeholder="https://s-pace.fr/mon-espace/">
                        <p class="description">Où le lien reçu par email (envoyé par <code>[space_mon_espace]</code>) ramène le client
                        après qu'il a cliqué. <strong>Si ce champ est vide, le lien ramène vers la page qui contient le shortcode
                        (cas normal — il n'y a en général rien à régler ici).</strong> Ne renseigner que pour un cas particulier
                        où cette page n'est pas la bonne URL (par ex. le shortcode est servi via une page miroir).</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <h2>Shortcodes disponibles</h2>
        <table class="widefat striped" style="max-width:900px;">
            <thead><tr><th style="width:320px;">Shortcode</th><th>Ce qu'il fait</th></tr></thead>
            <tbody>
                <?php foreach (space_reservation_liste_shortcodes() as $sc) : ?>
                <tr>
                    <td><code><?php echo esc_html($sc['shortcode']); ?></code></td>
                    <td><?php echo esc_html($sc['role']); ?></td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php
}

/**
 * Config commune transmise aux 3 scripts (apiUrl/apiKey) — évite de répéter la même lecture
 * d'options trois fois. pageUrl = URL de la page courante (nettoyée de sa query string), utilisée
 * comme redirection par défaut par le tunnel ET par l'espace client.
 */
function space_reservation_config_commune() {
    return [
        'apiUrl' => untrailingslashit(get_option(SPACE_RESERVATION_OPTION_API_URL, SPACE_RESERVATION_DEFAULT_API_URL)),
        'apiKey' => (string) get_option(SPACE_RESERVATION_OPTION_API_KEY, ''),
        'pageUrl' => untrailingslashit(explode('?', (is_ssl() ? 'https://' : 'http://') . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'])[0]),
    ];
}

/**
 * Enqueue conditionnel : uniquement sur les pages/articles qui contiennent réellement le
 * shortcode, pour ne pas alourdir le reste du site.
 */
function space_reservation_enqueue_assets() {
    if (!is_singular()) {
        return;
    }
    global $post;
    if (!$post || !has_shortcode($post->post_content, 'space_reservation')) {
        return;
    }

    wp_enqueue_style(
        'space-reservation',
        plugins_url('assets/tunnel.css', __FILE__),
        [],
        SPACE_RESERVATION_VERSION
    );
    wp_enqueue_script(
        'space-reservation',
        plugins_url('assets/tunnel.js', __FILE__),
        [],
        SPACE_RESERVATION_VERSION,
        true
    );
    $cfg = space_reservation_config_commune();
    // (1.5.0) espaceClientUrl : où mène « Déjà client ? » — cf. réglage ci-dessus. Vide → tunnel.js
    // retombe sur SPACE_RESERVATION_ESPACE_CLIENT_URL (espace client historique).
    $espaceClientUrl = trim((string) get_option(SPACE_RESERVATION_OPTION_ESPACE_CLIENT_URL, ''));
    $cfg['espaceClientUrl'] = $espaceClientUrl !== '' ? $espaceClientUrl : SPACE_RESERVATION_ESPACE_CLIENT_URL;
    wp_localize_script('space-reservation', 'SpaceReservationConfig', $cfg);
}
add_action('wp_enqueue_scripts', 'space_reservation_enqueue_assets');

/**
 * Shortcode [space_reservation] — un simple point d'ancrage, toute la logique vit dans
 * assets/tunnel.js (aucun rendu PHP du contenu du tunnel, pour rester indépendant du thème).
 */
function space_reservation_shortcode() {
    return '<div id="space-reservation-app" class="spr-app"><div class="spr-loading">Chargement du calendrier de réservation…</div></div>';
}
add_shortcode('space_reservation', 'space_reservation_shortcode');

/**
 * Shortcode [space_mon_espace] (1.5.0 — réécrit) — l'espace client COMPLET, sur le site : formulaire
 * email → lien reçu (ramène ICI, cf. réglage MAGIC_RETURN_URL) → liste des réservations → détail →
 * demande d'annulation. Toute la logique vit dans assets/mon-espace.js, qui appelle directement
 * l'API S-RESA (routes/espaceClient.js : demander-lien, moi, reservations, reservations/:id,
 * reservations/:id/annuler) — les MÊMES routes que l'ancien espace client Vigie, aucune dupliquée.
 *
 * (avant 1.5.0, historique) la version 1.4.0 n'affichait qu'une carte pointant vers l'espace client
 * S-RESA (portail.s-pace.fr, autre domaine) : le client quittait le site pour retrouver ses résas.
 * Le cookie space_client de cet espace est host-only et ne traverse pas jusqu'ici — impossible d'y
 * « téléporter » son contenu. Le mécanisme retenu est celui, déjà cross-domaine, du tunnel : lien
 * magique par email (POST /client/demander-lien, redirect_url = cette page), token lu en ?space_token=
 * (même paramètre que le tunnel), résolu par resoudreCompte() côté serveur (middleware/clientAuth.js).
 */
function space_mon_espace_enqueue_assets() {
    if (!is_singular()) {
        return;
    }
    global $post;
    if (!$post || !has_shortcode($post->post_content, 'space_mon_espace')) {
        return;
    }
    wp_enqueue_style(
        'space-mon-espace',
        plugins_url('assets/mon-espace.css', __FILE__),
        [],
        SPACE_RESERVATION_VERSION
    );
    wp_enqueue_script(
        'space-mon-espace',
        plugins_url('assets/mon-espace.js', __FILE__),
        [],
        SPACE_RESERVATION_VERSION,
        true
    );
    $cfg = space_reservation_config_commune();
    // (1.5.0) magicReturnUrl : redirect_url envoyé à /client/demander-lien. Vide côté réglage →
    // mon-espace.js retombe sur cfg.pageUrl (la page courante, cas normal).
    $magicReturnUrl = trim((string) get_option(SPACE_RESERVATION_OPTION_MAGIC_RETURN_URL, ''));
    $cfg['magicReturnUrl'] = $magicReturnUrl !== '' ? $magicReturnUrl : '';
    wp_localize_script('space-mon-espace', 'SpaceMonEspaceConfig', $cfg);
}
add_action('wp_enqueue_scripts', 'space_mon_espace_enqueue_assets');

function space_mon_espace_shortcode() {
    return '<div id="space-mon-espace-app" class="spme-app"><div class="spme-loading">Chargement…</div></div>';
}
add_shortcode('space_mon_espace', 'space_mon_espace_shortcode');

/**
 * Shortcode [space_disponibilite salle="CODE" tunnel="https://…"] (1.5.0) — sur la page d'une
 * salle : le visiteur choisit une durée (mêmes 3 unités que le tunnel — journée / demi-journée /
 * heures précises, aucune inventée), la prochaine date libre s'affiche (GET
 * /tunnel/prochaine-disponibilite, cf. sresa-api), avec la possibilité d'en voir une autre. Le
 * bouton « Réserver cette date » bascule vers le tunnel, préempli (query string spr_*, lus par
 * assets/tunnel.js). `salle` = code de l'espace (ex. « PE03 », visible dans Réglages S-RESA côté
 * équipe) — pas le nom affiché, qui peut changer. `tunnel` = URL de la page qui porte
 * [space_reservation] ; sans cet attribut, la prochaine dispo s'affiche quand même mais sans
 * bouton « Réserver » (le shortcode ne DEVINE pas où se trouve le tunnel).
 */
function space_disponibilite_enqueue_assets() {
    if (!is_singular()) {
        return;
    }
    global $post;
    if (!$post || !has_shortcode($post->post_content, 'space_disponibilite')) {
        return;
    }
    wp_enqueue_style(
        'space-disponibilite',
        plugins_url('assets/disponibilite.css', __FILE__),
        [],
        SPACE_RESERVATION_VERSION
    );
    wp_enqueue_script(
        'space-disponibilite',
        plugins_url('assets/disponibilite.js', __FILE__),
        [],
        SPACE_RESERVATION_VERSION,
        true
    );
    wp_localize_script('space-disponibilite', 'SpaceDispoConfig', space_reservation_config_commune());
}
add_action('wp_enqueue_scripts', 'space_disponibilite_enqueue_assets');

function space_disponibilite_shortcode($atts) {
    $atts = shortcode_atts(['salle' => '', 'tunnel' => ''], $atts, 'space_disponibilite');
    if (trim($atts['salle']) === '') {
        // Erreur visible SEULEMENT à l'édition (pas de salle = shortcode mal posé) — jamais un
        // widget silencieusement vide en production sans que personne ne comprenne pourquoi.
        // PAS de classe .spd-app ici : ce bloc ne doit jamais être ramassé par disponibilite.js
        // (qui initialise CHAQUE .spd-app — il n'y a ici ni salle ni requête à faire).
        return '<div class="spd-erreur-config">[space_disponibilite] : l\'attribut <code>salle</code> est obligatoire (ex. <code>[space_disponibilite salle="PE03"]</code>).</div>';
    }
    $salle = esc_attr($atts['salle']);
    $tunnel = esc_url($atts['tunnel']);
    // class (pas id) : le shortcode peut apparaître plusieurs fois sur une même page (plusieurs
    // salles) — assets/disponibilite.js initialise CHAQUE occurrence indépendamment.
    return '<div class="spd-app" data-salle="' . $salle . '" data-tunnel="' . $tunnel . '">'
        . '<div class="spd-loading">Chargement…</div></div>';
}
add_shortcode('space_disponibilite', 'space_disponibilite_shortcode');
