-- modules/mc_data.lua
-- Reference table of "curated" Minecraft versions (used for
-- pack_format and export format), + a folder format deduction function
-- (block/blocks) for any installed version
-- (including versions not in our curated list).

local M = {}

M.order = {"1.8.9", "1.12.2", "1.16.5", "1.19.4", "1.20+"}

M.versions = {
    ["1.8.9"] = {
        pack_format = 1,
        block_folder = "blocks",
        item_folder = "items",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 1, valid from 1.6.1 to 1.8.9."
    },
    ["1.12.2"] = {
        pack_format = 3,
        block_folder = "blocks",
        item_folder = "items",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 3, last version before the Flattening."
    },
    ["1.16.5"] = {
        pack_format = 6,
        block_folder = "block",
        item_folder = "item",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 6, valid from 1.16.2 to 1.16.5."
    },
    ["1.19.4"] = {
        pack_format = 13,
        block_folder = "block",
        item_folder = "item",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 13, specific to 1.19.4."
    },
    ["1.20+"] = {
        pack_format = 15,
        block_folder = "block",
        item_folder = "item",
        gui_folder = "gui",
        entity_folder = "entity",
        note = "Format 15 for 1.20/1.20.1. Check exact format for 1.20.2+ / 1.21.x if needed (changes frequently)."
    }
}

M.categories = {
    {key = "Blocks", label = "Blocks", subfolder_field = "block_folder"},
    {key = "Items", label = "Items", subfolder_field = "item_folder"},
    {key = "GUI", label = "GUI", subfolder_field = "gui_folder"},
    {key = "Entities", label = "Entities", subfolder_field = "entity_folder"}
}

M.resolutions = {16, 32, 64, 128, 256, 512}

-- Guesses the folder mapping (block vs blocks) for ANY
-- version installed on the PC (not just those in M.order), based
-- on the Flattening (1.13). Used to scan the source "vanilla" .jar,
-- independently of the chosen export version.
--
-- Assumed limitation: snapshot identifiers (e.g., "23w13a") cannot be
-- parsed into version numbers -> it then assumes the "modern" format
-- (singular), which is correct for almost all snapshots
-- kept by the launcher (post-2018 Flattening).
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