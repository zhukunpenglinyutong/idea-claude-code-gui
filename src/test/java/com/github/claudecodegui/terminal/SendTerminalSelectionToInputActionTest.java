package com.github.claudecodegui.terminal;

import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionPopupMenu;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.ActionGroup;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.DataContext;
import com.intellij.openapi.actionSystem.DataKey;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.actionSystem.TimerListener;
import com.intellij.openapi.actionSystem.ex.AnActionListener;
import org.junit.After;
import org.junit.Assert;
import org.junit.Test;

import java.awt.Component;
import java.awt.event.InputEvent;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

public class SendTerminalSelectionToInputActionTest {
    @After
    public void tearDown() {
        SendTerminalSelectionToInputAction.resetSelectionProvider();
    }

    @Test
    public void updateRunsOnBackgroundThread() {
        SendTerminalSelectionToInputAction action = new SendTerminalSelectionToInputAction();

        Assert.assertEquals(ActionUpdateThread.BGT, action.getActionUpdateThread());
    }

    @Test
    public void validSelectionIsReturned() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> "payload");
        Assert.assertEquals("payload", SendTerminalSelectionToInputAction.resolveSelectedText(null));
    }

    @Test
    public void terminalPromptPopupPlaceShouldBeVisible() {
        Assert.assertTrue(SendTerminalSelectionToInputAction.isTerminalPopupPlace("Terminal.PromptContextMenu"));
    }

    @Test
    public void terminalOutputPopupPlaceShouldBeVisible() {
        Assert.assertTrue(SendTerminalSelectionToInputAction.isTerminalPopupPlace("Terminal.OutputContextMenu"));
    }

    @Test
    public void reworkedTerminalPopupPlaceShouldBeVisible() {
        Assert.assertTrue(SendTerminalSelectionToInputAction.isTerminalPopupPlace("Terminal.ReworkedTerminalContextMenu"));
    }

    @Test
    public void reworkedTerminalViewContextShouldMakeActionVisible() {
        SendTerminalSelectionToInputAction action = new SendTerminalSelectionToInputAction();
        AnActionEvent event = createEvent(createTerminalViewContext(new FakeTerminalView("payload")));

        action.update(event);

        Assert.assertTrue(event.getPresentation().isVisible());
        Assert.assertTrue(event.getPresentation().isEnabled());
    }

    @Test
    public void unrelatedPopupPlaceShouldNotBeTreatedAsTerminalPopup() {
        Assert.assertFalse(SendTerminalSelectionToInputAction.isTerminalPopupPlace("EditorPopupMenu"));
    }

    @Test
    public void blankSelectionIsFiltered() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> "   ");
        Assert.assertNull(SendTerminalSelectionToInputAction.resolveSelectedText(null));
    }

    @Test
    public void unsupportedEditorReturnsNull() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> null);
        Assert.assertNull(SendTerminalSelectionToInputAction.resolveSelectedText(null));
    }

    @Test
    public void reworkedTerminalSelectionIsResolvedReflectively() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> null);

        AnActionEvent event = createEvent(createTerminalViewContext(new FakeTerminalView("payload")));

        Assert.assertEquals("payload", SendTerminalSelectionToInputAction.resolveSelectedText(event));
    }

    @Test
    public void terminalFeaturesDoNotRegisterActionForReworkedTerminalContextMenuStatically() throws IOException {
        try (InputStream stream = getClass().getClassLoader().getResourceAsStream("META-INF/terminal-features.xml")) {
            Assert.assertNotNull("terminal-features.xml should be on the test classpath", stream);
            String xml = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            Assert.assertFalse(xml.contains("group-id=\"Terminal.ReworkedTerminalContextMenu\""));
        }
    }

    @Test
    public void reworkedTerminalContextMenuIsRegisteredOnlyWhenGroupExists() {
        TestActionManager actionManager = new TestActionManager();
        DefaultActionGroup group = new DefaultActionGroup();
        actionManager.registerAction(SendTerminalSelectionToInputAction.ACTION_ID, new SendTerminalSelectionToInputAction());
        actionManager.registerAction(SendTerminalSelectionToInputAction.TERMINAL_REWORKED_CONTEXT_MENU, group);

        Assert.assertTrue(SendTerminalSelectionToInputAction.registerForReworkedTerminalContextMenu(actionManager));
        Assert.assertEquals(
                Collections.singletonList(SendTerminalSelectionToInputAction.ACTION_ID),
                childIds(actionManager, group)
        );
    }

    @Test
    public void reworkedTerminalContextMenuRegistrationIsSkippedWhenGroupIsMissing() {
        TestActionManager actionManager = new TestActionManager();
        actionManager.registerAction(SendTerminalSelectionToInputAction.ACTION_ID, new SendTerminalSelectionToInputAction());

        Assert.assertFalse(SendTerminalSelectionToInputAction.registerForReworkedTerminalContextMenu(actionManager));
    }

    @Test
    public void reworkedTerminalContextMenuRegistrationAvoidsDuplicates() {
        TestActionManager actionManager = new TestActionManager();
        DefaultActionGroup group = new DefaultActionGroup();
        AnAction action = new SendTerminalSelectionToInputAction();
        actionManager.registerAction(SendTerminalSelectionToInputAction.ACTION_ID, action);
        actionManager.registerAction(SendTerminalSelectionToInputAction.TERMINAL_REWORKED_CONTEXT_MENU, group);

        Assert.assertTrue(SendTerminalSelectionToInputAction.registerForReworkedTerminalContextMenu(actionManager));
        Assert.assertFalse(SendTerminalSelectionToInputAction.registerForReworkedTerminalContextMenu(actionManager));
        Assert.assertEquals(Collections.singletonList(SendTerminalSelectionToInputAction.ACTION_ID), childIds(actionManager, group));
    }

    @SuppressWarnings("removal")
    private static AnActionEvent createEvent(DataContext dataContext) {
        return new AnActionEvent(null, dataContext, "TestPlace", new Presentation(), new TestActionManager(), 0);
    }

    private static DataContext createTerminalViewContext(Object terminalView) {
        DataKey<Object> terminalViewKey = DataKey.create("TerminalView");
        return dataId -> terminalViewKey.getName().equals(dataId) ? terminalView : null;
    }

    private static List<String> childIds(TestActionManager actionManager, DefaultActionGroup group) {
        return Arrays.stream(group.getChildActionsOrStubs())
                .map(actionManager::getId)
                .collect(Collectors.toList());
    }

    private static final class FakeTerminalView {
        private final FakeSelectionModel selectionModel = new FakeSelectionModel();
        private final FakeOutputModels outputModels;

        private FakeTerminalView(String selectedText) {
            outputModels = new FakeOutputModels(new FakeStateFlow(new FakeOutputModel(selectedText)));
        }

        public FakeSelectionModel getTextSelectionModel() {
            return selectionModel;
        }

        public FakeOutputModels getOutputModels() {
            return outputModels;
        }
    }

    private static final class FakeSelectionModel {
        public FakeSelection getSelection() {
            return new FakeSelection();
        }
    }

    private static final class FakeSelection {
        public Object getStartOffset() {
            return new Object();
        }

        public Object getEndOffset() {
            return new Object();
        }
    }

    private static final class FakeOutputModels {
        private final FakeStateFlow active;

        private FakeOutputModels(FakeStateFlow active) {
            this.active = active;
        }

        public FakeStateFlow getActive() {
            return active;
        }
    }

    private static final class FakeStateFlow {
        private final FakeOutputModel value;

        private FakeStateFlow(FakeOutputModel value) {
            this.value = value;
        }

        public FakeOutputModel getValue() {
            return value;
        }
    }

    private static final class FakeOutputModel {
        private final String selectedText;

        private FakeOutputModel(String selectedText) {
            this.selectedText = selectedText;
        }

        public CharSequence getText(Object startOffset, Object endOffset) {
            return selectedText;
        }
    }

    private static final class TestActionManager extends ActionManager {
        private final Map<String, AnAction> actionsById = new HashMap<>();
        private final Map<AnAction, String> idsByAction = new IdentityHashMap<>();

        @Override
        public ActionPopupMenu createActionPopupMenu(String place, ActionGroup group) {
            return null;
        }

        @Override
        public ActionToolbar createActionToolbar(String place, ActionGroup group, boolean horizontal) {
            return null;
        }

        @Override
        public AnAction getAction(String id) {
            return actionsById.get(id);
        }

        @Override
        public String getId(AnAction action) {
            return idsByAction.get(action);
        }

        @Override
        public void registerAction(String actionId, AnAction action) {
            actionsById.put(actionId, action);
            idsByAction.put(action, actionId);
        }

        @Override
        public void registerAction(String actionId, AnAction action, com.intellij.openapi.extensions.PluginId pluginId) {
            registerAction(actionId, action);
        }

        @Override
        public void unregisterAction(String actionId) {
        }

        @Override
        public void replaceAction(String actionId, com.intellij.openapi.actionSystem.AnAction newAction) {
        }

        @Override
        public String[] getActionIds(String idPrefix) {
            return new String[0];
        }

        @Override
        public List<String> getActionIdList(String idPrefix) {
            return Collections.emptyList();
        }

        @Override
        public boolean isGroup(String actionId) {
            return actionsById.get(actionId) instanceof ActionGroup;
        }

        @Override
        public AnAction getActionOrStub(String id) {
            return getAction(id);
        }

        @Override
        public void addTimerListener(TimerListener listener) {
        }

        @Override
        public void removeTimerListener(TimerListener listener) {
        }

        @SuppressWarnings("removal")
        @Override
        public void addAnActionListener(AnActionListener listener) {
        }

        @Override
        public com.intellij.openapi.util.ActionCallback tryToExecute(AnAction action,
                                                                     InputEvent inputEvent,
                                                                     Component contextComponent,
                                                                     String place,
                                                                     boolean now) {
            return com.intellij.openapi.util.ActionCallback.DONE;
        }

        @SuppressWarnings("removal")
        @Override
        public void addAnActionListener(AnActionListener listener,
                                        com.intellij.openapi.Disposable parentDisposable) {
        }

        @Override
        public KeyboardShortcut getKeyboardShortcut(String actionId) {
            return null;
        }
    }
}
