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

-- === Point 4: "Lightweight" export ===
-- Creates ONLY the subfolder needed for THIS specific texture
-- (e.g., assets/minecraft/textures/item/), never the full directory tree.
-- This is already guaranteed by design: folders are created just
-- before writing the target file, never upstream/in bulk.
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

-- === Proportional resizing (instead of a forced square) ===
--
-- Logic:
--   1. Read the ACTUAL width/height of the source vanilla image (no assumption
--      of a 16x16 square — an entity can be 64x32, a GUI 256x256, etc.)
--   2. Calculate a multiplier = chosen_resolution / 16
--      (16 = reference vanilla base resolution for ALL
--      categories: it's the value used as a scale, not the final
--      image size).
--   3. Multiply the original width and height by this multiplier,
--      WITHOUT ever forcing a square size.
function M.openVanillaResized(fullPngPath, scale)
    local srcSprite = Sprite {fromFile = fullPngPath}
    if not srcSprite then
        return nil, "Unable to open the vanilla file."
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
        return false, "No active sprite."
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
        return false, "Unable to write pack.mcmeta: " .. tostring(err)
    end
    file:write(content)
    file:close()
    return true, mcmetaPath
end

-- === Point 3: Pack icon copy ===
-- Simple binary copy (io.open in "rb"/"wb" mode), works for any
-- PNG. Does NOT resize the image: recommends the user to
-- provide a 128x128 or 256x256 image directly (otherwise no guarantee
-- of correct results, though Minecraft accepts various sizes).
function M.copyPackIcon(sourceImagePath, packRoot)
    if not sourceImagePath or sourceImagePath == "" then
        return false, "No image selected."
    end
    if not app.fs.isFile(sourceImagePath) then
        return false, "Source file not found."
    end

    M.ensureDirRecursive(packRoot)
    local destPath = app.fs.joinPath(packRoot, "pack.png")

    local srcFile, err1 = io.open(sourceImagePath, "rb")
    if not srcFile then
        return false, "Cannot read: " .. tostring(err1)
    end
    local data = srcFile:read("*a")
    srcFile:close()

    local dstFile, err2 = io.open(destPath, "wb")
    if not dstFile then
        return false, "Cannot write: " .. tostring(err2)
    end
    dstFile:write(data)
    dstFile:close()

    return true, destPath
end

return M