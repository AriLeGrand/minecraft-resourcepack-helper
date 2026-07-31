-- modules/mc_data.lua
-- Table de référence des versions Minecraft "curatées" (utilisées pour le
-- pack_format et le format d'export), + une fonction de déduction du format
-- de dossiers (block/blocks) pour n'importe quelle version installée
-- (y compris des versions qui ne sont pas dans notre liste curatée).

local M = {}

M.order = {"1.8.9", "1.12.2", "1.16.5", "1.19.4", "1.20+"}

M.versions = {
    ["1.8.9"] = {
        pack_format = 1,
        block_folder = "blocks",
        item_folder = "items",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 1, valable de 1.6.1 à 1.8.9."
    },
    ["1.12.2"] = {
        pack_format = 3,
        block_folder = "blocks",
        item_folder = "items",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 3, dernière version avant la Flattening."
    },
    ["1.16.5"] = {
        pack_format = 6,
        block_folder = "block",
        item_folder = "item",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 6, valable de 1.16.2 à 1.16.5."
    },
    ["1.19.4"] = {
        pack_format = 13,
        block_folder = "block",
        item_folder = "item",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 13, spécifique à 1.19.4."
    },
    ["1.20+"] = {
        pack_format = 15,
        block_folder = "block",
        item_folder = "item",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 15 pour 1.20/1.20.1. Vérifie le format exact pour 1.20.2+ / 1.21.x si besoin (change souvent)."
    }
}

M.categories = {
    {key = "Blocks", label = "Blocks", subfolder_field = "block_folder"},
    {key = "Items", label = "Items", subfolder_field = "item_folder"},
    {key = "GUI", label = "GUI", subfolder_field = "gui_folder"},
    {key = "Entities", label = "Entities", subfolder_field = "entity_folder"}
}

M.resolutions = {16, 32, 64, 128, 256, 512}

-- Devine le mapping de dossiers (block vs blocks) pour N'IMPORTE QUELLE
-- version installée sur le PC (pas seulement celles de M.order), en se
-- basant sur la Flattening (1.13). Utilisé pour scanner le .jar "vanilla"
-- source, indépendamment de la version d'export choisie.
--
-- Limite assumée : les identifiants de snapshot (ex: "23w13a") ne sont pas
-- parsables en numéro de version -> on suppose alors le format "moderne"
-- (singulier), ce qui est correct pour la quasi-totalité des snapshots
-- conservés par le launcher (postérieurs à la Flattening de 2018).
function M.guessFolderStyle(versionString)
    local major, minor = versionString:match("^(%d+)%.(%d+)")
    local isLegacy = false
    if major and minor then
        major, minor = tonumber(major), tonumber(minor)
        if major == 1 and minor < 13 then
            isLegacy = true
        end
    end

    if isLegacy then
        return {block_folder = "blocks", item_folder = "items", gui_folder = "gui", entity_folder = "entity"}
    else
        return {block_folder = "block", item_folder = "item", gui_folder = "gui", entity_folder = "entity"}
    end
end

return M
