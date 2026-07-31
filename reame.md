# Minecraft Resource Pack Helper - Documentation & Guide d'utilisation

**Minecraft Resource Pack Helper** est une extension puissante conçue pour **Aseprite**. Elle simplifie grandement la création, la modification et l'organisation des textures de packs de ressources Minecraft en automatisant l'extraction des fichiers sources vanilla (`.jar`) et en structurant l'arborescence d'exportation.

---

## 🚀 Fonctionnalités Principales

* **Extraction automatique :** Analyse votre dossier `.minecraft`, détecte les versions installées et extrait les textures officielles du jeu.
* **Gestion des résolutions et échelles :** Support complet des textures standards (`16x16`, `32x32`, etc.) et des échelles spéciales pour les **GUIs** et les **Entités** (`1x`, `2x`, `4x`, `6x`, `8x`, `10x`).
* **Catalogue intelligent :** Navigation fluide par catégories (Blocs, Items, GUIs, Entités, etc.) pour retrouver et modifier instantanément n'importe quelle texture.
* **Sécurité anti-perte :** Système d'alerte intégré si vous tentez de changer de texture sans avoir sauvegardé vos modifications en cours.
* **Outils de packaging :** Génération automatique du fichier `pack.mcmeta` adapté à la version cible et intégration rapide de l'icône du pack (`pack.png`).

---

## 📂 Installation de l'extension

Pour installer ou mettre à jour l'extension dans Aseprite, suivez ces étapes :

1. Localisez le dossier d'extensions d'Aseprite (généralement via Steam sous Windows) :
   ```text
   C:\Program Files (x86)\Steam\steamapps\common\Aseprite\data\extensions\minecraft-resourcepack-helper\
   ```
2. Remplacez ou placez les fichiers de l'extension (notamment le fichier `modules/ui.lua` mis à jour).
3. Redémarrez Aseprite pour charger l'extension. L'interface apparaîtra automatiquement sous forme de fenêtre de dialogue.

---

## 📖 Guide d'utilisation rapide

### Étape A : Configuration de la source Vanilla
Cochez l'option **Configuration source (.jar vanilla)** :
1. Cliquez sur **Détecter + scanner mes versions** pour localiser automatiquement votre dossier `.minecraft`.
2. Sélectionnez la version installée que vous souhaitez utiliser comme base dans le menu déroulant.
3. Cliquez sur **Extraire les textures** pour préparer l'environnement de travail.

### Étape B : Dossier de destination
Indiquez le dossier racine de votre propre resource pack en cours de création dans le champ **Destination** ou utilisez le bouton **Parcourir...**.

### Étape C : Édition des textures
Dans la section **Catalogue** :
1. Choisissez la **Catégorie** (ex: `Blocks`, `Items`, `GUI`, etc.).
2. Sélectionnez l'**Élément** à modifier. L'extension l'ouvrira automatiquement à la bonne échelle.
3. Effectuez vos pixel arts sous Aseprite. Pour les GUIs et entités, vous pouvez ajuster l'échelle dédiée (`x1` à `x10`) selon vos besoins.
4. Cliquez sur **Sauvegarder et Exporter** pour enregistrer directement le fichier au bon endroit dans votre pack.

> 💡 **Astuce de sécurité :** Si vous oubliez de sauvegarder et sélectionnez une autre texture, une fenêtre pop-up vous demandera si vous souhaitez enregistrer vos modifications pour éviter toute perte de travail.

---

## 📏 Tableau récapitulatif des Échelles GUI / Entités

| Paramètre d'échelle | Utilisation recommandée | Comportement |
| :--- | :--- | :--- |
| **1x / 2x / 4x** | Packs classiques et haute résolution standards | Multiplicateur de base appliqué au canevas. |
| **6x / 8x / 10x** | Packs ultra-détaillés ou grands éléments d'interface (GUI) | Permet de travailler des interfaces complexes avec un niveau de zoom et de précision supérieur. |

---

## 📦 Finalisation du Pack

Une fois vos textures prêtes :
* Sélectionnez votre image d'icône via le sélecteur dédié et cliquez sur **Copier comme pack.png**.
* Renseignez la description de votre pack et cliquez sur **Générer pack.mcmeta** (le format correct (`pack_format`) est automatiquement appliqué selon la version ciblée).