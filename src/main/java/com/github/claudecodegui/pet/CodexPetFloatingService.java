package com.github.claudecodegui.pet;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.WindowManager;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.imageio.ImageIO;
import javax.swing.ImageIcon;
import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JLayeredPane;
import javax.swing.JWindow;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import java.awt.AlphaComposite;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Composite;
import java.awt.Cursor;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.IllegalComponentStateException;
import java.awt.Point;
import java.awt.RenderingHints;
import java.awt.Rectangle;
import java.awt.Window;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseMotionAdapter;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/** Project-scoped pet rendered above the whole IDE frame. */
@State(name = "CodexPetFloatingState", storages = @Storage("codexPetFloating.xml"))
@Service(Service.Level.PROJECT)
public final class CodexPetFloatingService
        implements PersistentStateComponent<CodexPetFloatingService.PetState>, Disposable {

    private static final Logger LOG = Logger.getInstance(CodexPetFloatingService.class);
    private static final Gson GSON = new GsonBuilder().create();
    private static final String GLOBAL_STATE_KEY = "claudecodegui.codexPetFloating.globalState";
    private static final AtomicLong GLOBAL_STATE_VERSION = new AtomicLong();
    private static final Set<CodexPetFloatingService> INSTANCES =
            Collections.newSetFromMap(new WeakHashMap<>());
    public static final String SCOPE_PROJECT = "project";
    public static final String SCOPE_GLOBAL = "global";
    private static final int MIN_SIZE = 32;
    private static final int MAX_SIZE = 512;
    private static final double MIN_OPACITY = 0.3d;
    private static final long MAX_IMAGE_BYTES = 4L * 1024L * 1024L;
    private static final double DEFAULT_X = 0.88d;
    private static final double DEFAULT_Y = 0.78d;
    private static final long SOURCE_TIMEOUT_MILLIS = 35_000L;
    private static final long SOURCE_PRUNE_INTERVAL_MILLIS = 5_000L;
    private static final int MIN_CONNECT_TIMEOUT_SECONDS = 5;
    private static final int MAX_CONNECT_TIMEOUT_SECONDS = 300;
    private static final int MIN_REQUEST_TIMEOUT_SECONDS = 10;
    private static final int MAX_REQUEST_TIMEOUT_SECONDS = 300;
    private static final int MIN_RETRY_ATTEMPTS = 0;
    private static final int MAX_RETRY_ATTEMPTS = 10;
    private static final int MIN_BUBBLE_DURATION_SECONDS = 1;
    private static final int MAX_BUBBLE_DURATION_SECONDS = 20;
    private static final int DEFAULT_BUBBLE_DURATION_SECONDS = 4;
    private static final int MAX_BUBBLE_TEMPLATE_COUNT = 10;
    private static final int MAX_BUBBLE_TEMPLATE_LENGTH = 120;
    private static final int BUBBLE_GAP = 8;
    private static final String DEFAULT_TAB_TITLE = "Current session";
    private static final String[] BUBBLE_EVENTS = {
        "task_started", "thinking", "running", "task_success", "task_error", "idle"
    };
    public static final int MIN_CATALOG_PAGE_SIZE = 12;
    public static final int MAX_CATALOG_PAGE_SIZE = 48;
    public static final int DEFAULT_CATALOG_PAGE_SIZE = 12;
    public static final String DEFAULT_CATALOG_SORT = "default";
    private static final String PET_COMPONENT_KEY = "claudecodegui.codexPetComponent";
    private static final String PET_WINDOW_KEY = "claudecodegui.codexPetWindow";
    private static final String PET_OWNER_KEY = "claudecodegui.codexPetOwner";
    private static final Integer PET_LAYER = Integer.valueOf(Integer.MAX_VALUE - 1);

    private final Project project;
    private final AtomicLong assetGeneration = new AtomicLong();
    private final Map<String, VisualState> sourceStates = new HashMap<>();
    private final Map<String, Long> sourceLastSeen = new HashMap<>();
    private final Map<String, Boolean> sourceActive = new HashMap<>();
    private final Timer animationTimer;
    private final ComponentAdapter paneResizeListener;
    private final ComponentAdapter frameMoveListener;
    private final WindowAdapter frameActivationListener;
    private PetState state = new PetState();
    private PetState globalState;
    private long observedGlobalStateVersion = -1L;
    private JLayeredPane layeredPane;
    private JFrame attachedFrame;
    private JWindow overlayWindow;
    private PetComponent petComponent;
    private int petX;
    private int petY;
    private LoadedPet loadedPet;
    private volatile ActiveBubble activeBubble;
    private volatile VisualState visualState = VisualState.IDLE;
    private volatile int animationFrame;
    private long lastSourcePrune;

    public CodexPetFloatingService(@NotNull Project project) {
        this.project = Objects.requireNonNull(project, "project");
        this.animationTimer = new Timer(140, event -> advanceAnimation());
        this.animationTimer.setRepeats(true);
        this.paneResizeListener = new ComponentAdapter() {
            @Override
            public void componentResized(ComponentEvent event) {
                positionPetFromState();
            }
        };
        this.frameMoveListener = new ComponentAdapter() {
            @Override
            public void componentMoved(ComponentEvent event) {
                positionPetFromState();
            }

            @Override
            public void componentResized(ComponentEvent event) {
                positionPetFromState();
            }
        };
        this.frameActivationListener = new WindowAdapter() {
            @Override
            public void windowActivated(WindowEvent event) {
                updateOverlayZOrder(true);
            }

            @Override
            public void windowDeactivated(WindowEvent event) {
                updateOverlayZOrder(false);
            }
        };
        synchronized (INSTANCES) {
            INSTANCES.add(this);
        }
    }

    public static CodexPetFloatingService getInstance(@NotNull Project project) {
        return project.getService(CodexPetFloatingService.class);
    }

    @Override
    public synchronized @Nullable PetState getState() {
        return state;
    }

    @Override
    public synchronized void loadState(@NotNull PetState loadedState) {
        state = sanitizeState(loadedState);
    }

    public synchronized JsonObject snapshot() {
        PetState current = activeState();
        JsonObject result = new JsonObject();
        result.addProperty("enabled", current.enabled);
        result.addProperty("selectedPetId", current.selectedPetId);
        result.addProperty("size", current.size);
        result.addProperty("opacity", current.opacity);
        addProjectPosition(result, state);
        result.addProperty("petdexConnectTimeoutSeconds", current.petdexConnectTimeoutSeconds);
        result.addProperty("petdexRequestTimeoutSeconds", current.petdexRequestTimeoutSeconds);
        result.addProperty("petdexRetryAttempts", current.petdexRetryAttempts);
        result.addProperty("catalogColumns", current.catalogColumns);
        result.addProperty("catalogPageSize", current.catalogPageSize);
        result.addProperty("catalogSort", current.catalogSort);
        result.addProperty("showStatusIndicator", current.showStatusIndicator);
        result.addProperty("bubbleEnabled", current.bubbleEnabled);
        result.addProperty("bubbleDurationSeconds", current.bubbleDurationSeconds);
        result.addProperty("bubbleSize", current.bubbleSize);
        result.addProperty("bubbleShowForBackgroundTabs", current.bubbleShowForBackgroundTabs);
        result.add("bubbleTemplates", bubbleTemplatesToJson(current.bubbleTemplates));
        result.addProperty("scope", state.scope);
        return result;
    }

    static void addProjectPosition(JsonObject result, PetState projectState) {
        // Position belongs to the current project window even when visual settings are global.
        result.addProperty("positionX", projectState.positionX);
        result.addProperty("positionY", projectState.positionY);
    }

    public void refresh() {
        syncComponent();
    }

    private PetState activeState() {
        state.scope = normalizeScope(state.scope);
        return SCOPE_GLOBAL.equals(state.scope) ? globalState() : state;
    }

    private PetState globalState() {
        if (globalState == null) {
            long version = GLOBAL_STATE_VERSION.get();
            globalState = loadGlobalState();
            observedGlobalStateVersion = version;
        }
        return globalState;
    }

    private static PetState loadGlobalState() {
        String json = PropertiesComponent.getInstance().getValue(GLOBAL_STATE_KEY);
        if (json == null || json.isBlank()) {
            PetState defaults = new PetState();
            defaults.scope = SCOPE_GLOBAL;
            return defaults;
        }
        try {
            PetState loaded = GSON.fromJson(json, PetState.class);
            loaded = sanitizeState(loaded);
            loaded.scope = SCOPE_GLOBAL;
            return loaded;
        } catch (RuntimeException e) {
            LOG.warn("[CodexPet] Failed to read global pet state, using defaults: " + e.getMessage());
            PetState defaults = new PetState();
            defaults.scope = SCOPE_GLOBAL;
            return defaults;
        }
    }

    private void persistActiveState() {
        if (SCOPE_GLOBAL.equals(state.scope)) {
            PetState current = globalState();
            current.scope = SCOPE_GLOBAL;
            PropertiesComponent.getInstance().setValue(GLOBAL_STATE_KEY, GSON.toJson(current));
            observedGlobalStateVersion = GLOBAL_STATE_VERSION.incrementAndGet();
            notifyGlobalStateChanged(this, observedGlobalStateVersion);
        }
    }

    private static void notifyGlobalStateChanged(CodexPetFloatingService source, long version) {
        List<CodexPetFloatingService> services;
        synchronized (INSTANCES) {
            services = new ArrayList<>(INSTANCES);
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            for (CodexPetFloatingService service : services) {
                if (service != source) {
                    service.reloadGlobalState(version);
                }
            }
        });
    }

    public static void notifyPetAssetsChanged(CodexPetFloatingService source) {
        List<CodexPetFloatingService> services;
        synchronized (INSTANCES) {
            services = new ArrayList<>(INSTANCES);
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            for (CodexPetFloatingService service : services) {
                if (service != source && !service.project.isDisposed()) {
                    service.reloadSelectedPet();
                }
            }
        });
    }

    private void reloadGlobalState(long version) {
        boolean activeGlobalScope;
        boolean reloadPet;
        synchronized (this) {
            if (observedGlobalStateVersion >= version) {
                return;
            }
            String previousPetId = globalState == null ? null : globalState.selectedPetId;
            globalState = loadGlobalState();
            observedGlobalStateVersion = version;
            activeGlobalScope = SCOPE_GLOBAL.equals(state.scope);
            reloadPet = activeGlobalScope && globalState.enabled
                    && !Objects.equals(previousPetId, globalState.selectedPetId);
        }
        if (!activeGlobalScope || project.isDisposed()) {
            return;
        }
        syncComponent();
        if (reloadPet) {
            reloadSelectedPet();
        }
    }

    public void applyConfig(JsonObject config) {
        Objects.requireNonNull(config, "config");
        String previousPetId;
        boolean reloadPet;
        synchronized (this) {
            previousPetId = activeState().selectedPetId;
            if (config.has("scope")) {
                state.scope = normalizeScope(readString(config, "scope"));
            }
            PetState target = activeState();
            boolean enabled = target.enabled;
            String selectedPetId = target.selectedPetId;
            int size = target.size;
            double opacity = target.opacity;
            int connectTimeout = target.petdexConnectTimeoutSeconds;
            int requestTimeout = target.petdexRequestTimeoutSeconds;
            int retryAttempts = target.petdexRetryAttempts;
            int catalogColumns = target.catalogColumns;
            int catalogPageSize = target.catalogPageSize;
            String catalogSort = target.catalogSort;
            boolean showStatusIndicator = target.showStatusIndicator;
            boolean bubbleEnabled = target.bubbleEnabled;
            int bubbleDurationSeconds = target.bubbleDurationSeconds;
            String bubbleSize = target.bubbleSize;
            boolean bubbleShowForBackgroundTabs = target.bubbleShowForBackgroundTabs;
            Map<String, List<String>> bubbleTemplates = target.bubbleTemplates;
            if (config.has("enabled")) {
                enabled = readBoolean(config, "enabled");
            }
            if (config.has("selectedPetId")) {
                selectedPetId = sanitizePetId(readString(config, "selectedPetId"));
            }
            if (config.has("size")) {
                size = clamp(readInteger(config, "size"), MIN_SIZE, MAX_SIZE);
            }
            if (config.has("opacity")) {
                opacity = clamp(readDouble(config, "opacity"), MIN_OPACITY, 1.0d);
            }
            if (config.has("petdexConnectTimeoutSeconds")) {
                connectTimeout = clamp(readInteger(config, "petdexConnectTimeoutSeconds"),
                        MIN_CONNECT_TIMEOUT_SECONDS, MAX_CONNECT_TIMEOUT_SECONDS);
            }
            if (config.has("petdexRequestTimeoutSeconds")) {
                requestTimeout = clamp(readInteger(config, "petdexRequestTimeoutSeconds"),
                        MIN_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS);
            }
            if (config.has("petdexRetryAttempts")) {
                retryAttempts = clamp(readInteger(config, "petdexRetryAttempts"),
                        MIN_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS);
            }
            if (config.has("catalogColumns")) {
                catalogColumns = clamp(readInteger(config, "catalogColumns"), 3, 6);
            }
            if (config.has("catalogPageSize")) {
                catalogPageSize = normalizeCatalogPageSize(readInteger(config, "catalogPageSize"));
            }
            if (config.has("catalogSort")) {
                catalogSort = normalizeCatalogSort(readString(config, "catalogSort"));
            }
            if (config.has("showStatusIndicator")) {
                showStatusIndicator = readBoolean(config, "showStatusIndicator");
            }
            if (config.has("bubbleEnabled")) {
                bubbleEnabled = readBoolean(config, "bubbleEnabled");
            }
            if (config.has("bubbleDurationSeconds")) {
                bubbleDurationSeconds = clamp(readInteger(config, "bubbleDurationSeconds"),
                        MIN_BUBBLE_DURATION_SECONDS, MAX_BUBBLE_DURATION_SECONDS);
            }
            if (config.has("bubbleSize")) {
                bubbleSize = BubbleSize.normalize(readString(config, "bubbleSize")).wireValue;
            }
            if (config.has("bubbleShowForBackgroundTabs")) {
                bubbleShowForBackgroundTabs = readBoolean(config, "bubbleShowForBackgroundTabs");
            }
            if (config.has("bubbleTemplates")) {
                bubbleTemplates = readBubbleTemplates(config.get("bubbleTemplates"), target.bubbleTemplates);
            }
            target.enabled = enabled;
            target.selectedPetId = selectedPetId;
            target.size = size;
            target.opacity = opacity;
            target.petdexConnectTimeoutSeconds = connectTimeout;
            target.petdexRequestTimeoutSeconds = Math.max(connectTimeout, requestTimeout);
            target.petdexRetryAttempts = retryAttempts;
            target.catalogColumns = catalogColumns;
            target.catalogPageSize = catalogPageSize;
            target.catalogSort = catalogSort;
            target.showStatusIndicator = showStatusIndicator;
            target.bubbleEnabled = bubbleEnabled;
            target.bubbleDurationSeconds = bubbleDurationSeconds;
            target.bubbleSize = bubbleSize;
            target.bubbleShowForBackgroundTabs = bubbleShowForBackgroundTabs;
            target.bubbleTemplates = bubbleTemplates;
            persistActiveState();
            reloadPet = !Objects.equals(previousPetId, target.selectedPetId);
        }
        syncComponent();
        if (reloadPet) {
            reloadSelectedPet();
        }
    }

    public void updateActivity(String sourceId, String rawState) {
        updateActivity(sourceId, rawState, true);
    }

    public void updateActivity(String sourceId, String rawState, boolean active) {
        if (sourceId == null || sourceId.isBlank()) {
            return;
        }
        synchronized (this) {
            if ("disposed".equals(rawState)) {
                sourceStates.remove(sourceId);
                sourceLastSeen.remove(sourceId);
                sourceActive.remove(sourceId);
                if (activeBubble != null && sourceId.equals(activeBubble.sourceId)) {
                    activeBubble = null;
                }
            } else {
                boolean wasActive = Boolean.TRUE.equals(sourceActive.get(sourceId));
                if (active && !wasActive) {
                    sourceActive.replaceAll((key, value) -> false);
                    ActiveBubble bubble = activeBubble;
                    if (bubble != null && !sourceId.equals(bubble.sourceId)) {
                        activeBubble = null;
                    }
                }
                sourceStates.put(sourceId, VisualState.fromWireValue(rawState));
                sourceLastSeen.put(sourceId, System.currentTimeMillis());
                sourceActive.put(sourceId, active);
                if (wasActive && !active && activeBubble != null
                        && sourceId.equals(activeBubble.sourceId)
                        && !activeState().bubbleShowForBackgroundTabs) {
                    activeBubble = null;
                }
            }
            VisualState nextState = aggregateVisualState(sourceStates, sourceActive);
            if (nextState != visualState) {
                visualState = nextState;
                animationFrame = 0;
            }
        }
        syncComponent();
    }

    public void showBubble(JsonObject payload) {
        showBubble(payload, null);
    }

    public void showBubble(JsonObject payload, Runnable onActivate) {
        Objects.requireNonNull(payload, "payload");
        ActiveBubble nextBubble;
        synchronized (this) {
            PetState current = activeState();
            if (!current.enabled || !current.bubbleEnabled) {
                return;
            }
            boolean background = payload.has("background")
                    && payload.get("background").isJsonPrimitive()
                    && payload.get("background").getAsJsonPrimitive().isBoolean()
                    && payload.get("background").getAsBoolean();
            if (background && !current.bubbleShowForBackgroundTabs) {
                return;
            }
            String event = normalizeBubbleEvent(readOptionalString(payload, "event"));
            String template = pickBubbleTemplate(current.bubbleTemplates, event);
            String text = renderBubbleTemplate(template, payload);
            if (text.isBlank()) {
                return;
            }
            nextBubble = new ActiveBubble(
                    readOptionalString(payload, "sourceId"),
                    text,
                    bubbleVisualState(event),
                    System.currentTimeMillis() + current.bubbleDurationSeconds * 1000L,
                    onActivate);
            activeBubble = nextBubble;
        }
        syncComponent();
    }

    public synchronized void resetPosition() {
        state.positionX = DEFAULT_X;
        state.positionY = DEFAULT_Y;
        positionPetFromState();
    }

    public void reloadSelectedPet() {
        long generation = assetGeneration.incrementAndGet();
        String petId = selectedPetId();
        if ("builtin".equals(petId)) {
            applyLoadedPet(generation, null);
            return;
        }
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            LoadedPet candidate = loadPet(petId);
            applyLoadedPet(generation, candidate);
        });
    }

    private synchronized String selectedPetId() {
        return activeState().selectedPetId;
    }

    private void syncComponent() {
        Application application = ApplicationManager.getApplication();
        if (application == null) {
            return;
        }
        application.invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            boolean visible;
            synchronized (this) {
                visible = activeState().enabled;
            }
            if (!visible) {
                detachComponent();
                return;
            }
            ensureComponentAttached();
            if (petComponent != null) {
                resizePetSurface();
                positionPetFromState();
                petComponent.setVisible(true);
                petComponent.repaint();
            }
            if (!animationTimer.isRunning()) {
                animationTimer.start();
            }
        });
    }

    private void ensureComponentAttached() {
        JFrame frame = WindowManager.getInstance().getFrame(project);
        if (frame == null || frame.getLayeredPane() == null) {
            LOG.debug("[CodexPet] IDE frame is not ready yet");
            return;
        }
        JLayeredPane targetPane = frame.getLayeredPane();
        if (petComponent != null && layeredPane == targetPane && attachedFrame == frame
                && ((overlayWindow != null && overlayWindow.isDisplayable())
                    || petComponent.getParent() == targetPane)) {
            return;
        }
        detachComponent();
        Object existingOwner = targetPane.getClientProperty(PET_OWNER_KEY);
        if (existingOwner instanceof CodexPetFloatingService && existingOwner != this) {
            LOG.debug("[CodexPet] Another project already owns the pet slot for this IDE frame");
            return;
        }
        layeredPane = targetPane;
        attachedFrame = frame;
        removePreviouslyAttachedPet(targetPane);
        petComponent = new PetComponent();
        overlayWindow = createOverlayWindow(frame, petComponent);
        resizePetSurface();
        if (overlayWindow == null) {
            layeredPane.add(petComponent, PET_LAYER, 0);
        }
        layeredPane.putClientProperty(PET_COMPONENT_KEY, petComponent);
        layeredPane.putClientProperty(PET_WINDOW_KEY, overlayWindow);
        layeredPane.putClientProperty(PET_OWNER_KEY, this);
        layeredPane.addComponentListener(paneResizeListener);
        frame.addComponentListener(frameMoveListener);
        frame.addWindowListener(frameActivationListener);
        positionPetFromState();
        if (overlayWindow != null) {
            overlayWindow.setVisible(true);
        }
        layeredPane.revalidate();
        layeredPane.repaint();
        reloadSelectedPet();
    }

    private void updateOverlayZOrder(boolean ideActive) {
        if (overlayWindow == null) {
            return;
        }
        if (overlayWindow.isAlwaysOnTop() != ideActive) {
            overlayWindow.setAlwaysOnTop(ideActive);
        }
    }

    private static void removePreviouslyAttachedPet(JLayeredPane pane) {
        Object existingWindow = pane.getClientProperty(PET_WINDOW_KEY);
        if (existingWindow instanceof Window) {
            ((Window) existingWindow).dispose();
        }
        Object existing = pane.getClientProperty(PET_COMPONENT_KEY);
        if (existing instanceof JComponent && ((JComponent) existing).getParent() == pane) {
            pane.remove((JComponent) existing);
        }
        pane.putClientProperty(PET_COMPONENT_KEY, null);
        pane.putClientProperty(PET_WINDOW_KEY, null);
    }

    private static @Nullable JWindow createOverlayWindow(JFrame frame, JComponent component) {
        JWindow window = null;
        try {
            window = new JWindow(frame);
            window.setName("CodexPetFloatingOverlay");
            window.setType(Window.Type.POPUP);
            window.setFocusableWindowState(false);
            window.setAutoRequestFocus(false);
            // JCEF is heavyweight; keep the pet native overlay above tool-window content.
            window.setAlwaysOnTop(frame.isActive());
            window.setBackground(new Color(0, 0, 0, 0));
            window.getContentPane().setLayout(null);
            window.getContentPane().setBackground(new Color(0, 0, 0, 0));
            window.getContentPane().add(component);
            return window;
        } catch (Exception e) {
            if (window != null) {
                window.dispose();
            }
            LOG.warn("[CodexPet] Failed to create native overlay window, falling back to Swing layer: "
                    + e.getMessage());
            return null;
        }
    }

    private void detachComponent() {
        if (layeredPane != null) {
            layeredPane.removeComponentListener(paneResizeListener);
            if (attachedFrame != null) {
                attachedFrame.removeComponentListener(frameMoveListener);
                attachedFrame.removeWindowListener(frameActivationListener);
            }
            if (layeredPane.getClientProperty(PET_WINDOW_KEY) == overlayWindow) {
                layeredPane.putClientProperty(PET_WINDOW_KEY, null);
            }
            if (layeredPane.getClientProperty(PET_COMPONENT_KEY) == petComponent) {
                layeredPane.putClientProperty(PET_COMPONENT_KEY, null);
            }
            if (layeredPane.getClientProperty(PET_OWNER_KEY) == this) {
                layeredPane.putClientProperty(PET_OWNER_KEY, null);
            }
            if (petComponent != null && petComponent.getParent() == layeredPane) {
                layeredPane.remove(petComponent);
                layeredPane.repaint();
            }
        }
        if (overlayWindow != null) {
            overlayWindow.dispose();
        }
        overlayWindow = null;
        petComponent = null;
        layeredPane = null;
        attachedFrame = null;
        animationTimer.stop();
    }

    private void resizePetSurface() {
        if (petComponent == null) {
            return;
        }
        int width = componentWidth();
        int height = componentHeight();
        petComponent.setSize(width, height);
        petComponent.setPreferredSize(new java.awt.Dimension(width, height));
        if (overlayWindow != null) {
            overlayWindow.setSize(width, height);
            overlayWindow.getContentPane().setSize(width, height);
        }
    }

    private void positionPetFromState() {
        if (!SwingUtilities.isEventDispatchThread()) {
            ApplicationManager.getApplication().invokeLater(this::positionPetFromState);
            return;
        }
        if (layeredPane == null || petComponent == null) {
            return;
        }
        int maxX = Math.max(0, layeredPane.getWidth() - petDisplayWidth());
        int maxY = Math.max(0, layeredPane.getHeight() - petDisplayHeight());
        double x;
        double y;
        synchronized (this) {
            x = state.positionX;
            y = state.positionY;
        }
        setPetLocation(restoreCoordinate(x, maxX), restoreCoordinate(y, maxY));
    }

    private void moveDraggedPet(int x, int y) {
        if (layeredPane == null || petComponent == null) {
            return;
        }
        int maxX = Math.max(0, layeredPane.getWidth() - petDisplayWidth());
        int maxY = Math.max(0, layeredPane.getHeight() - petDisplayHeight());
        int clampedX = clamp(x, 0, maxX);
        int clampedY = clamp(y, 0, maxY);
        setPetLocation(clampedX, clampedY);
    }

    private void setPetLocation(int x, int y) {
        int offsetX = petOffsetX();
        int offsetY = petOffsetY();
        petX = x;
        petY = y;
        int componentX = x - offsetX;
        int componentY = y - offsetY;
        if (overlayWindow != null) {
            petComponent.setLocation(0, 0);
            try {
                Point paneOnScreen = layeredPane.getLocationOnScreen();
                overlayWindow.setLocation(paneOnScreen.x + componentX, paneOnScreen.y + componentY);
            } catch (IllegalComponentStateException e) {
                overlayWindow.setLocation(componentX, componentY);
            }
        } else {
            petComponent.setLocation(componentX, componentY);
        }
    }

    private void persistCurrentPosition() {
        if (layeredPane == null || petComponent == null) {
            return;
        }
        int maxX = Math.max(0, layeredPane.getWidth() - petDisplayWidth());
        int maxY = Math.max(0, layeredPane.getHeight() - petDisplayHeight());
        synchronized (this) {
            state.positionX = storeCoordinate(petX, maxX);
            state.positionY = storeCoordinate(petY, maxY);
        }
    }

    private LoadedPet loadPet(String petId) {
        try {
            Path root = Path.of(PlatformUtils.getHomeDirectory(), ".codex", "pets");
            if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
                return null;
            }
            Path realRoot = root.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path candidate = realRoot.resolve(petId.replace('/', java.io.File.separatorChar)).normalize();
            if (!candidate.startsWith(realRoot)
                    || !Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(candidate)
                    || Files.size(candidate) > MAX_IMAGE_BYTES) {
                return null;
            }
            Path realCandidate = candidate.toRealPath(LinkOption.NOFOLLOW_LINKS);
            if (!realCandidate.startsWith(realRoot)) {
                return null;
            }
            byte[] bytes = Files.readAllBytes(realCandidate);
            String mimeType = CodexPetImageSupport.detectMimeType(realCandidate, bytes);
            CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, bytes);
            if (!CodexPetImageSupport.hasSafeDimensions(dimensions)
                    || !CodexPetImageSupport.hasSafeFrameBudget(mimeType, bytes)) {
                return null;
            }
            Image image = "image/gif".equals(mimeType)
                    ? new ImageIcon(bytes).getImage()
                    : ImageIO.read(new ByteArrayInputStream(bytes));
            if (image == null) {
                return null;
            }
            boolean spriteSheet = CodexPetImageSupport.isCanonicalPetdexSheet(dimensions);
            return new LoadedPet(image, dimensions.getWidth(), dimensions.getHeight(), spriteSheet);
        } catch (Exception e) {
            LOG.warn("[CodexPet] Failed to load selected pet " + petId + ": " + e.getMessage());
            return null;
        }
    }

    private void applyLoadedPet(long generation, LoadedPet candidate) {
        if (generation != assetGeneration.get()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (generation == assetGeneration.get()) {
                loadedPet = candidate;
                animationFrame = 0;
                repaintPet();
            }
        });
    }

    private void advanceAnimation() {
        boolean sourceExpired = false;
        boolean bubbleExpired = false;
        long now = System.currentTimeMillis();
        synchronized (this) {
            animationFrame++;
            if (activeBubble != null && now >= activeBubble.expiresAtMillis) {
                activeBubble = null;
                bubbleExpired = true;
            }
            if (now - lastSourcePrune >= SOURCE_PRUNE_INTERVAL_MILLIS) {
                lastSourcePrune = now;
                sourceExpired = sourceLastSeen.entrySet().removeIf(
                        entry -> now - entry.getValue() > SOURCE_TIMEOUT_MILLIS);
                if (sourceExpired) {
                    sourceStates.keySet().retainAll(sourceLastSeen.keySet());
                    sourceActive.keySet().retainAll(sourceLastSeen.keySet());
                    visualState = aggregateVisualState(sourceStates, sourceActive);
                }
            }
        }
        if (sourceExpired || bubbleExpired) {
            syncComponent();
        } else {
            repaintPet();
        }
    }

    private void repaintPet() {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (petComponent != null) {
                petComponent.repaint();
            }
        });
    }

    private synchronized int componentWidth() {
        PetState current = activeState();
        ActiveBubble bubble = currentBubble();
        if (bubble == null) {
            return current.size;
        }
        return Math.max(current.size, BubbleSize.normalize(current.bubbleSize).width);
    }

    private synchronized int componentHeight() {
        PetState current = activeState();
        ActiveBubble bubble = currentBubble();
        if (bubble == null) {
            return petDisplayHeight();
        }
        return BubbleSize.normalize(current.bubbleSize).height + BUBBLE_GAP + petDisplayHeight();
    }

    private synchronized int petDisplayWidth() {
        return activeState().size;
    }

    private synchronized int petDisplayHeight() {
        return (int) Math.round((double) activeState().size
                * CodexPetImageSupport.PETDEX_FRAME_HEIGHT / CodexPetImageSupport.PETDEX_FRAME_WIDTH);
    }

    private synchronized float componentOpacity() {
        return (float) activeState().opacity;
    }

    private synchronized int petOffsetX() {
        PetState current = activeState();
        ActiveBubble bubble = currentBubble();
        if (bubble == null) {
            return 0;
        }
        int bubbleWidth = BubbleSize.normalize(current.bubbleSize).width;
        int maxOffset = Math.max(0, bubbleWidth - current.size);
        int idealOffset = Math.max(0, maxOffset / 2);
        if (layeredPane == null) {
            return idealOffset;
        }
        if (petX < idealOffset) {
            return 0;
        }
        if (petX + current.size + (maxOffset - idealOffset) > layeredPane.getWidth()) {
            return maxOffset;
        }
        return idealOffset;
    }

    private synchronized int petOffsetY() {
        PetState current = activeState();
        ActiveBubble bubble = currentBubble();
        if (bubble == null) {
            return 0;
        }
        int bubbleBlockHeight = BubbleSize.normalize(current.bubbleSize).height + BUBBLE_GAP;
        if (layeredPane != null
                && petY < bubbleBlockHeight
                && petY + petDisplayHeight() + bubbleBlockHeight <= layeredPane.getHeight()) {
            return 0;
        }
        return bubbleBlockHeight;
    }

    private synchronized boolean showStatusIndicator() {
        return activeState().showStatusIndicator;
    }

    private synchronized String activeBubbleSize() {
        return activeState().bubbleSize;
    }

    private ActiveBubble currentBubble() {
        ActiveBubble bubble = activeBubble;
        return bubble != null && System.currentTimeMillis() < bubble.expiresAtMillis ? bubble : null;
    }

    private static VisualState aggregateVisualState(Map<String, VisualState> states,
                                                   Map<String, Boolean> activeSources) {
        VisualState activeResult = VisualState.IDLE;
        boolean hasActiveSource = false;
        for (Map.Entry<String, VisualState> entry : states.entrySet()) {
            if (Boolean.TRUE.equals(activeSources.get(entry.getKey()))) {
                hasActiveSource = true;
                if (entry.getValue().priority > activeResult.priority) {
                    activeResult = entry.getValue();
                }
            }
        }
        if (hasActiveSource) {
            return activeResult;
        }
        return VisualState.IDLE;
    }

    static PetState sanitizeState(PetState value) {
        PetState result = value == null ? new PetState() : value;
        result.scope = normalizeScope(result.scope);
        result.selectedPetId = sanitizePetId(result.selectedPetId);
        result.size = clamp(result.size, MIN_SIZE, MAX_SIZE);
        result.opacity = clamp(result.opacity, MIN_OPACITY, 1.0d);
        result.positionX = clamp(result.positionX, 0.0d, 1.0d);
        result.positionY = clamp(result.positionY, 0.0d, 1.0d);
        result.petdexConnectTimeoutSeconds = clamp(result.petdexConnectTimeoutSeconds,
                MIN_CONNECT_TIMEOUT_SECONDS, MAX_CONNECT_TIMEOUT_SECONDS);
        result.petdexRequestTimeoutSeconds = clamp(result.petdexRequestTimeoutSeconds,
                MIN_REQUEST_TIMEOUT_SECONDS, MAX_REQUEST_TIMEOUT_SECONDS);
        result.petdexRequestTimeoutSeconds = Math.max(
                result.petdexConnectTimeoutSeconds, result.petdexRequestTimeoutSeconds);
        result.petdexRetryAttempts = clamp(result.petdexRetryAttempts,
                MIN_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS);
        result.catalogColumns = clamp(result.catalogColumns, 3, 6);
        result.catalogPageSize = normalizeCatalogPageSize(result.catalogPageSize);
        result.catalogSort = normalizeCatalogSort(result.catalogSort);
        result.bubbleDurationSeconds = clamp(result.bubbleDurationSeconds,
                MIN_BUBBLE_DURATION_SECONDS, MAX_BUBBLE_DURATION_SECONDS);
        result.bubbleSize = BubbleSize.normalize(result.bubbleSize).wireValue;
        result.bubbleTemplates = sanitizeBubbleTemplates(result.bubbleTemplates);
        return result;
    }

    public static String normalizeScope(String value) {
        return SCOPE_GLOBAL.equals(value) ? SCOPE_GLOBAL : SCOPE_PROJECT;
    }

    private static JsonObject bubbleTemplatesToJson(Map<String, List<String>> templates) {
        JsonObject result = new JsonObject();
        Map<String, List<String>> safeTemplates = sanitizeBubbleTemplates(templates);
        for (String event : BUBBLE_EVENTS) {
            JsonArray values = new JsonArray();
            for (String template : safeTemplates.get(event)) {
                values.add(template);
            }
            result.add(event, values);
        }
        return result;
    }

    private static Map<String, List<String>> readBubbleTemplates(JsonElement value,
                                                                 Map<String, List<String>> fallback) {
        if (value == null || !value.isJsonObject()) {
            return sanitizeBubbleTemplates(fallback);
        }
        Map<String, List<String>> result = sanitizeBubbleTemplates(fallback);
        JsonObject object = value.getAsJsonObject();
        for (String event : BUBBLE_EVENTS) {
            JsonElement templates = object.get(event);
            if (templates == null) {
                continue;
            }
            if (!templates.isJsonArray()) {
                throw new IllegalArgumentException("bubbleTemplates." + event + " must be an array");
            }
            List<String> parsed = new ArrayList<>();
            for (JsonElement template : templates.getAsJsonArray()) {
                if (!template.isJsonPrimitive() || !template.getAsJsonPrimitive().isString()) {
                    continue;
                }
                String sanitized = sanitizeBubbleText(template.getAsString());
                if (!sanitized.isBlank()) {
                    parsed.add(sanitized);
                }
                if (parsed.size() >= MAX_BUBBLE_TEMPLATE_COUNT) {
                    break;
                }
            }
            result.put(event, parsed.isEmpty() ? defaultBubbleTemplates().get(event) : parsed);
        }
        return result;
    }

    private static Map<String, List<String>> sanitizeBubbleTemplates(Map<String, List<String>> templates) {
        Map<String, List<String>> defaults = defaultBubbleTemplates();
        Map<String, List<String>> result = new LinkedHashMap<>();
        for (String event : BUBBLE_EVENTS) {
            List<String> source = templates == null ? null : templates.get(event);
            List<String> values = new ArrayList<>();
            if (source != null) {
                for (String template : source) {
                    String sanitized = sanitizeBubbleText(template);
                    if (!sanitized.isBlank()) {
                        values.add(sanitized);
                    }
                    if (values.size() >= MAX_BUBBLE_TEMPLATE_COUNT) {
                        break;
                    }
                }
            }
            result.put(event, values.isEmpty() ? new ArrayList<>(defaults.get(event)) : values);
        }
        return result;
    }

    private static Map<String, List<String>> defaultBubbleTemplates() {
        Map<String, List<String>> result = new LinkedHashMap<>();
        result.put("task_started", List.of("Task started: {tabTitle}"));
        result.put("thinking", List.of("Thinking...", "Working through it"));
        result.put("running", List.of("Running...", "Making progress"));
        result.put("task_success", List.of("Task complete", "{tabTitle} is done"));
        result.put("task_error", List.of("Task failed", "{tabTitle} needs attention"));
        result.put("idle", List.of("Ready"));
        return result;
    }

    private static String pickBubbleTemplate(Map<String, List<String>> templates, String event) {
        List<String> values = sanitizeBubbleTemplates(templates).get(event);
        if (values.isEmpty()) {
            return "";
        }
        return values.get(ThreadLocalRandom.current().nextInt(values.size()));
    }

    private static String renderBubbleTemplate(String template, JsonObject payload) {
        String tabTitle = sanitizeBubbleText(readOptionalString(payload, "tabTitle"));
        if (tabTitle.isBlank()) {
            tabTitle = DEFAULT_TAB_TITLE;
        }
        String provider = sanitizeBubbleText(readOptionalString(payload, "provider"));
        String model = sanitizeBubbleText(readOptionalString(payload, "model"));
        String result = template
                .replace("{tabTitle}", tabTitle)
                .replace("{provider}", provider)
                .replace("{model}", model)
                .replace("{duration}", formatBubbleDuration(payload.get("durationMs")));
        return sanitizeBubbleText(result);
    }

    private static String formatBubbleDuration(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            return "";
        }
        double durationMs = value.getAsDouble();
        if (!Double.isFinite(durationMs) || durationMs < 0 || durationMs > Long.MAX_VALUE) {
            return "";
        }
        long tenths = Math.round(durationMs / 100.0d);
        long seconds = tenths / 10L;
        long fraction = tenths % 10L;
        return fraction == 0L ? seconds + "s" : seconds + "." + fraction + "s";
    }

    static Rectangle bubbleCloseBounds(Rectangle bubbleBounds) {
        int size = 18;
        int margin = 8;
        return new Rectangle(
                bubbleBounds.x + bubbleBounds.width - margin - size,
                bubbleBounds.y + margin,
                size,
                size);
    }

    private void dismissBubble(ActiveBubble bubble) {
        synchronized (this) {
            if (activeBubble != bubble) {
                return;
            }
            activeBubble = null;
        }
        syncComponent();
    }

    private void activateBubble(ActiveBubble bubble) {
        dismissBubble(bubble);
        if (bubble.onActivate == null) {
            return;
        }
        try {
            bubble.onActivate.run();
        } catch (RuntimeException e) {
            LOG.debug("[CodexPet] Bubble source is no longer available: " + e.getMessage());
        }
    }

    private static String normalizeBubbleEvent(String value) {
        for (String event : BUBBLE_EVENTS) {
            if (event.equals(value)) {
                return event;
            }
        }
        return "running";
    }

    private static VisualState bubbleVisualState(String event) {
        if ("task_error".equals(event)) {
            return VisualState.ERROR;
        }
        if ("task_success".equals(event)) {
            return VisualState.SUCCESS;
        }
        if ("thinking".equals(event)) {
            return VisualState.THINKING;
        }
        if ("idle".equals(event)) {
            return VisualState.IDLE;
        }
        return VisualState.RUNNING;
    }

    private static String sanitizeBubbleText(String value) {
        if (value == null) {
            return "";
        }
        String sanitized = value.replaceAll("\\p{Cntrl}", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return sanitized.length() > MAX_BUBBLE_TEMPLATE_LENGTH
                ? sanitized.substring(0, MAX_BUBBLE_TEMPLATE_LENGTH)
                : sanitized;
    }

    static String sanitizePetId(String value) {
        if (value == null || value.isBlank() || "builtin".equals(value)) {
            return "builtin";
        }
        String normalized = value.replace('\\', '/');
        if (normalized.length() > 180
                || normalized.startsWith("/")
                || hasTraversalSegment(normalized)
                || normalized.indexOf(':') >= 0) {
            return "builtin";
        }
        return normalized;
    }

    private static boolean readBoolean(JsonObject config, String property) {
        if (!config.get(property).isJsonPrimitive()
                || !config.get(property).getAsJsonPrimitive().isBoolean()) {
            throw new IllegalArgumentException(property + " must be a boolean");
        }
        return config.get(property).getAsBoolean();
    }

    private static String readString(JsonObject config, String property) {
        if (!config.get(property).isJsonPrimitive()
                || !config.get(property).getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException(property + " must be a string");
        }
        return config.get(property).getAsString();
    }

    private static String readOptionalString(JsonObject config, String property) {
        JsonElement value = config.get(property);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString() : "";
    }

    private static int readInteger(JsonObject config, String property) {
        if (!config.get(property).isJsonPrimitive()
                || !config.get(property).getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException(property + " must be an integer");
        }
        double value = config.get(property).getAsDouble();
        if (!Double.isFinite(value) || value != Math.rint(value)) {
            throw new IllegalArgumentException(property + " must be an integer");
        }
        return (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, value));
    }

    private static double readDouble(JsonObject config, String property) {
        if (!config.get(property).isJsonPrimitive()
                || !config.get(property).getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException(property + " must be a number");
        }
        double value = config.get(property).getAsDouble();
        if (!Double.isFinite(value)) {
            throw new IllegalArgumentException(property + " must be finite");
        }
        return value;
    }

    private static boolean hasTraversalSegment(String value) {
        for (String segment : value.split("/")) {
            if (".".equals(segment) || "..".equals(segment)) {
                return true;
            }
        }
        return false;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double clamp(double value, double min, double max) {
        if (!Double.isFinite(value)) {
            return min;
        }
        return Math.max(min, Math.min(max, value));
    }

    public static int normalizeCatalogPageSize(int value) {
        if (value <= MIN_CATALOG_PAGE_SIZE) {
            return MIN_CATALOG_PAGE_SIZE;
        }
        if (value <= 24) {
            return 24;
        }
        if (value <= 36) {
            return 36;
        }
        return MAX_CATALOG_PAGE_SIZE;
    }

    public static String normalizeCatalogSort(String value) {
        if ("name_asc".equals(value)
                || "name_desc".equals(value)
                || "author_asc".equals(value)
                || "kind_asc".equals(value)
                || "slug_asc".equals(value)) {
            return value;
        }
        return DEFAULT_CATALOG_SORT;
    }

    static int restoreCoordinate(double normalized, int maxCoordinate) {
        int safeMax = Math.max(0, maxCoordinate);
        return (int) Math.round(safeMax * clamp(normalized, 0.0d, 1.0d));
    }

    static double storeCoordinate(int coordinate, int maxCoordinate) {
        int safeMax = Math.max(0, maxCoordinate);
        return safeMax == 0 ? 0.0d : (double) clamp(coordinate, 0, safeMax) / safeMax;
    }

    @Override
    public void dispose() {
        synchronized (INSTANCES) {
            INSTANCES.remove(this);
        }
        assetGeneration.incrementAndGet();
        if (SwingUtilities.isEventDispatchThread()) {
            detachComponent();
        } else {
            ApplicationManager.getApplication().invokeLater(this::detachComponent);
        }
        synchronized (this) {
            sourceStates.clear();
            sourceLastSeen.clear();
            sourceActive.clear();
        }
    }

    public static final class PetState {
        public String scope = SCOPE_PROJECT;
        public boolean enabled = true;
        public String selectedPetId = "builtin";
        public int size = 96;
        public double opacity = 1.0d;
        public double positionX = DEFAULT_X;
        public double positionY = DEFAULT_Y;
        public int petdexConnectTimeoutSeconds = 30;
        public int petdexRequestTimeoutSeconds = 60;
        public int petdexRetryAttempts = 3;
        public int catalogColumns = 4;
        public int catalogPageSize = DEFAULT_CATALOG_PAGE_SIZE;
        public String catalogSort = DEFAULT_CATALOG_SORT;
        public boolean showStatusIndicator = false;
        public boolean bubbleEnabled = true;
        public int bubbleDurationSeconds = DEFAULT_BUBBLE_DURATION_SECONDS;
        public String bubbleSize = BubbleSize.MEDIUM.wireValue;
        public boolean bubbleShowForBackgroundTabs = false;
        public Map<String, List<String>> bubbleTemplates = defaultBubbleTemplates();
    }

    public enum BubbleSize {
        SMALL("small", 220, 72),
        MEDIUM("medium", 280, 88),
        LARGE("large", 340, 106),
        XLARGE("xlarge", 400, 125);

        private final String wireValue;
        private final int width;
        private final int height;

        BubbleSize(String wireValue, int width, int height) {
            this.wireValue = wireValue;
            this.width = width;
            this.height = height;
        }

        private static BubbleSize normalize(String value) {
            for (BubbleSize size : values()) {
                if (size.wireValue.equals(value)) {
                    return size;
                }
            }
            return MEDIUM;
        }
    }

    private enum VisualState {
        IDLE(new Color(150, 155, 165), 0, 6, 0),
        SUCCESS(new Color(76, 175, 80), 4, 5, 1),
        THINKING(new Color(255, 183, 77), 8, 6, 2),
        RUNNING(new Color(66, 165, 245), 7, 6, 3),
        ERROR(new Color(239, 83, 80), 5, 8, 4);

        private final Color indicatorColor;
        private final int spriteRow;
        private final int frameCount;
        private final int priority;

        VisualState(Color indicatorColor, int spriteRow, int frameCount, int priority) {
            this.indicatorColor = indicatorColor;
            this.spriteRow = spriteRow;
            this.frameCount = frameCount;
            this.priority = priority;
        }

        private static VisualState fromWireValue(String value) {
            if ("error".equals(value)) {
                return ERROR;
            }
            if ("running".equals(value)) {
                return RUNNING;
            }
            if ("thinking".equals(value)) {
                return THINKING;
            }
            if ("success".equals(value)) {
                return SUCCESS;
            }
            return IDLE;
        }
    }

    private static final class LoadedPet {
        private final Image image;
        private final int width;
        private final int height;
        private final boolean spriteSheet;

        private LoadedPet(Image image, int width, int height, boolean spriteSheet) {
            this.image = image;
            this.width = width;
            this.height = height;
            this.spriteSheet = spriteSheet;
        }
    }

    private static final class ActiveBubble {
        private final String sourceId;
        private final String text;
        private final VisualState visualState;
        private final long expiresAtMillis;
        private final Runnable onActivate;

        private ActiveBubble(
                String sourceId,
                String text,
                VisualState visualState,
                long expiresAtMillis,
                Runnable onActivate
        ) {
            this.sourceId = sourceId;
            this.text = text;
            this.visualState = visualState;
            this.expiresAtMillis = expiresAtMillis;
            this.onActivate = onActivate;
        }
    }

    private final class PetComponent extends JComponent {
        private Point dragAnchorOnScreen;
        private Point componentAnchor;
        private ActiveBubble pressedBubble;
        private boolean pressedCloseButton;

        private PetComponent() {
            setOpaque(false);
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            setToolTipText("Codex Pet - drag to move");
            addMouseListener(new MouseAdapter() {
                @Override
                public void mousePressed(MouseEvent event) {
                    if (SwingUtilities.isLeftMouseButton(event)) {
                        pressedBubble = null;
                        pressedCloseButton = false;
                        dragAnchorOnScreen = null;
                        componentAnchor = null;
                        ActiveBubble bubble = currentBubble();
                        Rectangle bubbleBounds = bubble == null ? null : bubbleBounds();
                        if (bubble != null && bubbleBounds.contains(event.getPoint())) {
                            pressedBubble = bubble;
                            pressedCloseButton = bubbleCloseBounds(bubbleBounds).contains(event.getPoint());
                            return;
                        }
                        dragAnchorOnScreen = event.getLocationOnScreen();
                        componentAnchor = new Point(petX, petY);
                        setCursor(Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR));
                    }
                }

                @Override
                public void mouseReleased(MouseEvent event) {
                    if (pressedBubble != null) {
                        ActiveBubble bubble = pressedBubble;
                        boolean closeButton = pressedCloseButton;
                        pressedBubble = null;
                        pressedCloseButton = false;
                        Rectangle bubbleBounds = bubbleBounds();
                        if (currentBubble() == bubble) {
                            if (closeButton) {
                                if (bubbleCloseBounds(bubbleBounds).contains(event.getPoint())) {
                                    dismissBubble(bubble);
                                }
                            } else if (bubbleBounds.contains(event.getPoint())) {
                                activateBubble(bubble);
                            }
                        }
                        return;
                    }
                    if (dragAnchorOnScreen != null && componentAnchor != null) {
                        persistCurrentPosition();
                    }
                    dragAnchorOnScreen = null;
                    componentAnchor = null;
                    setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                }
            });
            addMouseMotionListener(new MouseMotionAdapter() {
                @Override
                public void mouseDragged(MouseEvent event) {
                    if (dragAnchorOnScreen == null || componentAnchor == null) {
                        return;
                    }
                    Point pointerOnScreen = event.getLocationOnScreen();
                    int x = componentAnchor.x + pointerOnScreen.x - dragAnchorOnScreen.x;
                    int y = componentAnchor.y + pointerOnScreen.y - dragAnchorOnScreen.y;
                    moveDraggedPet(x, y);
                }
            });
        }

        @Override
        protected void paintComponent(Graphics graphics) {
            Graphics2D g2 = (Graphics2D) graphics.create();
            try {
                g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                        RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
                Composite previousComposite = g2.getComposite();
                g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, componentOpacity()));
                int petWidth = petDisplayWidth();
                int petHeight = petDisplayHeight();
                ActiveBubble bubble = currentBubble();
                if (bubble != null) {
                    paintBubble(g2, bubble);
                }
                LoadedPet pet = loadedPet;
                int offsetX = petOffsetX();
                int offsetY = petOffsetY();
                Graphics2D petGraphics = (Graphics2D) g2.create(offsetX, offsetY, petWidth, petHeight);
                try {
                    if (pet == null) {
                        paintBuiltinPet(petGraphics, petWidth, petHeight);
                    } else if (pet.spriteSheet) {
                        paintSpriteFrame(petGraphics, pet, petWidth, petHeight);
                    } else {
                        paintStaticImage(petGraphics, pet, petWidth, petHeight);
                    }
                    if (showStatusIndicator()) {
                        paintStateIndicator(petGraphics, petWidth);
                    }
                } finally {
                    petGraphics.dispose();
                }
                g2.setComposite(previousComposite);
            } finally {
                g2.dispose();
            }
        }

        private void paintBubble(Graphics2D g2, ActiveBubble bubble) {
            Rectangle bounds = bubbleBounds();
            int x = bounds.x;
            int y = bounds.y;
            int width = bounds.width;
            int height = bounds.height;
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            g2.setColor(new Color(28, 31, 36, 225));
            g2.fillRoundRect(x, y, width, height, 16, 16);
            g2.setColor(new Color(255, 255, 255, 42));
            g2.drawRoundRect(x, y, width - 1, height - 1, 16, 16);

            Rectangle close = bubbleCloseBounds(bounds);
            g2.setColor(new Color(245, 247, 250, 180));
            g2.setStroke(new BasicStroke(1.5f));
            int inset = 5;
            g2.drawLine(close.x + inset, close.y + inset,
                    close.x + close.width - inset, close.y + close.height - inset);
            g2.drawLine(close.x + close.width - inset, close.y + inset,
                    close.x + inset, close.y + close.height - inset);

            int dot = 8;
            int paddingX = 16;
            int baselineY = y + 28;
            g2.setColor(bubble.visualState.indicatorColor);
            g2.fillOval(x + paddingX, y + 18, dot, dot);

            g2.setColor(new Color(245, 247, 250));
            g2.setFont(getFont().deriveFont(Font.PLAIN, 13.0f));
            FontMetrics metrics = g2.getFontMetrics();
            int textX = x + paddingX + dot + 9;
            int maxTextWidth = Math.max(1, close.x - 8 - textX);
            List<String> lines = wrapBubbleText(bubble.text, metrics, maxTextWidth);
            for (int i = 0; i < lines.size(); i++) {
                g2.drawString(lines.get(i), textX, baselineY + i * Math.max(16, metrics.getHeight()));
            }
        }

        private Rectangle bubbleBounds() {
            BubbleSize size = BubbleSize.normalize(activeBubbleSize());
            int petWidth = petDisplayWidth();
            int petHeight = petDisplayHeight();
            int petOffsetX = petOffsetX();
            int petOffsetY = petOffsetY();
            int desiredX = petOffsetX + (petWidth - size.width) / 2;
            int x = Math.max(0, Math.min(getWidth() - size.width, desiredX));
            int y = petOffsetY > 0 ? 0 : petHeight + BUBBLE_GAP;
            return new Rectangle(x, y, size.width, size.height);
        }

        private List<String> wrapBubbleText(String text, FontMetrics metrics, int maxWidth) {
            List<String> result = new ArrayList<>();
            if (metrics.stringWidth(text) <= maxWidth) {
                result.add(text);
                return result;
            }
            int split = Math.min(text.length(), Math.max(1, text.length() / 2));
            while (split > 1 && metrics.stringWidth(text.substring(0, split)) > maxWidth) {
                split--;
            }
            result.add(ellipsis(text.substring(0, split).trim(), metrics, maxWidth));
            result.add(ellipsis(text.substring(split).trim(), metrics, maxWidth));
            return result;
        }

        private String ellipsis(String text, FontMetrics metrics, int maxWidth) {
            if (metrics.stringWidth(text) <= maxWidth) {
                return text;
            }
            String suffix = "...";
            int end = text.length();
            while (end > 0 && metrics.stringWidth(text.substring(0, end) + suffix) > maxWidth) {
                end--;
            }
            return end <= 0 ? suffix : text.substring(0, end) + suffix;
        }

        private void paintSpriteFrame(Graphics2D g2, LoadedPet pet, int petWidth, int petHeight) {
            VisualState currentState = visualState;
            int maxRows = pet.height / CodexPetImageSupport.PETDEX_FRAME_HEIGHT;
            int row = Math.min(currentState.spriteRow, Math.max(0, maxRows - 1));
            int frame = animationFrame % currentState.frameCount;
            int sourceX = frame * CodexPetImageSupport.PETDEX_FRAME_WIDTH;
            int sourceY = row * CodexPetImageSupport.PETDEX_FRAME_HEIGHT;
            g2.drawImage(pet.image,
                    0, 0, petWidth, petHeight,
                    sourceX, sourceY,
                    sourceX + CodexPetImageSupport.PETDEX_FRAME_WIDTH,
                    sourceY + CodexPetImageSupport.PETDEX_FRAME_HEIGHT,
                    null);
        }

        private void paintStaticImage(Graphics2D g2, LoadedPet pet, int petWidth, int petHeight) {
            double scale = Math.min((double) petWidth / pet.width, (double) petHeight / pet.height);
            int width = Math.max(1, (int) Math.round(pet.width * scale));
            int height = Math.max(1, (int) Math.round(pet.height * scale));
            int x = (petWidth - width) / 2;
            int y = (petHeight - height) / 2;
            g2.drawImage(pet.image, x, y, width, height, this);
        }

        private void paintBuiltinPet(Graphics2D g2, int petWidth, int petHeight) {
            int unit = Math.max(2, Math.min(petWidth, petHeight) / 16);
            int bodyWidth = unit * 10;
            int bodyHeight = unit * 9;
            int x = (petWidth - bodyWidth) / 2;
            int y = Math.max(unit, (petHeight - bodyHeight) / 2);
            g2.setColor(new Color(50, 55, 65, 220));
            g2.fillRoundRect(x, y, bodyWidth, bodyHeight, unit * 2, unit * 2);
            g2.setColor(new Color(115, 203, 255));
            g2.fillRect(x + unit * 2, y + unit * 2, unit * 2, unit * 2);
            g2.fillRect(x + unit * 6, y + unit * 2, unit * 2, unit * 2);
            g2.setStroke(new BasicStroke(Math.max(1.0f, unit / 2.0f)));
            g2.drawLine(x + unit * 3, y + unit * 6, x + unit * 7, y + unit * 6);
            g2.setColor(new Color(50, 55, 65, 220));
            g2.drawLine(petWidth / 2, y, petWidth / 2, Math.max(0, y - unit * 2));
            g2.setColor(new Color(121, 220, 132));
            g2.fillOval(petWidth / 2 - unit / 2, Math.max(0, y - unit * 3), unit, unit);
        }

        private void paintStateIndicator(Graphics2D g2, int petWidth) {
            int diameter = Math.max(7, petWidth / 12);
            g2.setColor(new Color(25, 27, 31, 190));
            g2.fillOval(petWidth - diameter - 3, 3, diameter, diameter);
            g2.setColor(visualState.indicatorColor);
            g2.fillOval(petWidth - diameter - 1, 5, diameter - 4, diameter - 4);
        }
    }
}
