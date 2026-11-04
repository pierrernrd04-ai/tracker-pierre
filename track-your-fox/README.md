# TRACK YOUR FOX

Une application web pour suivre son alimentation à partir de photos. Elle s'installe sur l'écran d'accueil de l'iPhone. Claude joue le rôle d'un nutritionniste : il identifie les aliments, estime les portions et calcule les calories (±50 kcal), les protéines, les glucides, les lipides, les fibres, 8 vitamines et 6 minéraux.

## Installer sur iPhone

1. Ouvre **https://pierrernrd04-ai.github.io/tracker-pierre/track-your-fox/** dans **Safari**.
2. Touche **Partager**, puis **Sur l'écran d'accueil**, puis **Ajouter**.
3. Dans l'onglet **Profil**, colle ta clé API Anthropic (à créer sur [console.anthropic.com](https://console.anthropic.com/settings/keys)).

## Fonctionnalités

- **Journée** : heure et date en direct, calendrier de la semaine, anneau des calories avec le rythme attendu selon l'heure, macronutriments, déroulé de la journée heure par heure, vitamines et minéraux.
- **Scanner** : photo avec l'appareil ou depuis la galerie, aliments repérés sur la photo, poids modifiables avec recalcul, score qualité et conseil.
- **Historique** : recherche dans les repas, filtres sur 7 jours, 30 jours ou tout.
- **Bilan** : semaine, mois ou 3 mois. Graphiques, répartition énergétique, régularité, aliments les plus fréquents et bilan rédigé par l'IA.
- **Profil** : objectifs calculés avec la formule de Mifflin-St Jeor, thème, export et import d'une sauvegarde.

## Confidentialité

Les repas et la clé API restent sur l'appareil (IndexedDB et localStorage). Les photos sont envoyées uniquement à `api.anthropic.com` pour l'analyse. Chaque analyse est facturée sur ton compte Anthropic.

## Technique

Site statique sans étape de build : `index.html`, `app.js`, un service worker (`sw.js`) pour l'usage hors connexion et un manifeste PWA. L'app utilise le SDK officiel `@anthropic-ai/sdk`, chargé depuis jsDelivr, et le modèle `claude-opus-5-5` avec des sorties structurées (JSON Schema).
