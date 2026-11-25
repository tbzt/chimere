# Fiche projet — Appli de séparation de pistes et de bootlegs

25 nov. 2026 · Thomas · nom du projet : **Chimère** (dépôt `chimere`)

## Objet et périmètre

Une application web statique, hébergée sur GitHub Pages, qui sépare un morceau en pistes (voix, batterie, basse, reste) puis permet de mixer plusieurs morceaux entre eux pour produire des bootlegs. Tout le traitement se fait dans le navigateur : aucun fichier audio n'est envoyé à un serveur.

- **Usage** : domestique, un seul utilisateur, sans compte ni base de données.
- **Hébergement** : dépôt public sur github.io. Le code est public ; les morceaux et les pistes restent sur la machine de l'utilisateur.
- **Nom** : **Chimère** (dépôt et identifiants : `chimere`). Comme la créature faite de morceaux d'animaux, un bootleg est fait de morceaux de chansons. Le logo doit être propre au projet (piste : une silhouette faite de formes d'onde aux couleurs des pistes).
- **Hors périmètre** : partage en ligne des créations, bibliothèque de morceaux hébergée, collaboration, application mobile native.

Conséquence structurante : GitHub Pages ne sert que des fichiers statiques. La séparation repose donc sur un modèle exécuté côté client (ONNX Runtime Web avec WebGPU, repli WebAssembly), et non sur un serveur Python.

## Fonctionnalités par version

Le MVP sépare et fait écouter ; la V2 ajoute le mixage multi-morceaux ; la V3 ajoute l'édition fine. Chaque version doit être utilisable seule.

### MVP — Séparer et écouter

- [ ] Import par glisser-déposer (MP3, WAV, FLAC, M4A) et décodage via Web Audio, rééchantillonné à 44,1 kHz
- [ ] Séparation en 4 pistes (voix, batterie, basse, reste) avec barre de progression, dans un Web Worker
- [ ] Lecteur multipiste : forme d'onde, lecture synchronisée, solo / muet / volume par piste
- [ ] Export de chaque piste en WAV, et d'un « instrumental » (tout sauf la voix)
- [ ] Cache local des pistes (IndexedDB, en int16) pour ne pas recalculer un morceau déjà séparé ; `navigator.storage.persist()`
- [ ] Détection WebGPU et message clair si le navigateur passe en mode lent (WASM)

### V2 — Mixer plusieurs morceaux

- [ ] Bibliothèque locale des morceaux séparés (liste, recherche, suppression)
- [ ] Analyse automatique : tempo (BPM), tonalité, notation Camelot pour repérer les tonalités compatibles
- [ ] Projet de mashup : une timeline où l'on place des pistes issues de morceaux différents (ex. voix de A sur instrumental de B)
- [ ] Calage du tempo (time-stretch) et transposition (pitch-shift) par piste, sans changer l'autre paramètre — pré-calculés dans un Worker à chaque changement, puis lus comme des buffers ordinaires
- [ ] Grille de mesures et magnétisme sur les temps ; décalage manuel fin
- [ ] Volume, panoramique, fondus d'entrée et de sortie par clip
- [ ] Export du mix en WAV (rendu hors temps réel), MP3 en option
- [ ] Sauvegarde du projet (JSON + références aux pistes en cache), réouverture

### V3 — Édition fine

- [ ] Découpe, duplication et boucle de clips
- [ ] Automation simple du volume et filtre passe-haut / passe-bas (effet de transition DJ)
- [ ] Modèle 6 pistes (ajout guitare et piano) en option
- [ ] Application installable hors ligne (PWA)

## Architecture technique

Une seule page en JavaScript vanilla (modules ES, Vite pour le build), qui confie le calcul lourd à des Web Workers et le son à la Web Audio API.

Le modèle est le seul élément téléchargé ; les morceaux et les pistes ne quittent jamais la machine.

Versions et licences vérifiées le 25 nov. 2026 (registre npm, cartes Hugging Face).

| Fonction | Brique | Version | Licence | Remarque |
|---|---|---|---|---|
| Inférence | onnxruntime-web | 1.31.1 | MIT | Contient WebGPU (JSEP) et WASM |
| Modèle | HTDemucs 4 pistes, `timcsy/demucs-web-onnx`, fichier `htdemucs_embedded.onnx` | commit `92e33df6` | Code demucs-web MIT ; poids Demucs MIT (licence non indiquée sur le dépôt Hugging Face) | 181 Mo, fp32. Entrées : forme d'onde + spectrogramme ; sorties : branche temporelle + branche fréquentielle. Fenêtre fixe de 343 980 échantillons (7,8 s) |
| STFT / iSTFT | demucs-web (npm) | 1.0.2 | MIT | Fonctions `prepareModelInput`, `standaloneMask`, `standaloneIspec` |
| Écartés | `StemSplitio/htdemucs-onnx` (forme d'onde seule, 166 Mo) | commit `d54ed9eb` | MIT | Ne se charge pas dans onnxruntime-web 1.31 (`std::bad_alloc`, en fp16 comme en fp32) |
| Alternative WebGPU | `monteslu/htdemucs-web-onnx` (21 morceaux, précision mixte) | — | MIT | À essayer si le modèle retenu est trop lent ou échoue en WebGPU |
| Isolation cross-origin | coi-serviceworker | 0.1.7 | MIT | Pour SharedArrayBuffer (WASM multithread) sur GitHub Pages |
| Build | Vite | 8.3.8 | MIT | Node ^20.19 ou ≥ 22.12 |
| Tempo et tonalité | essentia.js | 0.1.3 | AGPL-3.0 | Alternative BPM seul : web-audio-beat-detector 8.2.39 (MIT) |
| Time-stretch / pitch | rubberband-wasm 3.3.0, ou soundtouchjs 0.3.0 / @soundtouchjs/audio-worklet 2.1.1 | — | GPL-2.0 / LGPL-2.1 / MPL-2.0 | Rubber Band = meilleure qualité sur la voix |
| Police | Inter (variable), @fontsource-variable/inter | 5.3.0 | OFL-1.1 | Auto-hébergée, chiffres tabulaires |
| Formes d'onde | wavesurfer.js | 8.1.1 | BSD-3-Clause | Ou rendu canvas maison pour la timeline |
| Lecture et mixage | Web Audio API | natif | — | Rendu final via OfflineAudioContext |
| Export | WAV maison ; MP3 via lamejs 1.2.1 ou @breezystack/lamejs 1.2.7 | — | LGPL-3.0 | WAV d'abord, MP3 en option |
| Stockage | idb-keyval 6.3.0 + Cache API pour le modèle | — | Apache-2.0 / natif | Le modèle n'est téléchargé qu'une fois |

**Licence du dépôt** : toutes ces briques sont compatibles avec l'**AGPL-3.0**. C'est le choix le plus simple ; la voie sans AGPL (web-audio-beat-detector, détection de tonalité maison, SoundTouch) reste possible.

### Points techniques à traiter dès le départ

1. **Taille du modèle** : GitHub refuse les fichiers de plus de 100 Mo et Pages n'est pas fait pour servir de gros binaires. Le modèle (181 Mo) est chargé depuis Hugging Face (CORS vérifié : `access-control-allow-origin: *` sur le CDN), à une révision figée, puis mis en cache via la Cache API. Les fichiers joints aux releases GitHub ne renvoient pas d'en-têtes CORS : ils ne sont pas utilisables.
2. **Isolation cross-origin** : le WASM multithread exige SharedArrayBuffer, donc les en-têtes COOP/COEP, que GitHub Pages ne permet pas de définir. Contournement : coi-serviceworker (rechargement de la page à la première visite). Le chemin WebGPU n'en dépend pas.
   **Constat du 25 nov. 2026** : l'isolation fonctionne, mais ONNX Runtime en WASM multithread se bloque à la création de session dès qu'il tourne dans un Worker (Chromium 156, y compris en mode `proxy` d'ORT). Le mode WASM tourne donc sur 1 thread par défaut (environ ×3,7 le temps réel, soit environ 15 min pour 4 min de musique) ; `?threads=N` permet de réessayer sur d'autres navigateurs. Dans la page principale, 8 threads ne font que doubler la vitesse et figent l'interface. Le WebGPU devient donc indispensable pour un usage confortable.
   **Constat du 25 nov. 2026 (WebGPU)** : sur la machine cible (GTX 1060, pilote NVIDIA 580, Ubuntu, Wayland), la session WebGPU renvoyait des pistes entièrement nulles, sans erreur, d'où une voix presque absente. Cause : Chrome lancé avec `--use-angle=vulkan --ozone-platform=wayland` (réglages faits pour la vidéo), combinaison que Chrome déclare incompatible. Lancé sans ces options, WebGPU donne le même résultat que WASM (écart < 1 % par piste). Parades gardées : chaque fenêtre est contrôlée (la somme des pistes doit redonner l'entrée) et un échec relance la séparation en WASM ; le prologue de normalisation du graphe est forcé sur CPU (méthode de `monteslu/htdemucs-web-onnx`, sans effet prouvé ici) ; Réglages → *Diagnostic WebGPU* compare les deux modes.
3. **Mémoire** : un morceau de 4 minutes en 44,1 kHz stéréo fait environ 85 Mo en float32, et 4 pistes en font 4 fois plus. Le modèle travaille par fenêtres de 7,8 s avec recouvrement de 25 % et fondu triangulaire ; stocker les pistes en int16.
4. **Fréquence d'échantillonnage** : le modèle attend du 44,1 kHz ; décoder via un `OfflineAudioContext` à 44 100 Hz.
5. **WebGPU sous Linux** : activé tardivement par défaut dans Chrome ; tester sur la machine cible dès l'étape 1. Firefox et Safari ont livré WebGPU en 2025.

## Design

L'interface reprend les codes des applis de streaming musical (thème sombre, barre latérale, lecteur en pied de page, cartes arrondies), avec une identité propre : ni logo, ni nom, ni couleurs de marque d'un service existant, puisque le site est public.

- **Structure** : barre latérale gauche (Bibliothèque, Séparer, Mashups, Réglages) ; zone centrale ; lecteur fixe en bas, avec lecture/pause, position, volume général.
- **Couleurs** : fond quasi noir, surfaces gris anthracite en deux niveaux, texte blanc cassé et gris moyen ; une seule couleur d'accent vive, choisie pour le projet, réservée aux actions et à l'élément en cours de lecture.
- **Pistes** : une couleur fixe par type de piste (voix, batterie, basse, reste), reprise partout : formes d'onde, pastilles, clips de la timeline.
- **Typographie** : une sans-serif géométrique libre (Inter, Manrope ou Plus Jakarta Sans), auto-hébergée, titres en gras, chiffres tabulaires pour BPM et minutage.
- **Composants** : cartes de morceau à coins arrondis (pochette ou dégradé généré, titre, BPM, tonalité) ; boutons ronds pour la lecture ; puces pour les tonalités compatibles.
- **Vue Mashup** : timeline horizontale pleine largeur, une piste par ligne, en-tête de piste à gauche (nom, solo, muet, volume), règle des mesures en haut.

## Contraintes, risques et points juridiques

| Risque | Effet | Parade |
|---|---|---|
| Navigateur sans WebGPU | Séparation en WASM beaucoup plus lente | Afficher une estimation de durée ; indiquer les navigateurs compatibles |
| Mémoire saturée sur un long morceau | Onglet qui plante | Traitement par fenêtres, libération des buffers, limite de durée affichée |
| Détection BPM ou tonalité erronée | Calage faux (demi ou double tempo) | Valeur modifiable à la main, boutons ×2 et ÷2, tap tempo |
| Artefacts de time-stretch sur la voix | Son métallique au-delà de quelques pourcents | Indiquer l'écart de tempo ; privilégier Rubber Band |
| Synchronisation de la lecture | Dérive entre pistes | Tout programmer sur l'horloge AudioContext, jamais sur setTimeout |
| Licence AGPL d'essentia.js | Contamine la licence du dépôt | Publier le projet sous AGPL, ou remplacer la brique |

### Points juridiques

- L'outil est neutre : le code public ne contient ni ne diffuse aucune œuvre, et le traitement reste local.
- Les pistes séparées et les bootlegs restent des reproductions et des adaptations d'œuvres protégées. La copie privée (CPI, art. L122-5) couvre les reproductions faites à partir d'une **source licite** et réservées à l'usage privé ; l'application aux transformations est discutée, mais le risque pratique d'un usage strictement privé est nul. Publier un mix suppose des autorisations.
- L'outil s'applique aux fichiers que l'utilisateur possède légitimement. Capturer un flux de streaming n'est pas une source licite, et contourner une mesure technique de protection est sanctionné (CPI, art. L335-3-1).
- Ne pas livrer de morceau sous droits dans le dépôt : utiliser un titre sous licence libre (Creative Commons) pour les tests et la démo.
- Pas de cookie ni de mesure d'audience. Le seul tiers contacté est Hugging Face, au téléchargement du modèle (qui voit donc l'adresse IP) ; le mentionner dans le README. Polices auto-hébergées.

## Plan de travail

Six étapes, chacune livrée et testée à l'oreille avant la suivante.

1. **Preuve de faisabilité** : page minimale qui charge le modèle depuis Hugging Face, sépare un extrait de 30 s et joue la voix seule ; déployée sur GitHub Pages pour vérifier WebGPU, coi-serviceworker et les temps de calcul. Comparer à l'oreille avec Demucs natif sur le même extrait.
2. **Squelette et design** : layout sombre (barre latérale, zone centrale, lecteur bas), variables CSS, routage simple entre les vues.
   *Fait le 25 nov. 2026* : routage par ancre (`#/separer`…), lecteur bas (lecture/pause, position, volume général, barre d'espace), police Inter, logo en formes d'onde ; Bibliothèque et Mashups sont des vues vides en attendant les étapes 3 et 5.
3. **MVP complet** : import, séparation dans un Worker, lecteur multipiste, export WAV, cache IndexedDB. Tester le décodage M4A sous Firefox Linux.
4. **Analyse** : BPM, tonalité, Camelot, correction manuelle.
5. **Mashup** : timeline, placement des pistes, time-stretch et pitch-shift, mixage, export du mix, sauvegarde du projet.
6. **Finitions** : PWA hors ligne, raccourcis clavier, tests sur Chrome, Edge, Firefox et Safari.

## Sources

- demucs-web : https://github.com/timcsy/demucs-web
- demucs-onnx (intégration navigateur) : https://stemsplit.github.io/demucs-onnx/browser/
- Modèle retenu : https://huggingface.co/timcsy/demucs-web-onnx
- Modèle écarté : https://huggingface.co/StemSplitio/htdemucs-onnx
- Export WebGPU en précision mixte : https://huggingface.co/monteslu/htdemucs-web-onnx
- essentia.js (AGPL-3.0) : https://mtg.github.io/essentia.js/
