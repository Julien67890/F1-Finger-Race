// Service worker "F1 Finger Race".
//
// Pourquoi ce fichier : sur Android/Chrome, une page qu'on "ajoute à l'écran d'accueil" ne
// devient une vraie appli installée (icône qui s'ouvre en plein écran, sans barre d'adresse ni
// interface du navigateur — comme le fait déjà l'app Carte de Score de Julien) que si elle a,
// en plus d'un manifest.json valide, un service worker enregistré. Sans ça, Chrome ne propose
// qu'un simple raccourci qui rouvre un onglet de navigateur tout ce qu'il y a de plus normal,
// quelle que soit la valeur "display" du manifest. C'était la pièce manquante ici.
//
// Ce service worker se limite à mettre en cache la coquille de l'appli (le HTML, le manifest,
// les icônes, les polices) pour un chargement plus rapide et un accès hors-ligne basique — il
// ne met JAMAIS en cache les échanges avec Firebase/Firestore (comptes, défis, classements en
// direct, bandeau live) : ces requêtes passent toujours en direct sur le réseau, sinon on
// risquerait de servir des données périmées ou de casser l'authentification.

const CACHE_NAME = 'f1-finger-race-v8';

// Coquille pré-chargée dès l'installation : l'appli s'ouvre hors-ligne dès la 2e visite, sans
// dépendre de ce que le joueur a déjà consulté.
const PRECACHE = ['./', 'index.html', 'app.css', 'manifest.json', 'privacy.html',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'lang/en.json', 'lang/es.json', 'lang/pt.json', 'lang/de.json', 'lang/it.json', 'lang/nl.json',
  'lang/ar.json', 'lang/ja.json', 'lang/zh.json', 'lang/id.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // cache.addAll() est TOUT-OU-RIEN : une seule URL en échec (fichier renommé, 404 passager,
    // coupure réseau au mauvais moment) faisait échouer l'ensemble du pré-cache, en silence à
    // cause du .catch() — l'appli n'avait alors plus rien hors-ligne, sans aucun signe visible.
    // On met donc chaque fichier en cache indépendamment : ce qui passe est gardé, ce qui
    // échoue est simplement signalé dans la console et sera récupéré au premier accès réseau.
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      PRECACHE.map((url) => cache.add(url).catch((err) => {
        console.warn('[SW] pré-cache impossible pour', url, err);
      }))
    )).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// Domaines à ne JAMAIS servir depuis le cache : authentification et données Firestore/Firebase
// (comptes, défis, classements, bandeau live) — toujours en direct sur le réseau.
const NEVER_CACHE_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.googleapis.com'
];

// Pareil pour les requêtes de mesure Google Analytics ("beacons" g/collect envoyées à chaque
// évènement) : chaque appel a une URL quasi unique (paramètres différents à chaque fois), donc
// les mettre en cache ne sert jamais à rien et ferait juste grossir le cache indéfiniment. Le
// nom exact varie selon la région Google (region1, region2...), d'où un test par suffixe plutôt
// qu'une liste figée — contrairement à firebase-analytics-compat.js et gtag.js eux-mêmes (le
// code de la librairie, pas les mesures) qui restent mis en cache normalement, comme les autres
// fichiers statiques.
function isAnalyticsCollectHost(hostname) {
  return /(^|\.)google-analytics\.com$/.test(hostname) || /(^|\.)analytics\.google\.com$/.test(hostname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // laisse passer les écritures Firestore (POST) sans y toucher
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (NEVER_CACHE_HOSTS.indexOf(url.hostname) !== -1) return;
  if (isAnalyticsCollectHost(url.hostname)) return;

  if (req.mode === 'navigate' || /\/lang\/[a-z]{2}\.json$/.test(url.pathname) || /\/app\.css$/.test(url.pathname)) {
    // La page principale : toujours la dernière version en ligne en priorité : le cache ne
    // sert que si le réseau est indisponible (mode hors-ligne).
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Tout le reste (manifest, icônes, polices Google, SDK Firebase...) : cache en priorité pour
  // un chargement instantané, réseau en repli si absent du cache, et mise à jour du cache en
  // arrière-plan à chaque réponse valide.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => null);
      if (cached) return cached;
      // Rien en cache ET le réseau échoue (bloqué par un pare-feu/bloqueur de pub, hors-ligne,
      // domaine externe indisponible) : on ne peut pas renvoyer "undefined" à respondWith() (ça
      // provoque un "Failed to convert value to 'Response'" et casse le chargement de la page)
      // — on renvoie une réponse vide (204) pour que le script appelant échoue proprement, comme
      // si la ressource avait simplement mis du temps à répondre puis avait été annulée.
      return network.then((res) => res || new Response(null, { status: 204, statusText: 'offline' }));
    })
  );
});
