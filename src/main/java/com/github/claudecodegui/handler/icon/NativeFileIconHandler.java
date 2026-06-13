package com.github.claudecodegui.handler.icon;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Iconable;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.IconUtil;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.imageio.ImageIO;
import javax.swing.Icon;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Resolves native IntelliJ file icons for the webview.
 *
 * The webview cannot access Swing Icons or VirtualFiles directly. This handler
 * asks the IntelliJ Platform for the icon that belongs to a real file, PSI-backed
 * file, or file type and returns a small PNG data URL to the frontend.
 */
public class NativeFileIconHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(NativeFileIconHandler.class);
    private static final Gson GSON = new Gson();
    private static final String TYPE_RESOLVE_NATIVE_FILE_ICONS = "resolve_native_file_icons";
    private static final int ICON_FLAGS = Iconable.ICON_FLAG_VISIBILITY | Iconable.ICON_FLAG_READ_STATUS;
    private static final int FALLBACK_ICON_SIZE = 16;
    private static final int ICON_CACHE_MAX_ENTRIES = 512;

    /**
     * Bounded LRU cache of rendered icons, keyed by (path|fileName|isDirectory).
     * Rendering an icon (paintIcon -> PNG -> base64) is comparatively expensive and
     * the same items recur across tool lists and dropdowns within a session, so we
     * memoize the encoded result to avoid re-encoding identical icons repeatedly.
     */
    private static final Map<String, IconImage> ICON_CACHE = Collections.synchronizedMap(
            new LinkedHashMap<String, IconImage>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, IconImage> eldest) {
                    return size() > ICON_CACHE_MAX_ENTRIES;
                }
            });

    public NativeFileIconHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return new String[] { TYPE_RESOLVE_NATIVE_FILE_ICONS };
    }

    @Override
    public boolean handle(String type, String content) {
        if (!TYPE_RESOLVE_NATIVE_FILE_ICONS.equals(type)) {
            return false;
        }
        handleResolveIcons(content);
        return true;
    }

    private void handleResolveIcons(String content) {
        CompletableFuture.runAsync(() -> {
            JsonObject response = new JsonObject();
            JsonArray icons = new JsonArray();
            response.add("icons", icons);

            try {
                JsonObject request = parseRequest(content);
                JsonArray items = request.has("items") && request.get("items").isJsonArray()
                        ? request.getAsJsonArray("items")
                        : new JsonArray();

                for (JsonElement element : items) {
                    if (!element.isJsonObject()) {
                        continue;
                    }
                    JsonObject item = element.getAsJsonObject();
                    icons.add(resolveItem(item));
                }
            } catch (Exception e) {
                LOG.warn("Failed to resolve native file icons: " + e.getMessage(), e);
                response.addProperty("error", "resolve_failed");
            }

            String json = GSON.toJson(response);
            ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.onNativeFileIconsResolved", escapeJs(json))
            );
        }, AppExecutorUtil.getAppExecutorService());
    }

    private JsonObject parseRequest(String content) {
        if (content == null || content.trim().isEmpty()) {
            return new JsonObject();
        }
        return GSON.fromJson(content, JsonObject.class);
    }

    private JsonObject resolveItem(JsonObject item) {
        String id = getString(item, "id");
        String filePath = getString(item, "path");
        String fileName = getString(item, "fileName");
        boolean directory = getBoolean(item, "isDirectory");

        JsonObject result = new JsonObject();
        result.addProperty("id", id);

        IconImage iconImage = resolveIconImage(filePath, fileName, directory);
        if (iconImage != null) {
            result.addProperty("dataUrl", iconImage.dataUrl);
            result.addProperty("width", iconImage.width);
            result.addProperty("height", iconImage.height);
        }
        return result;
    }

    private IconImage resolveIconImage(String filePath, String fileName, boolean directory) {
        String cacheKey = (filePath == null ? "" : filePath) + '|'
                + (fileName == null ? "" : fileName) + '|' + directory;

        IconImage cached = ICON_CACHE.get(cacheKey);
        if (cached != null) {
            return cached;
        }

        IconImage iconImage = renderIcon(resolveIcon(filePath, fileName, directory));
        if (iconImage != null) {
            ICON_CACHE.put(cacheKey, iconImage);
        }
        return iconImage;
    }

    private Icon resolveIcon(String filePath, String fileName, boolean directory) {
        Project project = context.getProject();
        VirtualFile virtualFile = findVirtualFile(project, filePath);
        if (virtualFile != null) {
            try {
                return IconUtil.getIcon(virtualFile, ICON_FLAGS, project);
            } catch (Exception e) {
                LOG.debug("IconUtil failed for " + filePath + ": " + e.getMessage());
            }
        }

        if (directory) {
            return AllIcons.Nodes.Folder;
        }

        String resolvedName = firstNonBlank(fileName, filePath);
        if (resolvedName != null) {
            try {
                FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(new File(resolvedName).getName());
                Icon typeIcon = fileType.getIcon();
                if (typeIcon != null) {
                    return typeIcon;
                }
            } catch (Exception e) {
                LOG.debug("FileType icon lookup failed for " + resolvedName + ": " + e.getMessage());
            }
        }

        return AllIcons.FileTypes.Any_type;
    }

    private VirtualFile findVirtualFile(Project project, String path) {
        if (path == null || path.trim().isEmpty()) {
            return null;
        }

        String normalized = path.trim().replace('\\', '/');
        File file = new File(normalized);
        if (!file.isAbsolute() && project != null && project.getBasePath() != null) {
            file = new File(project.getBasePath(), normalized);
        }

        try {
            return LocalFileSystem.getInstance().findFileByIoFile(file);
        } catch (Exception e) {
            LOG.debug("VirtualFile lookup failed for " + path + ": " + e.getMessage());
            return null;
        }
    }

    private IconImage renderIcon(Icon icon) {
        if (icon == null) {
            return null;
        }

        int width = Math.max(FALLBACK_ICON_SIZE, icon.getIconWidth());
        int height = Math.max(FALLBACK_ICON_SIZE, icon.getIconHeight());
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            int x = Math.max(0, (width - icon.getIconWidth()) / 2);
            int y = Math.max(0, (height - icon.getIconHeight()) / 2);
            icon.paintIcon(null, graphics, x, y);
        } finally {
            graphics.dispose();
        }

        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", out);
            String base64 = Base64.getEncoder().encodeToString(out.toByteArray());
            return new IconImage("data:image/png;base64," + base64, width, height);
        } catch (Exception e) {
            LOG.warn("Failed to encode native file icon: " + e.getMessage(), e);
            return null;
        }
    }

    private static String getString(JsonObject object, String key) {
        if (!object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static boolean getBoolean(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() && object.get(key).getAsBoolean();
    }

    private static String firstNonBlank(String first, String second) {
        if (first != null && !first.trim().isEmpty()) {
            return first;
        }
        if (second != null && !second.trim().isEmpty()) {
            return second;
        }
        return null;
    }

    private static final class IconImage {
        private final String dataUrl;
        private final int width;
        private final int height;

        private IconImage(String dataUrl, int width, int height) {
            this.dataUrl = dataUrl;
            this.width = width;
            this.height = height;
        }
    }
}
