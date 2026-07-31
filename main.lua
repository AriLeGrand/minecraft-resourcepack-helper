-- main.lua

local function scriptDir()
    local info = debug.getinfo(1, "S")
    return app.fs.filePath(info.source:sub(2))
end

local base = scriptDir()

local McData = dofile(app.fs.joinPath(base, "modules", "mc_data.lua"))
local Scanner = dofile(app.fs.joinPath(base, "modules", "scanner.lua"))
local Export = dofile(app.fs.joinPath(base, "modules", "export.lua"))
local Extractor = dofile(app.fs.joinPath(base, "modules", "extractor.lua"))

-- === État persistant pendant la session ===
-- baseVersion  : version installée utilisée UNIQUEMENT pour extraire le jar.
-- exportVersion: version choisie UNIQUEMENT pour le pack final (pack_format
--                + structure de dossiers en sortie).
local State = {
    vanillaPath = "",
    packPath = "",
    baseVersion = "",
    exportVersion = McData.order[1],
    resolution = 16,
    guiEntityScale = "1x",
    category = "Blocks",
    item = nil,
    description = "Mon Resource Pack",
    mcRoot = Extractor.detectDefaultMinecraftDir(),
    cacheBaseDir = app.fs.joinPath(base, "cache")
}

function init(plugin)
    plugin:newCommand {
        id = "MinecraftRPHelper_OpenDialog",
        title = "Minecraft Resource Pack Helper",
        group = "edit_new",
        onclick = function()
            local buildUI = dofile(app.fs.joinPath(base, "modules", "ui.lua"))
            buildUI(plugin, State, McData, Scanner, Export, Extractor)
        end
    }
end

function exit(plugin)
end
