# Chimère

Séparation de morceaux en pistes (voix, batterie, basse, reste) **entièrement dans le navigateur**,
puis, à terme, mixage de pistes de plusieurs morceaux. Cahier des charges : [docs/fiche-projet.md](docs/fiche-projet.md).

**État : étape 2, squelette et design.** Interface sombre (barre latérale, lecteur en pied de page) ;
la vue *Séparer* charge le modèle, sépare un extrait de 30 s et fait écouter chaque piste.

## Confidentialité

- Les fichiers audio et les pistes ne quittent jamais votre machine.
- Le seul accès réseau tiers est le téléchargement du modèle depuis Hugging Face
  (`timcsy/demucs-web-onnx`, 181 Mo, une seule fois, puis mis en cache). Hugging Face voit
  donc votre adresse IP à ce moment-là.
- Aucun cookie, aucune mesure d'audience.

## Usage légal

Utilisez des fichiers que vous possédez légitimement. Les pistes et mixes obtenus restent des
reproductions d'œuvres protégées : usage privé uniquement, sauf autorisation des ayants droit.

## Développement

Node.js ^20.19 ou ≥ 22.12.

```bash
npm install
npm run dev
```

Le serveur de dev envoie lui-même les en-têtes COOP/COEP. En production (GitHub Pages),
`coi-serviceworker` s'en charge ; la page se recharge une fois à la première visite.

Déploiement : activer *Settings → Pages → Source : GitHub Actions* ; chaque push sur `main` déploie.

## Crédits

- Modèle HTDemucs (Demucs v4, Meta AI), MIT ; export ONNX et STFT JS par
  [demucs-web](https://github.com/timcsy/demucs-web), MIT.
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), MIT.
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), MIT.
- Police [Inter](https://rsms.me/inter/), OFL-1.1, auto-hébergée.
