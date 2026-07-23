import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PetSettingsSection from './index';

interface CatalogPayload {
  pets: Array<{
    slug: string;
    displayName: string;
    kind: string;
    submittedBy: string;
    installed: boolean;
    managed: boolean;
  }>;
  total: number;
  offset: number;
  limit: number;
  query: string;
  sort: 'default' | 'name_asc' | 'name_desc' | 'author_asc' | 'kind_asc' | 'slug_asc';
  requestId?: number;
}

interface PreviewPayload {
  slug: string;
  dataUrl?: string;
  error?: string;
}

interface LocalPet {
  id: string;
  name: string;
  originalName?: string;
  alias?: string;
  source?: string;
  managed?: boolean;
  slug?: string;
  dataUrl?: string;
  spriteSheet: boolean;
}

interface LocalPreviewPayload {
  petId: string;
  dataUrl?: string;
  spriteSheet: boolean;
  error?: string;
}

interface PetOperationPayload {
  operation: 'configure' | 'install' | 'uninstall' | 'alias' | 'open-directory' | 'skill-command';
  success: boolean;
  slug?: string;
}

const mocks = vi.hoisted(() => ({
  catalogListeners: [] as Array<(payload: CatalogPayload) => void>,
  previewListeners: [] as Array<(payload: PreviewPayload) => void>,
  localPetListeners: [] as Array<(payload: LocalPet[]) => void>,
  localPreviewListeners: [] as Array<(payload: LocalPreviewPayload) => void>,
  assetChangeListeners: [] as Array<() => void>,
  operationListeners: [] as Array<(payload: PetOperationPayload) => void>,
  hatchStatusListeners: [] as Array<(payload: { status: 'missing' | 'installed' | 'broken'; skillPath: string; officialUrl: string }) => void>,
  hatchReferenceListeners: [] as Array<(path: string) => void>,
  hatchCommandListeners: [] as Array<(command: string) => void>,
  draftInput: '',
  setDraftInput: vi.fn(),
  setCurrentView: vi.fn(),
  getCatalog: vi.fn(),
  getPreview: vi.fn(),
  getLocalPreview: vi.fn(),
  getLocalPets: vi.fn(),
  setConfig: vi.fn(),
  setAlias: vi.fn(),
  refreshAssets: vi.fn(),
  getHatchStatus: vi.fn(),
  prepareHatchCommand: vi.fn(),
}));

vi.mock('../../../contexts/UIStateContext', () => ({
  useUIState: () => ({
    draftInput: mocks.draftInput,
    setDraftInput: mocks.setDraftInput,
    setCurrentView: mocks.setCurrentView,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => key === 'settings.pet.pageStatus'
      ? `${params?.current} / ${params?.total}`
      : key,
  }),
}));

vi.mock('../../codexPet/petBridge', () => ({
  BUBBLE_EVENTS: ['task_started', 'thinking', 'running', 'task_success', 'task_error', 'idle'],
  DEFAULT_BUBBLE_TEMPLATES: {
    task_started: ['Start'],
    thinking: ['Thinking'],
    running: ['Running'],
    task_success: ['Done'],
    task_error: ['Failed'],
    idle: ['Ready'],
  },
  petBridge: {
    subscribeConfig: vi.fn(() => () => undefined),
    subscribeLocalPets: vi.fn((listener: (payload: LocalPet[]) => void) => {
      mocks.localPetListeners.push(listener);
      return () => undefined;
    }),
    subscribeLocalPreview: vi.fn((listener: (payload: LocalPreviewPayload) => void) => {
      mocks.localPreviewListeners.push(listener);
      return () => undefined;
    }),
    subscribeAssetChanges: vi.fn((listener: () => void) => {
      mocks.assetChangeListeners.push(listener);
      return () => undefined;
    }),
    subscribeCatalog: vi.fn((listener: (payload: CatalogPayload) => void) => {
      mocks.catalogListeners.push(listener);
      return () => undefined;
    }),
    subscribePreview: vi.fn((listener: (payload: PreviewPayload) => void) => {
      mocks.previewListeners.push(listener);
      return () => undefined;
    }),
    subscribeOperation: vi.fn((listener: (payload: PetOperationPayload) => void) => {
      mocks.operationListeners.push(listener);
      return () => undefined;
    }),
    subscribeHatchStatus: vi.fn((listener) => {
      mocks.hatchStatusListeners.push(listener);
      return () => undefined;
    }),
    subscribeHatchReference: vi.fn((listener) => {
      mocks.hatchReferenceListeners.push(listener);
      return () => undefined;
    }),
    subscribeHatchCommand: vi.fn((listener) => {
      mocks.hatchCommandListeners.push(listener);
      return () => undefined;
    }),
    getConfig: vi.fn(),
    getLocalPets: mocks.getLocalPets,
    getLocalPreview: mocks.getLocalPreview,
    getCatalog: mocks.getCatalog,
    getPreview: mocks.getPreview,
    setConfig: mocks.setConfig,
    setAlias: mocks.setAlias,
    refreshAssets: mocks.refreshAssets,
    openPetDirectory: vi.fn(),
    getHatchStatus: mocks.getHatchStatus,
    openHatchWebsite: vi.fn(),
    chooseHatchReference: vi.fn(),
    prepareHatchCommand: mocks.prepareHatchCommand,
    install: vi.fn(),
    uninstall: vi.fn(),
    resetPosition: vi.fn(),
    openWebsite: vi.fn(),
  },
}));

describe('PetSettingsSection catalog pagination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.catalogListeners.length = 0;
    mocks.previewListeners.length = 0;
    mocks.localPetListeners.length = 0;
    mocks.localPreviewListeners.length = 0;
    mocks.assetChangeListeners.length = 0;
    mocks.operationListeners.length = 0;
    mocks.hatchStatusListeners.length = 0;
    mocks.hatchReferenceListeners.length = 0;
    mocks.hatchCommandListeners.length = 0;
    mocks.draftInput = '';
    mocks.setDraftInput.mockClear();
    mocks.setCurrentView.mockClear();
    mocks.getCatalog.mockClear();
    mocks.getPreview.mockClear();
    mocks.getLocalPreview.mockClear();
    mocks.getLocalPets.mockClear();
    mocks.setConfig.mockClear();
    mocks.setAlias.mockClear();
    mocks.refreshAssets.mockClear();
    mocks.getHatchStatus.mockClear();
    mocks.prepareHatchCommand.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const openBubbleTab = () => {
    fireEvent.click(screen.getByRole('tab', { name: 'settings.pet.tabs.bubble' }));
  };

  const openLocalTab = () => {
    fireEvent.click(screen.getByRole('tab', { name: 'settings.pet.tabs.local' }));
  };

  const openPetdexTab = () => {
    fireEvent.click(screen.getByRole('tab', { name: 'settings.pet.tabs.petdex' }));
  };

  it('renders all pet settings in one four-tab group', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);

    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('shows scope-specific guidance and keeps the window position hint separate', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);

    expect(screen.getByText('settings.pet.scopeDescriptions.project')).toBeTruthy();
    expect(screen.getByText('settings.pet.scopePositionHint')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.scopeOptions.global' }));

    expect(screen.getByText('settings.pet.scopeDescriptions.global')).toBeTruthy();
    expect(mocks.setConfig).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('groups the basic pet actions directly below the floating pet description', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);

    const actions = screen.getByTestId('pet-basic-actions');
    expect(actions.contains(screen.getByText('settings.pet.enabled'))).toBe(true);
    expect(actions.contains(screen.getByText('settings.pet.showStatusIndicator'))).toBe(true);
    expect(actions.contains(screen.getByRole('button', { name: 'settings.pet.resetPosition' }))).toBe(true);
  });

  it('requests the next offset and replaces the previous page', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    expect(screen.getByText('settings.pet.loadingCatalog')).toBeTruthy();
    act(() => vi.advanceTimersByTime(250));
    mocks.getCatalog.mockClear();

    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('one', 'Pet One')],
      total: 25,
      offset: 0,
      limit: 12,
      query: '',
      sort: 'default',
    }));

    expect(screen.getByText('Pet One')).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(mocks.getPreview).toHaveBeenCalledWith('one');
    act(() => mocks.previewListeners[0]!({
      slug: 'one',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }));
    expect(screen.getByRole('img', { name: 'Pet One' }).getAttribute('style'))
      .toContain('data:image/png');
    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.nextPage' }));
    expect(mocks.getCatalog).toHaveBeenCalledWith(false, '', 12, 12, 'default', expect.any(Number));

    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('two', 'Pet Two')],
      total: 25,
      offset: 12,
      limit: 12,
      query: '',
      sort: 'default',
    }));

    expect(screen.queryByText('Pet One')).toBeNull();
    expect(screen.getByText('Pet Two')).toBeTruthy();
    expect(screen.getByText('2 / 3')).toBeTruthy();

    act(() => mocks.previewListeners.forEach((listener) => listener({
      slug: 'two',
      error: 'PETDEX_CONNECT_TIMEOUT',
    })));
    expect(screen.getByLabelText('settings.pet.connectTimeoutError')).toBeTruthy();
  });

  it('commits the current numeric field value on blur', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    const connectTimeout = screen.getByLabelText('settings.pet.connectTimeout');

    fireEvent.change(connectTimeout, { target: { value: '75' } });
    fireEvent.blur(connectTimeout);

    expect(mocks.setConfig).toHaveBeenCalledWith({ petdexConnectTimeoutSeconds: 75 });
  });

  it('switches between project and global pet configuration scopes', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.scopeOptions.global' }));

    expect(mocks.setConfig).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('shows available bubble template variables', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openBubbleTab();

    expect(screen.getByText('settings.pet.templateVariables')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('settings.pet.templateVariableTable.variable')).toBeTruthy();
    expect(screen.getByText('settings.pet.templateVariableTable.content')).toBeTruthy();
    expect(screen.getByText('{tabTitle}')).toBeTruthy();
    expect(screen.getByText('{provider}')).toBeTruthy();
    expect(screen.getByText('{model}')).toBeTruthy();
    expect(screen.getByText('{duration}')).toBeTruthy();
    expect(screen.getByText('settings.pet.templateVariableTable.tabTitle')).toBeTruthy();
    expect(screen.getByText('settings.pet.templateVariableTable.provider')).toBeTruthy();
    expect(screen.getByText('settings.pet.templateVariableTable.model')).toBeTruthy();
    expect(screen.getByText('settings.pet.templateVariableTable.duration')).toBeTruthy();
  });

  it('groups the bubble toggles directly below the bubble description', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openBubbleTab();

    const actions = screen.getByTestId('pet-bubble-actions');
    expect(actions.contains(screen.getByText('settings.pet.enabled'))).toBe(true);
    expect(actions.contains(screen.getByText('settings.pet.bubbleShowForBackgroundTabs'))).toBe(true);
  });

  it('keeps the custom pet tab focused on the hatch-pet workflow', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openLocalTab();
    act(() => mocks.hatchStatusListeners[0]!({
      status: 'missing', skillPath: '/home/test/.codex/skills/hatch-pet', officialUrl: 'https://example.test',
    }));

    expect(screen.queryByRole('button', { name: 'settings.pet.importLocalPet' })).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.pet.prepareInstallSkill' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.pet.openPetDirectory' })).toBeTruthy();
  });

  it('refreshes hatch-pet status and external pet assets together', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openLocalTab();

    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.refreshLocalPets' }));

    expect(mocks.refreshAssets).toHaveBeenCalledOnce();
    expect(mocks.getHatchStatus).toHaveBeenCalled();
  });

  it('prepares hatch-pet commands only after the skill is detected', () => {
    const addToast = vi.fn();
    render(<PetSettingsSection addToast={addToast} />);
    openLocalTab();
    expect(screen.queryByRole('button', { name: 'settings.pet.prepareInstallSkill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.pet.hatchOfficialSource' })).toBeNull();
    act(() => mocks.hatchStatusListeners[0]!({
      status: 'installed', skillPath: '/home/test/.codex/skills/hatch-pet', officialUrl: 'https://example.test',
    }));
    fireEvent.change(screen.getByLabelText('settings.pet.hatchName'), { target: { value: 'Desk Cat' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.prepareCreatePet' }));
    expect(mocks.prepareHatchCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create', name: 'Desk Cat', style: 'auto',
    }));

    act(() => mocks.hatchCommandListeners[0]!('$hatch-pet Create a Codex-compatible pet.'));
    expect(mocks.setDraftInput).toHaveBeenCalledWith('$hatch-pet Create a Codex-compatible pet.');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('chat');
    expect(addToast).toHaveBeenCalledWith('settings.pet.hatchCommandPrepared', 'success');
  });

  it('prepares a Skill repair command when hatch-pet is detected as broken', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openLocalTab();
    act(() => mocks.hatchStatusListeners[0]!({
      status: 'broken', skillPath: '/home/test/.codex/skills/hatch-pet', officialUrl: 'https://example.test',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.prepareRepairSkill' }));

    expect(mocks.prepareHatchCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'install' }));
  });

  it('does not overwrite an existing chat draft without confirmation', () => {
    mocks.draftInput = 'unfinished question';
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PetSettingsSection addToast={vi.fn()} />);
    openLocalTab();
    act(() => mocks.hatchStatusListeners[0]!({
      status: 'installed', skillPath: '/home/test/.codex/skills/hatch-pet', officialUrl: 'https://example.test',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.prepareCreatePet' }));

    expect(window.confirm).toHaveBeenCalledWith('settings.pet.hatchReplaceDraftConfirm');
    expect(mocks.prepareHatchCommand).not.toHaveBeenCalled();
  });

  it('applies the selected catalog column count directly to the grid', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    const columnSelect = screen.getByLabelText('settings.pet.catalogColumns');
    const grid = screen.getByTestId('pet-catalog-grid');

    expect(grid.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    fireEvent.change(columnSelect, { target: { value: '6' } });

    expect(mocks.setConfig).toHaveBeenCalledWith({ catalogColumns: 6 });
    expect(grid.style.gridTemplateColumns).toBe('repeat(6, minmax(0, 1fr))');
  });

  it('requests catalog with selected page size and sort', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    mocks.getCatalog.mockClear();

    fireEvent.change(screen.getByLabelText('settings.pet.catalogPageSize'), { target: { value: '24' } });
    expect(mocks.setConfig).toHaveBeenCalledWith({ catalogPageSize: 24 });
    act(() => vi.advanceTimersByTime(250));
    expect(mocks.getCatalog).toHaveBeenCalledWith(false, '', 0, 24, 'default', expect.any(Number));

    mocks.getCatalog.mockClear();
    fireEvent.change(screen.getByLabelText('settings.pet.catalogSort'), { target: { value: 'name_asc' } });
    expect(mocks.setConfig).toHaveBeenCalledWith({ catalogSort: 'name_asc' });
    act(() => vi.advanceTimersByTime(250));
    expect(mocks.getCatalog).toHaveBeenCalledWith(false, '', 0, 24, 'name_asc', expect.any(Number));
  });

  it('searches by pet metadata query', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    mocks.getCatalog.mockClear();

    const search = screen.getByPlaceholderText('settings.pet.searchPlaceholder');
    fireEvent.change(search, { target: { value: 'tester' } });
    act(() => vi.advanceTimersByTime(250));

    expect(mocks.getCatalog).toHaveBeenCalledWith(false, 'tester', 0, 12, 'default', expect.any(Number));
  });

  it('normalizes overlong catalog searches before matching responses', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    mocks.getCatalog.mockClear();
    const query = 'A'.repeat(120);

    fireEvent.change(screen.getByPlaceholderText('settings.pet.searchPlaceholder'), {
      target: { value: query },
    });
    act(() => vi.advanceTimersByTime(250));

    const normalizedQuery = 'a'.repeat(100);
    expect(mocks.getCatalog).toHaveBeenCalledWith(
      false, normalizedQuery, 0, 12, 'default', expect.any(Number),
    );
    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('matched', 'Matched Pet')],
      total: 1,
      offset: 0,
      limit: 12,
      query: normalizedQuery,
      sort: 'default',
      requestId: mocks.getCatalog.mock.calls.at(-1)?.[5] as number,
    }));

    expect(screen.getByText('Matched Pet')).toBeTruthy();
  });

  it('refreshes the current catalog page when another window changes pet assets', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('one', 'Pet One')],
      total: 25,
      offset: 12,
      limit: 12,
      query: '',
      sort: 'default',
    }));
    mocks.getCatalog.mockClear();
    const localPetRequestsBeforeEvent = mocks.getLocalPets.mock.calls.length;

    act(() => mocks.assetChangeListeners[0]!());

    expect(mocks.getLocalPets.mock.calls.length).toBeGreaterThan(localPetRequestsBeforeEvent);
    expect(mocks.getCatalog).toHaveBeenCalledWith(false, '', 12, 12, 'default', expect.any(Number));
  });

  it('filters installed pets by alias, original name, and stable id', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    act(() => mocks.localPetListeners[0]!([
      localPet('same-name/spritesheet.png', 'Desk Pet', 'Original Pet', 'same-name'),
      localPet('another/spritesheet.png', 'Another Pet', 'Another Pet', 'another'),
    ]));

    fireEvent.click(screen.getByRole('combobox', { name: 'settings.pet.currentPet' }));
    const searchInput = screen.getByLabelText('settings.pet.petSearchPlaceholder');
    fireEvent.change(searchInput, { target: { value: 'original' } });

    expect(screen.getByRole('option', { name: /Desk Pet/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Another Pet/ })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /Desk Pet/ }));
    expect(mocks.setConfig).toHaveBeenCalledWith({ selectedPetId: 'same-name/spritesheet.png' });
  });

  it('loads only the selected local pet preview on demand', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    act(() => mocks.localPetListeners[0]!([
      localPet('same-name/spritesheet.png', 'Desk Pet', 'Original Pet', 'same-name', false),
    ]));

    fireEvent.click(screen.getByRole('combobox', { name: 'settings.pet.currentPet' }));
    fireEvent.click(screen.getByRole('option', { name: /Desk Pet/ }));

    expect(mocks.getLocalPreview).toHaveBeenCalledWith('same-name/spritesheet.png');
  });

  it('opens keyboard selection on the currently selected pet', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    act(() => mocks.localPetListeners[0]!([
      localPet('same-name/spritesheet.png', 'Desk Pet', 'Original Pet', 'same-name'),
    ]));
    const trigger = screen.getByRole('combobox', { name: 'settings.pet.currentPet' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Desk Pet/ }));
    mocks.setConfig.mockClear();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText('settings.pet.petSearchPlaceholder'), { key: 'Enter' });

    expect(mocks.setConfig).toHaveBeenCalledWith({ selectedPetId: 'same-name/spritesheet.png' });
  });

  it('saves a local alias for the selected managed Petdex pet', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    act(() => mocks.localPetListeners[0]!([
      localPet('same-name/spritesheet.png', 'Original Pet', 'Original Pet', 'same-name'),
    ]));

    fireEvent.click(screen.getByRole('combobox', { name: 'settings.pet.currentPet' }));
    fireEvent.click(screen.getByRole('option', { name: /Original Pet/ }));
    const aliasInput = screen.getByLabelText('settings.pet.alias');
    fireEvent.change(aliasInput, { target: { value: 'Desk Pet' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.saveAlias' }));

    expect(mocks.setAlias).toHaveBeenCalledWith('same-name', 'Desk Pet');
  });

  it('keeps a pet operation pending when an unrelated operation completes', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    act(() => mocks.localPetListeners[0]!([
      localPet('same-name/spritesheet.png', 'Original Pet', 'Original Pet', 'same-name'),
    ]));
    fireEvent.click(screen.getByRole('combobox', { name: 'settings.pet.currentPet' }));
    fireEvent.click(screen.getByRole('option', { name: /Original Pet/ }));
    fireEvent.change(screen.getByLabelText('settings.pet.alias'), { target: { value: 'Desk Pet' } });
    const saveButton = screen.getByRole('button', { name: 'settings.pet.saveAlias' });
    fireEvent.click(saveButton);
    expect(saveButton).toHaveProperty('disabled', true);

    act(() => mocks.operationListeners[0]!({ operation: 'skill-command', success: true }));
    expect(saveButton).toHaveProperty('disabled', true);

    act(() => mocks.operationListeners[0]!({ operation: 'alias', success: true, slug: 'same-name' }));
    expect(saveButton).toHaveProperty('disabled', false);
  });

  it('jumps to a manually entered page number', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('one', 'Pet One')],
      total: 37,
      offset: 0,
      limit: 12,
      query: '',
      sort: 'default',
    }));
    mocks.getCatalog.mockClear();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'settings.pet.pageJump' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.goToPage' }));

    expect(mocks.getCatalog).toHaveBeenCalledWith(false, '', 24, 12, 'default', expect.any(Number));
  });

  it('commits a manually entered page number on blur', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('one', 'Pet One')],
      total: 37,
      offset: 0,
      limit: 12,
      query: '',
      sort: 'default',
    }));
    mocks.getCatalog.mockClear();

    const pageInput = screen.getByRole('spinbutton', { name: 'settings.pet.pageJump' });
    fireEvent.change(pageInput, { target: { value: '3' } });
    fireEvent.blur(pageInput);

    expect(mocks.getCatalog).toHaveBeenCalledWith(false, '', 24, 12, 'default', expect.any(Number));
  });

  it('ignores an older page response that arrives after a newer request', () => {
    render(<PetSettingsSection addToast={vi.fn()} />);
    openPetdexTab();
    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('one', 'Pet One')],
      total: 37,
      offset: 0,
      limit: 12,
      query: '',
      sort: 'default',
    }));
    mocks.getCatalog.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'settings.pet.nextPage' }));
    const olderRequestId = mocks.getCatalog.mock.calls.at(-1)?.[5] as number;
    act(() => mocks.assetChangeListeners[0]!());
    const newerRequestId = mocks.getCatalog.mock.calls.at(-1)?.[5] as number;

    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('stale', 'Stale Pet')],
      total: 37,
      offset: 12,
      limit: 12,
      query: '',
      sort: 'default',
      requestId: olderRequestId,
    }));
    expect(screen.queryByText('Stale Pet')).toBeNull();

    act(() => mocks.catalogListeners[0]!({
      pets: [catalogPet('latest', 'Latest Pet')],
      total: 37,
      offset: 12,
      limit: 12,
      query: '',
      sort: 'default',
      requestId: newerRequestId,
    }));
    expect(screen.getByText('Latest Pet')).toBeTruthy();
    expect(screen.getByText('2 / 4')).toBeTruthy();
  });
});

function catalogPet(slug: string, displayName: string) {
  return {
    slug,
    displayName,
    kind: 'pixel',
    submittedBy: 'tester',
    installed: false,
    managed: false,
  };
}

function localPet(
  id: string,
  name: string,
  originalName: string,
  slug: string,
  includePreview = true,
): LocalPet {
  return {
    id,
    name,
    originalName,
    alias: name === originalName ? '' : name,
    source: 'petdex',
    managed: true,
    slug,
    dataUrl: includePreview ? 'data:image/png;base64,iVBORw0KGgo=' : undefined,
    spriteSheet: false,
  };
}
