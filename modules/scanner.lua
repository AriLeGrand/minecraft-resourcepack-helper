-- modules/scanner.lua
local M = {}

local function joinRel(a, b)
    if a == "" then
        return b
    end
    return a .. "/" .. b
end

local function walk(fullPath, relPath, results)
    local ok, entries = pcall(app.fs.listFiles, fullPath)
    if not ok or not entries then
        return
    end
    for _, name in ipairs(entries) do
        local entryFull = app.fs.joinPath(fullPath, name)
        local entryRel = joinRel(relPath, name)
        if app.fs.isDirectory(entryFull) then
            walk(entryFull, entryRel, results)
        else
            local ext = app.fs.fileExtension(name)
            if ext and ext:lower() == "png" then
                table.insert(results, entryRel:sub(1, -5))
            end
        end
    end
end

-- folderProfile : table avec les champs block_folder/item_folder/etc,
-- peut venir soit de McData.versions[x] soit de McData.guessFolderStyle(x)
function M.scanCategory(vanillaRoot, folderProfile, categoryDef)
    local subfolder = folderProfile[categoryDef.subfolder_field]
    local basePath = app.fs.joinPath(vanillaRoot, "assets", "minecraft", "textures", subfolder)

    local results = {}
    if vanillaRoot == "" or not app.fs.isDirectory(basePath) then
        return results, basePath
    end

    walk(basePath, "", results)
    table.sort(results)
    return results, basePath
end

return M
