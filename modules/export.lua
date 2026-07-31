-- modules/export.lua
local M = {}

function M.ensureDirRecursive(path)
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

-- === Point 4 : export "allégé" ===
-- Ne crée QUE le sous-dossier nécessaire pour CETTE texture précise
-- (ex: assets/minecraft/textures/item/), jamais l'arborescence complète.
-- C'est déjà garanti par construction : on ne crée les dossiers que juste
-- avant d'écrire le fichier ciblé, jamais en amont/en bloc.
function M.buildTexturePath(packRoot, folderProfile, categoryDef, itemId)
    local subfolder = folderProfile[categoryDef.subfolder_field]
    local fullPath = app.fs.joinPath(packRoot, "assets", "minecraft", "textures", subfolder, itemId .. ".png")
    M.ensureDirRecursive(app.fs.filePath(fullPath))
    return fullPath
end

function M.nearestResize(srcImage, newW, newH)
    local dst = Image(newW, newH, srcImage.colorMode)
    local srcW, srcH = srcImage.width, srcImage.height
    for y = 0, newH - 1 do
        local sy = math.min(math.floor(y * srcH / newH), srcH - 1)
        for x = 0, newW - 1 do
            local sx = math.min(math.floor(x * srcW / newW), srcW - 1)
            dst:putPixel(x, y, srcImage:getPixel(sx, sy))
        end
    end
    return dst
end

-- === Redimensionnement proportionnel (au lieu d'un carré forcé) ===
--
-- Logique :
--   1. On lit width/height RÉELS de l'image vanilla source (pas d'hypothèse
--      de carré 16x16 — une entité peut être 64x32, une GUI 256x256, etc.)
--   2. On calcule un multiplicateur = résolution_choisie / 16
--      (16 = résolution de base vanilla de référence pour TOUTES les
--      catégories : c'est la valeur qui sert d'échelle, pas la taille
--      finale de l'image).
--   3. On multiplie width et height d'origine par ce multiplicateur,
--      SANS jamais forcer une taille carrée.
function M.openVanillaResized(fullPngPath, scale)
    local srcSprite = Sprite {fromFile = fullPngPath}
    if not srcSprite then
        return nil, "Impossible d'ouvrir le fichier vanilla."
    end

    local multiplier = tonumber(scale) or 1

    local originalW = srcSprite.width
    local originalH = srcSprite.height

    local flatImage = Image(srcSprite.spec)
    flatImage:drawSprite(srcSprite, 1)
    local colorMode = srcSprite.colorMode
    srcSprite:close()

    local targetW = math.floor(originalW * multiplier + 0.5)
    local targetH = math.floor(originalH * multiplier + 0.5)

    if targetW < 1 then targetW = 1 end
    if targetH < 1 then targetH = 1 end

    local resizedImage = M.nearestResize(flatImage, targetW, targetH)

    local newSprite = Sprite(targetW, targetH, colorMode)
    newSprite.cels[1].image:drawImage(resizedImage, 0, 0)
    app.refresh()

    return newSprite
end

function M.createBlankSprite(resolution)
    local spr = Sprite(resolution, resolution)
    app.refresh()
    return spr
end

function M.exportSprite(sprite, fullPath)
    if not sprite then
        return false, "Aucun sprite actif."
    end
    local ok, err =
        pcall(
        function()
            sprite:saveCopyAs(fullPath)
        end
    )
    return ok, err
end

function M.generateMcmeta(packRoot, description, packFormat)
    local mcmetaPath = app.fs.joinPath(packRoot, "pack.mcmeta")
    M.ensureDirRecursive(packRoot)
    local safeDescription = description:gsub('"', '\\"')
    local content =
        string.format(
        '{\n  "pack": {\n    "pack_format": %d,\n    "description": "%s"\n  }\n}\n',
        packFormat,
        safeDescription
    )
    local file, err = io.open(mcmetaPath, "wb")
    if not file then
        return false, "Impossible d'écrire pack.mcmeta : " .. tostring(err)
    end
    file:write(content)
    file:close()
    return true, mcmetaPath
end

-- === Point 3 : copie de l'icône du pack ===
-- Simple copie binaire (io.open en mode "rb"/"wb"), fonctionne pour n'importe
-- quel PNG. Ne redimensionne PAS l'image : recommande à l'utilisateur de
-- fournir directement une image 128x128 ou 256x256 (pas de garantie de
-- résultat correct sinon, mais Minecraft accepte diverses tailles).
function M.copyPackIcon(sourceImagePath, packRoot)
    if not sourceImagePath or sourceImagePath == "" then
        return false, "Aucune image sélectionnée."
    end
    if not app.fs.isFile(sourceImagePath) then
        return false, "Fichier source introuvable."
    end

    M.ensureDirRecursive(packRoot)
    local destPath = app.fs.joinPath(packRoot, "pack.png")

    local srcFile, err1 = io.open(sourceImagePath, "rb")
    if not srcFile then
        return false, "Lecture impossible : " .. tostring(err1)
    end
    local data = srcFile:read("*a")
    srcFile:close()

    local dstFile, err2 = io.open(destPath, "wb")
    if not dstFile then
        return false, "Écriture impossible : " .. tostring(err2)
    end
    dstFile:write(data)
    dstFile:close()

    return true, destPath
end

return M
