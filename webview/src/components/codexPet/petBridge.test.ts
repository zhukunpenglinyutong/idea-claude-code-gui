import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToJava } from '../../utils/bridge';
import {
  DEFAULT_BUBBLE_TEMPLATES,
  parseCatalog,
  parseConfig,
  parseHatchCommand,
  parseHatchStatus,
  parseLocalPreview,
  parseLocalPets,
  parsePreview,
  petBridge,
} from './petBridge';

vi.mock('../../utils/bridge', () => ({ sendToJava: vi.fn() }));

describe('petBridge payload validation', () => {
  beforeEach(() => {
    vi.mocked(sendToJava).mockClear();
  });

  it('accepts a valid persisted config and rejects incomplete payloads', () => {
    expect(parseConfig(JSON.stringify({
      enabled: true,
      selectedPetId: 'cat/spritesheet.webp',
      size: 96,
      opacity: 0.8,
      positionX: 0.5,
      positionY: 0.6,
      petdexConnectTimeoutSeconds: 45,
      petdexRequestTimeoutSeconds: 90,
      petdexRetryAttempts: 4,
      catalogColumns: 6,
      catalogPageSize: 24,
      catalogSort: 'name_desc',
      showStatusIndicator: true,
      bubbleEnabled: true,
      bubbleDurationSeconds: 6,
      bubbleSize: 'large',
      bubbleShowForBackgroundTabs: true,
      bubbleTemplates: {
        task_started: ['Start {tabTitle}'],
        thinking: ['Thinking'],
        running: ['Running'],
        task_success: ['Done'],
        task_error: ['Failed'],
        idle: ['Ready'],
      },
      scope: 'global',
    }))).toMatchObject({
      enabled: true,
      selectedPetId: 'cat/spritesheet.webp',
      size: 96,
      petdexConnectTimeoutSeconds: 45,
      petdexRequestTimeoutSeconds: 90,
      petdexRetryAttempts: 4,
      catalogColumns: 6,
      catalogPageSize: 24,
      catalogSort: 'name_desc',
      showStatusIndicator: true,
      bubbleEnabled: true,
      bubbleDurationSeconds: 6,
      bubbleSize: 'large',
      bubbleShowForBackgroundTabs: true,
      bubbleTemplates: {
        task_started: ['Start {tabTitle}'],
      },
      scope: 'global',
    });
    expect(parseConfig(JSON.stringify({
      enabled: true,
      selectedPetId: 'builtin',
      size: 96,
      opacity: 1,
      positionX: 0.5,
      positionY: 0.6,
      catalogColumns: 7,
      catalogPageSize: 99,
      catalogSort: 'invalid',
    }))).toMatchObject({ catalogColumns: 4 });
    expect(parseConfig('{"enabled":true}')).toBeNull();
  });

  it('accepts metadata-only local pets and drops unsafe image payloads', () => {
    const pets = parseLocalPets(JSON.stringify({ pets: [
      {
        id: 'safe/spritesheet.png',
        name: 'My Alias',
        originalName: 'Safe',
        alias: 'My Alias',
        source: 'petdex',
        managed: true,
        slug: 'safe',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        spriteSheet: false,
      },
      { id: 'metadata-only/idle.png', name: 'Metadata Only', spriteSheet: false },
      { id: 'unsafe.svg', name: 'Unsafe', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    ] }));

    expect(pets).toHaveLength(2);
    expect(pets[0]).toMatchObject({
      id: 'safe/spritesheet.png',
      name: 'My Alias',
      originalName: 'Safe',
      alias: 'My Alias',
      managed: true,
      slug: 'safe',
    });
  });

  it('accepts only safe local preview payloads', () => {
    expect(parseLocalPreview(JSON.stringify({
      petId: 'pixel-cat/spritesheet.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      spriteSheet: true,
    }))).toMatchObject({ petId: 'pixel-cat/spritesheet.png', spriteSheet: true });
    expect(parseLocalPreview(JSON.stringify({
      petId: 'pixel-cat/spritesheet.png',
      dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
    }))).toBeNull();
  });

  it('drops catalog entries with unsafe slugs', () => {
    const catalog = parseCatalog(JSON.stringify({
      query: 'safe', total: 1, offset: 0, limit: 24, sort: 'slug_asc', requestId: 42, pets: [
      {
        slug: 'safe', displayName: 'Safe', alias: 'My Alias',
        installed: false, managed: false,
      },
      {
        slug: '../unsafe', displayName: 'Unsafe',
        installed: false, managed: false,
      },
    ] }));

    expect(catalog.pets).toHaveLength(1);
    expect(catalog.pets[0].slug).toBe('safe');
    expect(catalog.pets[0].alias).toBe('My Alias');
    expect(catalog.query).toBe('safe');
    expect(catalog.limit).toBe(24);
    expect(catalog.sort).toBe('slug_asc');
    expect(catalog.requestId).toBe(42);
  });

  it('accepts only safe preview payloads', () => {
    expect(parsePreview(JSON.stringify({
      slug: 'pixel-cat',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }))).toMatchObject({ slug: 'pixel-cat' });
    expect(parsePreview(JSON.stringify({
      slug: '../escape',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }))).toBeNull();
    expect(parsePreview(JSON.stringify({
      slug: 'pixel-cat',
      dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
    }))).toBeNull();
  });

  it('keeps default bubble templates readable', () => {
    expect(DEFAULT_BUBBLE_TEMPLATES.task_started[0]).toBe('Task started: {tabTitle}');
    expect(DEFAULT_BUBBLE_TEMPLATES.task_success[0]).toBe('Task complete');
    expect(DEFAULT_BUBBLE_TEMPLATES.idle[0]).toBe('Ready');
  });

  it('accepts only complete hatch-pet status payloads', () => {
    expect(parseHatchStatus(JSON.stringify({
      status: 'installed',
      skillPath: 'C:/Users/test/.codex/skills/hatch-pet',
      officialUrl: 'https://github.com/openai/skills',
    }))).toMatchObject({ status: 'installed' });
    expect(parseHatchStatus('{"status":"unknown"}')).toBeNull();
  });

  it('accepts and dispatches only supported hatch-pet commands', () => {
    expect(parseHatchCommand('{"command":"$skill-installer hatch-pet"}'))
      .toBe('$skill-installer hatch-pet');
    expect(parseHatchCommand('{"command":"rm -rf project"}')).toBeNull();
    const listener = vi.fn();
    const unsubscribe = petBridge.subscribeHatchCommand(listener);

    window.onHatchPetCommandPrepared?.('{"command":"$hatch-pet Create a pet."}');
    window.onHatchPetCommandPrepared?.('{"command":"unsupported"}');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('$hatch-pet Create a pet.');
    unsubscribe();
  });

  it('requests a backend rescan for externally generated pet assets', () => {
    petBridge.refreshAssets();

    expect(sendToJava).toHaveBeenCalledWith('refresh_codex_pet_assets');
  });

  it('passes event names and payloads separately to the Java bridge', () => {
    petBridge.setConfig({ enabled: false });
    petBridge.getCatalog(false, 'cat', 24, 24, 'name_asc');
    petBridge.getLocalPreview('pixel-cat/spritesheet.png');
    petBridge.getPreview('pixel-cat-preview');
    petBridge.install('pixel-cat');
    petBridge.uninstall('pixel-cat');
    petBridge.setAlias('pixel-cat', 'Desk Cat');
    petBridge.updateState('session-1', 'running');
    petBridge.showBubble({
      event: 'task_success',
      sourceId: 'session-1',
      tabTitle: 'Tab',
      durationMs: 12_800,
    });
    petBridge.openPetDirectory();
    petBridge.getHatchStatus();
    petBridge.openHatchWebsite();
    petBridge.chooseHatchReference();
    petBridge.prepareHatchCommand({ action: 'create', name: 'Desk Cat' });

    expect(sendToJava).toHaveBeenNthCalledWith(1, 'set_codex_pet_config', { enabled: false });
    expect(sendToJava).toHaveBeenNthCalledWith(
      2,
      'get_petdex_catalog',
      { forceRefresh: false, query: 'cat', offset: 24, limit: 24, sort: 'name_asc' },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(
      3,
      'get_codex_pet_preview',
      { petId: 'pixel-cat/spritesheet.png' },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(
      4,
      'get_petdex_preview',
      { slug: 'pixel-cat-preview' },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(5, 'install_petdex_pet', { slug: 'pixel-cat' });
    expect(sendToJava).toHaveBeenNthCalledWith(6, 'uninstall_petdex_pet', { slug: 'pixel-cat' });
    expect(sendToJava).toHaveBeenNthCalledWith(
      7,
      'set_petdex_pet_alias',
      { slug: 'pixel-cat', alias: 'Desk Cat' },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(
      8,
      'set_codex_pet_state',
      { sourceId: 'session-1', state: 'running' },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(
      9,
      'show_codex_pet_bubble',
      { event: 'task_success', sourceId: 'session-1', tabTitle: 'Tab', durationMs: 12_800 },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(10, 'open_codex_pet_directory');
    expect(sendToJava).toHaveBeenNthCalledWith(11, 'get_hatch_pet_status');
    expect(sendToJava).toHaveBeenNthCalledWith(12, 'open_hatch_pet_website');
    expect(sendToJava).toHaveBeenNthCalledWith(13, 'choose_hatch_pet_reference');
    expect(sendToJava).toHaveBeenNthCalledWith(14, 'prepare_hatch_pet_command', {
      action: 'create', name: 'Desk Cat',
    });
  });

  it('allows a local preview retry after the pet list is refreshed', () => {
    const petId = 'retry-pet/spritesheet.png';
    const unsubscribe = petBridge.subscribeLocalPets(() => {});

    petBridge.getLocalPreview(petId);
    petBridge.getLocalPreview(petId);
    expect(vi.mocked(sendToJava).mock.calls.filter((call) => call[0] === 'get_codex_pet_preview'))
      .toHaveLength(1);

    window.updateCodexPets?.('{"pets":[]}');
    petBridge.getLocalPreview(petId);

    expect(vi.mocked(sendToJava).mock.calls.filter((call) => call[0] === 'get_codex_pet_preview'))
      .toHaveLength(2);
    unsubscribe();
  });
});
