-- modules/extractor.lua
local M = {}

local function detectOS()
    if os.getenv("APPDATA") and os.getenv("USERPROFILE") then
        return "windows"
    end
    local handle = io.popen("uname -s 2>/dev/null")
    if handle then
        local result = handle:read("*l") or ""
        handle:close()
        if result:match("Darwin") then
            return "macos"
        end
        if result:match("Linux") then
            return "linux"
        end
    end
    return "unknown"
end

M.currentOS = detectOS()

function M.detectDefaultMinecraftDir()
    local osName = M.currentOS
    if osName == "windows" then
        local appdata = os.getenv("APPDATA")
        if appdata then
            return app.fs.joinPath(appdata, ".minecraft")
        end
    elseif osName == "macos" then
        local home = os.getenv("HOME")
        if home then
            return app.fs.joinPath(home, "Library", "Application Support", "minecraft")
        end
    elseif osName == "linux" then
        local home = os.getenv("HOME")
        if home then
            return app.fs.joinPath(home, ".minecraft")
        end
    end
    return ""
end

-- === NOUVEAU : scan des versions réellement installées ===
-- Utilise app.fs.listFiles + app.fs.isDirectory pour lister les
-- sous-dossiers de .minecraft/versions/, et ne garde que ceux qui
-- contiennent un .jar du même nom (filtre anti-dossiers "poubelle").
function M.scanInstalledVersions(mcRoot)
    local results = {}
    if not mcRoot or mcRoot == "" then
        return results
    end

    local versionsDir = app.fs.joinPath(mcRoot, "versions")
    if not app.fs.isDirectory(versionsDir) then
        return results
    end

    local ok, entries = pcall(app.fs.listFiles, versionsDir)
    if not ok or not entries then
        return results
    end

    for _, name in ipairs(entries) do
        local full = app.fs.joinPath(versionsDir, name)
        if app.fs.isDirectory(full) then
            local jarPath = app.fs.joinPath(full, name .. ".jar")
            if app.fs.isFile(jarPath) then
                table.insert(results, name)
            end
        end
    end

    table.sort(results)
    return results
end

local function ensureDirRecursive(path)
    local parts = {}
    for part in path:gmatch("[^/\\]+") do
        table.insert(parts, part)
    end
    local current = ""
    if path:sub(1, 1) == "/" then
        current = "/"
    end
    for _, part in ipairs(parts) do
        current = (current == "" or current == "/") and (current .. part) or (current .. "/" .. part)
        if not app.fs.isDirectory(current) then
            pcall(app.fs.makeDirectory, current)
        end
    end
end

function M.buildJarPath(mcRoot, versionFolder)
    return app.fs.joinPath(mcRoot, "versions", versionFolder, versionFolder .. ".jar")
end

local function runExtraction(jarPath, destDir)
    local osName = M.currentOS
    local cmd
    if osName == "windows" then
        cmd = string.format('tar -xf "%s" -C "%s" assets/minecraft/textures >NUL 2>&1', jarPath, destDir)
    elseif osName == "macos" or osName == "linux" then
        cmd = string.format('unzip -o "%s" "assets/minecraft/textures/*" -d "%s" >/dev/null 2>&1', jarPath, destDir)
    else
        return false, "Système d'exploitation non reconnu."
    end
    local ok = os.execute(cmd)
    return (ok == true) or (ok == 0), cmd
end

function M.extractTextures(mcRoot, versionFolder, cacheBaseDir)
    if not mcRoot or mcRoot == "" then
        return false, "Dossier .minecraft non renseigné."
    end
    if not versionFolder or versionFolder == "" then
        return false, "Aucune version sélectionnée."
    end

    local jarPath = M.buildJarPath(mcRoot, versionFolder)
    if not app.fs.isFile(jarPath) then
        return false, string.format(
            "Fichier .jar introuvable :\n%s\n\nLance cette version au moins une fois via le launcher.",
            jarPath
        )
    end

    local destDir = app.fs.joinPath(cacheBaseDir, versionFolder)
    ensureDirRecursive(destDir)

    local success, info = runExtraction(jarPath, destDir)
    if not success then
        return false, "Échec de l'extraction (commande système). Vérifie que 'tar'/'unzip' est disponible."
    end

    local checkPath = app.fs.joinPath(destDir, "assets", "minecraft", "textures")
    if not app.fs.isDirectory(checkPath) then
        return false, "Extraction terminée mais aucune texture trouvée dans ce .jar."
    end

    return true, destDir
end

return M
