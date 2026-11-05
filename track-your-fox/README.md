# TRACK YOUR FOX

Une application web pour suivre son alimentation à partir de photos, 100 % gratuite : sans compte, sans clé API. Elle s'installe sur l'écran d'accueil de l'iPhone. Le plat est reconnu directement sur le téléphone, puis l'app calcule les calories, les protéines, les glucides, les lipides, les fibres, 8 vitamines et 6 minéraux.

## Installer sur iPhone

1. Ouvre **https://pierrernrd04-ai.github.io/tracker-pierre/track-your-fox/go/**. Ce lien bascule automatiquement vers Safari.
2. Touche **Partager**, puis **Sur l'écran d'accueil**, puis **Ajouter**.

La première analyse télécharge le modèle de reconnaissance (60 Mo, une seule fois). Ensuite, l'analyse fonctionne même sans connexion.

## Fonctionnalités

- **Journée** : heure et date en direct, calendrier de la semaine, anneau des calories avec le rythme attendu selon l'heure, macronutriments, déroulé de la journée heure par heure, vitamines et minéraux.
- **Scanner** : reconnaissance de 101 plats sur l'appareil, choix parmi d'autres plats si la reconnaissance se trompe, recherche parmi environ 150 plats et aliments pour compléter l'assiette, poids modifiables avec recalcul, score qualité et conseil.
- **Historique** : recherche dans les repas, filtres sur 7 jours, 30 jours ou tout.
- **Bilan** : semaine, mois ou 3 mois. Graphiques, répartition énergétique, régularité, aliments les plus fréquents et bilan rédigé par l'app à partir de tes repas.
- **Profil** : objectifs calculés avec la formule de Mifflin-St Jeor, thème, export et import d'une sauvegarde.

## Confidentialité

Tout reste sur l'appareil : les photos ne sont jamais envoyées, et les repas sont enregistrés localement (IndexedDB et localStorage).

## Technique

Site statique sans étape de build : `index.html`, `app.js`, un service worker (`sw.js`) pour l'usage hors connexion et un manifeste PWA. La reconnaissance utilise `@huggingface/transformers` (chargé depuis jsDelivr) avec le modèle `onnx-community/swin-finetuned-food101-ONNX` en version 4 bits, exécuté en WebAssembly. Les valeurs nutritionnelles sont des moyennes inspirées des tables CIQUAL et USDA, par portion type.
