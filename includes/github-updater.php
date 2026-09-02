<?php
/**
 * Mise à jour automatique du plugin depuis les Releases GitHub (dépôt public).
 * Autonome (aucune dépendance externe) : interroge l'API publique GitHub, compare la
 * version installée à la dernière release, et fournit le paquet à WordPress.
 *
 * Pour publier une mise à jour : créer une Release GitHub dont le tag = la nouvelle version
 * (ex. « v1.0.1 »), après avoir bumpé « Version: » dans s-pace-reservation.php et
 * « Stable tag » dans readme.txt. WordPress proposera alors la mise à jour.
 */

if (!defined('ABSPATH')) {
    exit;
}

class SPR_GitHub_Updater {

    private $file;
    private $basename;   // s-pace-reservation/s-pace-reservation.php
    private $slug;       // s-pace-reservation
    private $repo;       // SPACEVIgie/s-pace-reservation
    private $version;
    private $cache_key;

    public function __construct($file, $repo, $version) {
        $this->file      = $file;
        $this->basename  = plugin_basename($file);
        $this->slug      = dirname($this->basename);
        $this->repo      = $repo;
        $this->version   = $version;
        $this->cache_key = 'spr_gh_update_' . md5($repo);

        add_filter('pre_set_site_transient_update_plugins', array($this, 'check_update'));
        add_filter('plugins_api', array($this, 'plugin_info'), 20, 3);
        add_filter('upgrader_source_selection', array($this, 'fix_source_folder'), 10, 4);
        add_action('upgrader_process_complete', array($this, 'flush_cache'), 10, 0);
    }

    /** Appel JSON à l'API GitHub publique (retourne l'objet décodé, ou null). */
    private function api_get($path) {
        $response = wp_remote_get(
            'https://api.github.com/repos/' . $this->repo . $path,
            array(
                'timeout' => 10,
                'headers' => array(
                    'Accept'     => 'application/vnd.github+json',
                    'User-Agent' => 'WordPress-S-PACE-Reservation',
                ),
            )
        );
        if (is_wp_error($response) || (int) wp_remote_retrieve_response_code($response) !== 200) {
            return null;
        }
        return json_decode(wp_remote_retrieve_body($response));
    }

    /**
     * Dernière version publiée (cachée 6 h ; erreurs cachées 1 h).
     * 1) Release GitHub « latest » si elle existe (avec changelog) ;
     * 2) sinon, dernier tag sémantique (permet de publier une màj par simple push d'un tag).
     */
    private function get_latest_release() {
        $cached = get_transient($this->cache_key);
        if ($cached !== false) {
            return $cached ?: null;
        }
        // 1) Release "latest"
        $release = $this->api_get('/releases/latest');
        if ($release && !empty($release->tag_name)) {
            set_transient($this->cache_key, $release, 6 * HOUR_IN_SECONDS);
            return $release;
        }
        // 2) Repli sur le tag sémantique le plus élevé
        $tags = $this->api_get('/tags');
        if (is_array($tags)) {
            $best = null;
            foreach ($tags as $tag) {
                if (empty($tag->name) || !preg_match('/^v?\d+\.\d+/', $tag->name)) {
                    continue;
                }
                if ($best === null || version_compare(ltrim($tag->name, 'vV'), ltrim($best->name, 'vV'), '>')) {
                    $best = $tag;
                }
            }
            if ($best) {
                $synth = (object) array(
                    'tag_name'    => $best->name,
                    'zipball_url' => 'https://github.com/' . $this->repo . '/archive/refs/tags/' . rawurlencode($best->name) . '.zip',
                    'assets'      => array(),
                    'body'        => '',
                );
                set_transient($this->cache_key, $synth, 6 * HOUR_IN_SECONDS);
                return $synth;
            }
        }
        set_transient($this->cache_key, '', HOUR_IN_SECONDS);
        return null;
    }

    private function release_version($release) {
        return ltrim($release->tag_name, 'vV');
    }

    /** Un asset .zip attaché est préféré (structure propre) ; sinon le zipball auto. */
    private function package_url($release) {
        if (!empty($release->assets)) {
            foreach ($release->assets as $asset) {
                if (isset($asset->name) && substr($asset->name, -4) === '.zip') {
                    return $asset->browser_download_url;
                }
            }
        }
        return isset($release->zipball_url) ? $release->zipball_url : '';
    }

    public function check_update($transient) {
        if (empty($transient->checked)) {
            return $transient;
        }
        $release = $this->get_latest_release();
        if (!$release) {
            return $transient;
        }
        $remote = $this->release_version($release);
        if (version_compare($remote, $this->version, '>')) {
            $transient->response[$this->basename] = (object) array(
                'slug'        => $this->slug,
                'plugin'      => $this->basename,
                'new_version' => $remote,
                'url'         => 'https://github.com/' . $this->repo,
                'package'     => $this->package_url($release),
            );
        } else {
            unset($transient->response[$this->basename]);
            $transient->no_update[$this->basename] = (object) array(
                'slug'        => $this->slug,
                'plugin'      => $this->basename,
                'new_version' => $this->version,
                'url'         => 'https://github.com/' . $this->repo,
                'package'     => '',
            );
        }
        return $transient;
    }

    /**
     * Isole une section « == Titre == » du readme.txt embarqué (format WordPress standard),
     * jusqu'au prochain titre de section ou la fin du fichier. Retourne '' si le readme est
     * absent/illisible ou si la section n'existe pas — jamais de contenu inventé ici.
     */
    private function read_readme_section($heading) {
        $path = plugin_dir_path($this->file) . 'readme.txt';
        if (!is_readable($path)) {
            return '';
        }
        $content = file_get_contents($path);
        if ($content === false) {
            return '';
        }
        $pattern = '/^==\s*' . preg_quote($heading, '/') . '\s*==\s*$(.*?)(?=^==\s.+?\s==\s*$|\z)/ims';
        if (!preg_match($pattern, $content, $m)) {
            return '';
        }
        return trim($m[1]);
    }

    /**
     * Convertit le texte brut d'une section de readme.txt en HTML minimal pour la modale
     * « Voir les détails » : `= Titre =` -> <h4>, lignes `* ...` -> <ul><li> (avec leurs
     * lignes de continuation indentées repliées dans le même item), le reste -> <p>.
     * Tout le texte passe par esc_html — aucune balise du readme n'est interprétée telle quelle.
     */
    private function readme_to_html($raw) {
        if ($raw === '') {
            return '';
        }
        $html    = '';
        $in_list = false;
        $item    = '';
        $lines   = preg_split('/\r\n|\r|\n/', $raw);

        foreach ($lines as $line) {
            $trimmed = trim($line);

            if ($trimmed === '') {
                if ($item !== '') {
                    $html .= '<li>' . esc_html($item) . '</li>';
                    $item  = '';
                }
                if ($in_list) {
                    $html   .= '</ul>';
                    $in_list = false;
                }
                continue;
            }

            if (preg_match('/^=\s*(.+?)\s*=$/', $trimmed, $m)) {
                if ($item !== '') {
                    $html .= '<li>' . esc_html($item) . '</li>';
                    $item  = '';
                }
                if ($in_list) {
                    $html   .= '</ul>';
                    $in_list = false;
                }
                $html .= '<h4>' . esc_html($m[1]) . '</h4>';
                continue;
            }

            if (preg_match('/^\*\s+(.*)$/', $trimmed, $m)) {
                if ($item !== '') {
                    $html .= '<li>' . esc_html($item) . '</li>';
                }
                if (!$in_list) {
                    $html   .= '<ul>';
                    $in_list = true;
                }
                $item = $m[1];
                continue;
            }

            // Ligne de continuation (readme.txt indente les lignes qui prolongent un item).
            if ($in_list) {
                $item .= ' ' . $trimmed;
            } else {
                $html .= '<p>' . esc_html($trimmed) . '</p>';
            }
        }
        if ($item !== '') {
            $html .= '<li>' . esc_html($item) . '</li>';
        }
        if ($in_list) {
            $html .= '</ul>';
        }
        return $html;
    }

    /** Fiche « Voir les détails » de la liste des plugins. */
    public function plugin_info($result, $action, $args) {
        if ($action !== 'plugin_information' || empty($args->slug) || $args->slug !== $this->slug) {
            return $result;
        }
        $release = $this->get_latest_release();
        if (!$release) {
            return $result;
        }
        return (object) array(
            'name'          => 'S-PACE Réservation',
            'slug'          => $this->slug,
            'version'       => $this->release_version($release),
            'author'        => '<a href="https://github.com/' . esc_attr($this->repo) . '">S-PACE Business Center</a>',
            'homepage'      => 'https://github.com/' . $this->repo,
            'download_link' => $this->package_url($release),
            'sections'      => array(
                // readme.txt (embarqué dans le ZIP) reste l'unique source : rien n'est
                // dupliqué ici. Si une section est absente/illisible, l'onglet reste vide
                // plutôt que d'afficher un texte inventé dans le PHP.
                'description' => $this->readme_to_html($this->read_readme_section('Description')),
                'changelog'   => $this->readme_to_html($this->read_readme_section('Changelog')),
            ),
        );
    }

    /**
     * Le zipball GitHub s'extrait dans un dossier « OWNER-repo-<sha> » : on le renomme
     * vers le slug attendu (« s-pace-reservation ») pour que WordPress remplace le plugin.
     */
    public function fix_source_folder($source, $remote_source, $upgrader, $hook_extra = null) {
        if (empty($hook_extra['plugin']) || $hook_extra['plugin'] !== $this->basename) {
            return $source;
        }
        global $wp_filesystem;
        if (!$wp_filesystem) {
            return $source;
        }
        $desired = trailingslashit($remote_source) . $this->slug;
        if (untrailingslashit($source) === $desired) {
            return $source;
        }
        if ($wp_filesystem->move(untrailingslashit($source), $desired, true)) {
            return trailingslashit($desired);
        }
        return $source;
    }

    public function flush_cache() {
        delete_transient($this->cache_key);
    }
}
