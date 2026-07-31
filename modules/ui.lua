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
            app.alert("No active sprite.")
            return false
        end
        if State.packPath == "" then
            app.alert("Specify the destination folder.")
            return false
        end
        local itemId = dlg.data.itemName
        if not itemId or itemId == "" then
            app.alert("Specify a file name.")
            return false
        end
        local exportProfile = currentExportProfile()
        local catDef = currentCategoryDef()
        local fullPath = Export.buildTexturePath(State.packPath, exportProfile, catDef, itemId)
        local ok, err = Export.exportSprite(sprite, fullPath)
        if ok then
            app.alert("Exported: " .. fullPath)
            return true
        else
            app.alert("Export error: " .. tostring(err))
            return false
        end
    end

    local function refreshItemList()
        local profile = currentSourceProfile()
        local catDef = currentCategoryDef()
        local items = Scanner.scanCategory(State.vanillaPath, profile, catDef)
        local options = items
        if #options == 0 then options = {"(no textures)"} end
        dlg:modify {id = "item", options = options}
        dlg:modify {id = "scanInfo", text = string.format("%d texture(s) available", #items)}
        if #items > 0 then
            State.item = items[1]
            dlg:modify {id = "itemName", text = items[1]}
        else
            State.item = nil
        end
    end

    local function doEditItem(itemId, previousItemId)
        if not itemId or itemId == "" or itemId == "(no textures)" then return end
        if isSpriteValid(lastOpenedSprite) then
            if lastOpenedSprite.isModified then
                local choice = app.alert {
                    title = "Unsaved Changes",
                    text = {
                        "The current image has been modified.",
                        "Do you want to save it before overwriting?"
                    },
                    buttons = {"Save and Export", "Discard Changes", "Cancel"}
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
                if not spr then error(openErr or "Unknown opening error.") end
                newSprite = spr
            else
                newSprite = Export.createBlankSprite(State.resolution)
            end
            lastOpenedSprite = newSprite
        end)
        if not ok then app.alert("Unable to open '" .. tostring(itemId) .. "': " .. tostring(err)) end
    end

    local function refreshInstalledVersions()
        local list = Extractor.scanInstalledVersions(State.mcRoot)
        if #list == 0 then
            dlg:modify {id = "baseVersion", options = {"(no versions detected)"}}
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
        label = "Pack Version:",
        option = State.exportVersion,
        options = McData.order,
        onchange = function() State.exportVersion = dlg.data.exportVersion end
    }

    dlg:combobox {
        id = "resolution",
        label = "Resolution:",
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
        label = "GUIs / Entities Scale:",
        option = State.guiEntityScale,
        options = {"1x", "2x", "4x", "6x", "8x", "10x"},
        onchange = function() State.guiEntityScale = dlg.data.guiEntityScale end
    }

    dlg:check {
        id = "showSetup",
        text = "Source Configuration (vanilla .jar)",
        selected = true,
        onclick = function() setGroupVisible(setupWidgetIds, dlg.data.showSetup) end
    }

    dlg:entry {
        id = "mcRoot",
        label = ".minecraft:",
        text = State.mcRoot,
        onchange = function() State.mcRoot = dlg.data.mcRoot end
    }

    dlg:button {
        id = "detectMc",
        text = "Detect + Scan Versions",
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
        label = "Installed Version to Extract:",
        option = State.baseVersion,
        options = {"(click Detect)"},
        onchange = function() State.baseVersion = dlg.data.baseVersion end
    }

    dlg:button {
        id = "extractBtn",
        text = "Extract Textures",
        onclick = function()
            local ok, result = Extractor.extractTextures(State.mcRoot, State.baseVersion, State.cacheBaseDir)
            if ok then
                State.vanillaPath = result
                dlg:modify {id = "extractStatus", text = "✓ Textures extracted successfully."}
                refreshItemList()
            else
                dlg:modify {id = "extractStatus", text = "✗ Failed (see popup)."}
                app.alert(result)
            end
        end
    }

    dlg:label {id = "extractStatus", label = "", text = "No extraction performed."}

    dlg:check {
        id = "showDest",
        text = "Pack Destination Folder",
        selected = true,
        onclick = function() setGroupVisible(destWidgetIds, dlg.data.showDest) end
    }

    dlg:entry {
        id = "packPath",
        label = "Destination:",
        text = State.packPath,
        onchange = function()
            State.packPath = dlg.data.packPath
            local shortName = app.fs.fileTitle(State.packPath)
            dlg:modify {id = "packPathShort", text = "Active Pack: " .. (shortName ~= "" and shortName or "(not set)")}
        end
    }

    dlg:file {
        id = "packBrowse",
        label = "",
        text = "Browse...",
        title = "Select a file at the root of the destination resource pack",
        open = true,
        onchange = function()
            local picked = dlg.data.packBrowse
            if picked and picked ~= "" then
                State.packPath = app.fs.filePath(picked)
                dlg:modify {id = "packPath", text = State.packPath}
                local shortName = app.fs.fileTitle(State.packPath)
                dlg:modify {id = "packPathShort", text = "Active Pack: " .. (shortName ~= "" and shortName or "(not set)")}
            end
        end
    }

    dlg:label {id = "packPathShort", label = "", text = "Active Pack: (not set)"}

    dlg:separator {text = "Catalog"}

    dlg:combobox {
        id = "category",
        label = "Category:",
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
        label = "Element:",
        option = "",
        options = {"(configure source above)"},
        onchange = function()
            local previousItemId = State.item
            local selected = dlg.data.item
            State.item = selected
            dlg:modify {id = "itemName", text = selected}
            doEditItem(selected, previousItemId)
        end
    }

    dlg:label {id = "scanInfo", label = "", text = "0 texture(s) available"}

    dlg:entry {
        id = "itemName",
        label = "File Name:",
        text = State.item or ""
    }

    dlg:separator {text = "Export"}

    dlg:button {
        id = "exportBtn",
        text = "Save and Export",
        onclick = function() doExportCurrentSprite(app.activeSprite) end
    }

    dlg:file {
        id = "packIconFile",
        label = "Icon (pack.png):",
        title = "Choose a PNG image (ideally 128x128 or 256x256)",
        open = true
    }

    dlg:button {
        id = "copyIconBtn",
        text = "Copy as pack.png",
        onclick = function()
            if State.packPath == "" then
                app.alert("Specify the destination folder.")
                return
            end
            local ok, result = Export.copyPackIcon(dlg.data.packIconFile, State.packPath)
            if ok then
                app.alert("pack.png created: " .. result)
            else
                app.alert("Error: " .. tostring(result))
            end
        end
    }

    dlg:separator {text = "pack.mcmeta"}

    dlg:entry {
        id = "description",
        label = "Description:",
        text = State.description,
        onchange = function() State.description = dlg.data.description end
    }

    dlg:button {
        id = "mcmetaBtn",
        text = "Generate pack.mcmeta",
        onclick = function()
            if State.packPath == "" then
                app.alert("Specify the destination folder.")
                return
            end
            local packFormat = currentExportProfile().pack_format
            local ok, result = Export.generateMcmeta(State.packPath, dlg.data.description, packFormat)
            if ok then
                app.alert("pack.mcmeta generated (pack_format=" .. packFormat .. ").")
            else
                app.alert("Error: " .. tostring(result))
            end
        end
    }

    local shown = pcall(function() dlg:show {wait = false, bounds = Rectangle(900, 40, 380, 780)} end)
    if not shown then dlg:show {wait = false} end
end