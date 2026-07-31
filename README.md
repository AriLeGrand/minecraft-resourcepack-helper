# Minecraft Resource Pack Helper - Documentation & User Guide

**Minecraft Resource Pack Helper** is a powerful extension designed for **Aseprite**. It greatly simplifies the creation, modification, and organization of Minecraft resource pack textures by automating the extraction of vanilla source files (`.jar`) and structuring the export directory tree.

---

## 🚀 Key Features

* **Automatic Extraction:** Scans your `.minecraft` folder, detects installed versions, and extracts official game textures.
* **Resolution & Scale Management:** Full support for standard textures (`16x16`, `32x32`, etc.) and special scaling options for **GUIs** and **Entities** (`1x`, `2x`, `4x`, `6x`, `8x`, `10x`).
* **Smart Catalog:** Smooth category-based navigation (Blocks, Items, GUIs, Entities, etc.) to instantly find and modify any texture.
* **Anti-Loss Security:** Built-in alert system if you attempt to switch textures without saving your current modifications.
* **Packaging Tools:** Automatic generation of the `pack.mcmeta` file tailored to the target version and quick integration of the pack icon (`pack.png`).

---

## 📂 Extension Installation

To install or update the extension in Aseprite, follow these steps:

1. Locate your Aseprite extensions directory (typically via Steam on Windows):
   ```text
   C:\Program Files (x86)\Steam\steamapps\common\Aseprite\data\extensions\minecraft-resourcepack-helper\
   ```
2. Replace or place the extension files (especially the updated `modules/ui.lua` file).
3. Restart Aseprite to load the extension. The interface will automatically appear as a dialog window.

---

## 📖 Quick Start Guide

### Step A: Vanilla Source Configuration
Check the **Source Configuration (.jar vanilla)** option:
1. Click **Detect + Scan Versions** to automatically locate your `.minecraft` folder.
2. Select the installed version you want to use as a base from the dropdown menu.
3. Click **Extract Textures** to prepare the workspace.

### Step B: Destination Folder
Specify the root folder of the resource pack you are creating in the **Destination** field or use the **Browse...** button.

### Step C: Editing Textures
In the **Catalog** section:
1. Choose the **Category** (e.g., `Blocks`, `Items`, `GUI`, etc.).
2. Select the **Element** to edit. The extension will automatically open it at the correct scale.
3. Create or modify your pixel art in Aseprite. For GUIs and entities, you can adjust the dedicated scale (`x1` to `x10`) to fit your needs.
4. Click **Save and Export** to directly save the file into the correct path within your pack.

> 💡 **Safety Tip:** If you forget to save and select another texture, a pop-up window will prompt you to save your changes to prevent any work loss.

---

## 📏 GUI / Entity Scales Summary Table

| Scale Parameter | Recommended Use | Behavior |
| :--- | :--- | :--- |
| **1x / 2x / 4x** | Classic packs and standard high resolutions | Base multiplier applied to the canvas. |
| **6x / 8x / 10x** | Ultra-detailed packs or large interface elements (GUI) | Enables working on complex interfaces with higher zoom and precision levels. |

---

## 📦 Pack Finalization

Once your textures are ready:
* Select your icon image via the dedicated file selector and click **Copy as pack.png**.
* Fill in your pack description and click **Generate pack.mcmeta** (the correct `pack_format` is automatically applied based on the targeted version).
