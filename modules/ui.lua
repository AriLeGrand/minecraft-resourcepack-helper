-- modules/ui.lua
return function(plugin, State, McData, Scanner, Export, Extractor)
    local dlg

    local lastOpenedSprite = nil

    local function isSpriteValid(spr)
        if not spr then return false end
        local ok = pcall(function() return spr.width end)
        return ok
    end

    local function setGroupVisible(ids, visible)
        for _, id in ipairs(ids) do
            dlg:modify {id = id, visible = visible}
        end
    end

    local setupWidgetIds = {"mcRoot", "detectMc", "baseVersion", "extractBtn", "extractStatus"}
    local destWidgetIds = {"packPath", "packBrowse"}

    local function currentExportProfile()
        return McData.versions[State.exportVersion]
    end

    local function currentCategoryDef()
        for _, c in ipairs(McData.categories) do
            if c.key == State.category then
                return c
            end
        end
        return McData.categories[1]
    end

    local function currentSourceProfile()
        return McData.guessFolderStyle(State.baseVersion or "")
    end

    local function currentResizeScale(categoryDef)
        if categoryDef.key == "GUI" or categoryDef.key == "Entities" then
            local scaleText = State.guiEntityScale or "1x"
            return tonumber(scaleText:match("^(%d+)x$")) or 1
        end
        return (State.resolution or 16) / 16
    end

    local function doExportCurrentSprite(sprite)
        if not sprite then
            app.alert("Aucun sprite actif.")
            return false
        end
        if State.packPath == "" then
            app.alert("Renseigne le dossier de destination.")
            return false
        end
        local itemId = dlg.data.itemName
        if not itemId or itemId == "" then
            app.alert("Renseigne un nom de fichier.")
            return false
        end
        local exportProfile = currentExportProfile()
        local catDef = currentCategoryDef()
        local fullPath = Export.buildTexturePath(State.packPath, exportProfile, catDef, itemId)
        local ok, err = Export.exportSprite(sprite, fullPath)
        if ok then
            app.alert("Exporté : " .. fullPath)
            return true
        else
            app.alert("Erreur export : " .. tostring(err))
            return false
        end
    end

    local function refreshItemList()
        local profile = currentSourceProfile()
        local catDef = currentCategoryDef()
        local items = Scanner.scanCategory(State.vanillaPath, profile, catDef)
        local options = items
        if #options == 0 then options = {"(aucune texture)"} end
        dlg:modify {id = "item", options = options}
        dlg:modify {id = "scanInfo", text = string.format("%d texture(s) disponibles", #items)}
        if #items > 0 then
            State.item = items[1]
            dlg:modify {id = "itemName", text = items[1]}
        else
            State.item = nil
        end
    end

    local function doEditItem(itemId, previousItemId)
        if not itemId or itemId == "" or itemId == "(aucune texture)" then return end
        if isSpriteValid(lastOpenedSprite) then
            if lastOpenedSprite.isModified then
                local choice = app.alert {
                    title = "Modifications non sauvegardées",
                    text = {
                        "L'image actuelle a été modifiée.",
                        "Voulez-vous la sauvegarder avant de l'écraser ?"
                    },
                    buttons = {"Sauvegarder et Exporter", "Ignorer les modifications", "Annuler"}
                }
                if choice == 3 or choice == 0 or choice == nil then
                    State.item = previousItemId
                    dlg:modify {id = "item", option = previousItemId}
                    dlg:modify {id = "itemName", text = previousItemId or ""}
                    return
                elseif choice == 1 then
                    local exported = doExportCurrentSprite(lastOpenedSprite)
                    if not exported then
                        State.item = previousItemId
                        dlg:modify {id = "item", option = previousItemId}
                        return
                    end
                end
            end
            pcall(function() lastOpenedSprite:close() end)
            lastOpenedSprite = nil
        end

        local ok, err = pcall(function()
            local profile = currentSourceProfile()
            local catDef = currentCategoryDef()
            local items, basePath = Scanner.scanCategory(State.vanillaPath, profile, catDef)
            local fullVanillaPath = nil
            for _, id in ipairs(items) do
                if id == itemId then
                    fullVanillaPath = app.fs.joinPath(basePath, itemId .. ".png")
                    break
                end
            end
            local newSprite
            if fullVanillaPath and app.fs.isFile(fullVanillaPath) then
                local scale = currentResizeScale(catDef)
                local spr, openErr = Export.openVanillaResized(fullVanillaPath, scale)
                if not spr then error(openErr or "Erreur d'ouverture inconnue.") end
                newSprite = spr
            else
                newSprite = Export.createBlankSprite(State.resolution)
            end
            lastOpenedSprite = newSprite
        end)
        if not ok then app.alert("Impossible d'ouvrir '" .. tostring(itemId) .. "' :" .. tostring(err)) end
    end

    local function refreshInstalledVersions()
        local list = Extractor.scanInstalledVersions(State.mcRoot)
        if #list == 0 then
            dlg:modify {id = "baseVersion", options = {"(aucune version détectée)"}}
        else
            dlg:modify {id = "baseVersion", options = list}
            State.baseVersion = list[#list]
            dlg:modify {id = "baseVersion", option = State.baseVersion}
        end
    end

    dlg = Dialog {title = "MC Resource Pack"}
    dlg:separator {text = "Minecraft Resource Pack Helper"}

    dlg:combobox {
        id = "exportVersion",
        label = "Version du pack :",
        option = State.exportVersion,
        options = McData.order,
        onchange = function() State.exportVersion = dlg.data.exportVersion end
    }

    dlg:combobox {
        id = "resolution",
        label = "Résolution :",
        option = tostring(State.resolution),
        options = (function()
            local t = {}
            for _, r in ipairs(McData.resolutions) do table.insert(t, tostring(r)) end
            return t
        end)(),
        onchange = function() State.resolution = tonumber(dlg.data.resolution) end
    }

    dlg:combobox {
        id = "guiEntityScale",
        label = "Échelle GUIs / Entités :",
        option = State.guiEntityScale,
        options = {"1x", "2x", "4x", "6x", "8x", "10x"},
        onchange = function() State.guiEntityScale = dlg.data.guiEntityScale end
    }

    dlg:check {
        id = "showSetup",
        text = "Configuration source (.jar vanilla)",
        selected = true,
        onclick = function() setGroupVisible(setupWidgetIds, dlg.data.showSetup) end
    }

    dlg:entry {
        id = "mcRoot",
        label = ".minecraft :",
        text = State.mcRoot,
        onchange = function() State.mcRoot = dlg.data.mcRoot end
    }

    dlg:button {
        id = "detectMc",
        text = "Détecter + scanner mes versions",
        onclick = function()
            local detected = Extractor.detectDefaultMinecraftDir()
            if detected ~= "" then
                State.mcRoot = detected
                dlg:modify {id = "mcRoot", text = detected}
            end
            refreshInstalledVersions()
        end
    }

    dlg:combobox {
        id = "baseVersion",
        label = "Version installée à extraire :",
        option = State.baseVersion,
        options = {"(clique sur Détecter)"},
        onchange = function() State.baseVersion = dlg.data.baseVersion end
    }

    dlg:button {
        id = "extractBtn",
        text = "Extraire les textures",
        onclick = function()
            local ok, result = Extractor.extractTextures(State.mcRoot, State.baseVersion, State.cacheBaseDir)
            if ok then
                State.vanillaPath = result
                dlg:modify {id = "extractStatus", text = "✓ Textures extraites avec succès."}
                refreshItemList()
            else
                dlg:modify {id = "extractStatus", text = "✗ Échec (voir popup)."}
                app.alert(result)
            end
        end
    }

    dlg:label {id = "extractStatus", label = "", text = "Aucune extraction effectuée."}

    dlg:check {
        id = "showDest",
        text = "Dossier de destination du pack",
        selected = true,
        onclick = function() setGroupVisible(destWidgetIds, dlg.data.showDest) end
    }

    dlg:entry {
        id = "packPath",
        label = "Destination :",
        text = State.packPath,
        onchange = function()
            State.packPath = dlg.data.packPath
            local shortName = app.fs.fileTitle(State.packPath)
            dlg:modify {id = "packPathShort", text = "Pack actif : " .. (shortName ~= "" and shortName or "(non défini)")}
        end
    }

    dlg:file {
        id = "packBrowse",
        label = "",
        text = "Parcourir...",
        title = "Sélectionne un fichier à la racine du pack de destination",
        open = true,
        onchange = function()
            local picked = dlg.data.packBrowse
            if picked and picked ~= "" then
                State.packPath = app.fs.filePath(picked)
                dlg:modify {id = "packPath", text = State.packPath}
                local shortName = app.fs.fileTitle(State.packPath)
                dlg:modify {id = "packPathShort", text = "Pack actif : " .. (shortName ~= "" and shortName or "(non défini)")}
            end
        end
    }

    dlg:label {id = "packPathShort", label = "", text = "Pack actif : (non défini)"}

    dlg:separator {text = "Catalogue"}

    dlg:combobox {
        id = "category",
        label = "Catégorie :",
        option = State.category,
        options = (function()
            local t = {}
            for _, c in ipairs(McData.categories) do table.insert(t, c.key) end
            return t
        end)(),
        onchange = function()
            State.category = dlg.data.category
            refreshItemList()
        end
    }

    dlg:combobox {
        id = "item",
        label = "Élément :",
        option = "",
        options = {"(configure la source ci-dessus)"},
        onchange = function()
            local previousItemId = State.item
            local selected = dlg.data.item
            State.item = selected
            dlg:modify {id = "itemName", text = selected}
            doEditItem(selected, previousItemId)
        end
    }

    dlg:label {id = "scanInfo", label = "", text = "0 texture(s) disponibles"}

    dlg:entry {
        id = "itemName",
        label = "Nom du fichier :",
        text = State.item or ""
    }

    dlg:separator {text = "Export"}

    dlg:button {
        id = "exportBtn",
        text = "Sauvegarder et Exporter",
        onclick = function() doExportCurrentSprite(app.activeSprite) end
    }

    dlg:file {
        id = "packIconFile",
        label = "Icône (pack.png) :",
        title = "Choisis une image PNG (idéalement 128x128 ou 256x256)",
        open = true
    }

    dlg:button {
        id = "copyIconBtn",
        text = "Copier comme pack.png",
        onclick = function()
            if State.packPath == "" then
                app.alert("Renseigne le dossier de destination.")
                return
            end
            local ok, result = Export.copyPackIcon(dlg.data.packIconFile, State.packPath)
            if ok then
                app.alert("pack.png créé : " .. result)
            else
                app.alert("Erreur : " .. tostring(result))
            end
        end
    }

    dlg:separator {text = "pack.mcmeta"}

    dlg:entry {
        id = "description",
        label = "Description :",
        text = State.description,
        onchange = function() State.description = dlg.data.description end
    }

    dlg:button {
        id = "mcmetaBtn",
        text = "Générer pack.mcmeta",
        onclick = function()
            if State.packPath == "" then
                app.alert("Renseigne le dossier de destination.")
                return
            end
            local packFormat = currentExportProfile().pack_format
            local ok, result = Export.generateMcmeta(State.packPath, dlg.data.description, packFormat)
            if ok then
                app.alert("pack.mcmeta généré (pack_format=" .. packFormat .. ").")
            else
                app.alert("Erreur : " .. tostring(result))
            end
        end
    }

    local shown = pcall(function() dlg:show {wait = false, bounds = Rectangle(900, 40, 380, 780)} end)
    if not shown then dlg:show {wait = false} end
end
