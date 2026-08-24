<?php
/**
 * Plugin Name: S-PACE Réservation
 * Description: Tunnel de réservation en ligne S-PACE Business Center — shortcode [space_reservation]. Shortcode [space_mon_espace] : accès à l'espace client (lien magique par email). Consomme l'API S-RESA (bloc 9 de la spec).
 * Version: 1.4.0
 * Author: S-PACE Business Center
 * Text Domain: space-reservation
 * Update URI: https://github.com/SPACEVIgie/public
 */

if (!defined('ABSPATH')) {
    exit;
}

define('SPACE_RESERVATION_VERSION', '1.4.0');
// Espace client S-RESA existant (formulaire email → lien magique). Même URL que le lien
// « Déjà client ? » de l'étape 1 du tunnel (assets/tunnel.js).
define('SPACE_RESERVATION_ESPACE_CLIENT_URL', 'https://portail.s-pace.fr/sresa/espace-client/');
define('SPACE_RESERVATION_OPTION_API_URL', 'space_reservation_api_url');
define('SPACE_RESERVATION_DEFAULT_API_URL', 'https://portail.s-pace.fr/sresa/api');
// §17.15 — clé d'API par installation. Optionnelle pendant la transition (le serveur accepte un
// appel sans clé mais le journalise). La clé IDENTIFIE l'installation et sert d'accroche au
// rate-limit ; elle n'authentifie pas (un tunnel public l'expose forcément côté navigateur).
define('SPACE_RESERVATION_OPTION_API_KEY', 'space_reservation_api_key');

/**
 * Mises à jour automatiques depuis les Releases du dépôt public GitHub SPACEVIgie/public.
 */
require_once __DIR__ . '/includes/github-updater.php';
if (is_admin()) {
    new SPR_GitHub_Updater(__FILE__, 'SPACEVIgie/public', SPACE_RESERVATION_VERSION);
}

/**
 * Réglages : URL de base de l'API S-RESA, seul paramètre nécessaire (le plugin ne stocke
 * aucune donnée client — tout transite directement vers l'API S-RESA côté navigateur).
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
                        <p class="description">Base de l'API S-RESA (sans slash final). Le shortcode <code>[space_reservation]</code> l'utilise pour toutes ses requêtes.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="space_reservation_api_key">Clé d'API</label></th>
                    <td>
                        <input type="text" id="space_reservation_api_key" name="<?php echo esc_attr(SPACE_RESERVATION_OPTION_API_KEY); ?>"
                               value="<?php echo esc_attr(get_option(SPACE_RESERVATION_OPTION_API_KEY, '')); ?>"
                               class="regular-text" autocomplete="off" placeholder="fournie par S-PACE">
                        <p class="description">Clé d'API fournie par S-PACE, propre à cette installation. Facultative pour l'instant :
                        laissée vide, le tunnel continue de fonctionner. Elle identifie l'installation et protège l'API
                        contre les usages abusifs. À renseigner dès que S-PACE vous l'a communiquée.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
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
    wp_localize_script('space-reservation', 'SpaceReservationConfig', [
        'apiUrl' => untrailingslashit(get_option(SPACE_RESERVATION_OPTION_API_URL, SPACE_RESERVATION_DEFAULT_API_URL)),
        'apiKey' => (string) get_option(SPACE_RESERVATION_OPTION_API_KEY, ''),
        'pageUrl' => untrailingslashit(explode('?', (is_ssl() ? 'https://' : 'http://') . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'])[0]),
    ]);
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
 * Shortcode [space_mon_espace] (1.4.0) — carte d'accès à l'espace client S-RESA, visible
 * hors de toute intention de réserver (page dédiée « Mon espace », menu du site). Un simple
 * lien vers la page espace-client existante (formulaire email → lien magique, déjà en place
 * et testée) — pas de logique dupliquée ici. Même mécanisme que le lien « Déjà client ? » de
 * l'étape 1 du tunnel [space_reservation].
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
}
add_action('wp_enqueue_scripts', 'space_mon_espace_enqueue_assets');

function space_mon_espace_shortcode() {
    $url = esc_url(SPACE_RESERVATION_ESPACE_CLIENT_URL);
    return '<div class="spme-card">'
        . '<div class="spme-title">Mon espace S-PACE</div>'
        . '<p class="spme-text">Retrouvez vos réservations, leur statut et vos demandes d\'annulation. '
        . 'Indiquez votre email, vous recevez un lien de connexion valable 2 heures — aucun mot de passe.</p>'
        . '<a class="spme-btn" href="' . $url . '" target="_blank" rel="noopener">Accéder à mon espace</a>'
        . '</div>';
}
add_shortcode('space_mon_espace', 'space_mon_espace_shortcode');
