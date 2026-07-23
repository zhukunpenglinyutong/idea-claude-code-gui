import { sendToJava } from '../../utils/bridge';

export type CatalogColumnCount = 3 | 4 | 5 | 6;
export type CatalogPageSize = 12 | 24 | 36 | 48;
export type CodexPetBubbleSize = 'small' | 'medium' | 'large' | 'xlarge';
export type CodexPetScope = 'project' | 'global';
export type CodexPetBubbleEvent =
  | 'task_started'
  | 'thinking'
  | 'running'
  | 'task_success'
  | 'task_error'
  | 'idle';
export type CatalogSort =
  | 'default'
  | 'name_asc'
  | 'name_desc'
  | 'author_asc'
  | 'kind_asc'
  | 'slug_asc';

export interface CodexPetConfig {
  enabled: boolean;
  selectedPetId: string;
  size: number;
  opacity: number;
  positionX: number;
  positionY: number;
  petdexConnectTimeoutSeconds: number;
  petdexRequestTimeoutSeconds: number;
  petdexRetryAttempts: number;
  catalogColumns: CatalogColumnCount;
  catalogPageSize: CatalogPageSize;
  catalogSort: CatalogSort;
  showStatusIndicator: boolean;
  bubbleEnabled: boolean;
  bubbleDurationSeconds: number;
  bubbleSize: CodexPetBubbleSize;
  bubbleShowForBackgroundTabs: boolean;
  bubbleTemplates: Record<CodexPetBubbleEvent, string[]>;
  scope: CodexPetScope;
}

export interface CodexPetBubblePayload {
  event: CodexPetBubbleEvent;
  sourceId: string;
  tabTitle?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  background?: boolean;
}

export interface LocalCodexPet {
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

export interface LocalPetPreviewPayload {
  petId: string;
  dataUrl?: string;
  spriteSheet: boolean;
  error?: string;
}

export interface PetdexCatalogPet {
  slug: string;
  displayName: string;
  kind: string;
  submittedBy: string;
  installed: boolean;
  managed: boolean;
  alias?: string;
}

export interface CodexPetOperation {
  operation: 'configure' | 'install' | 'uninstall' | 'alias' | 'open-directory' | 'skill-command';
  success: boolean;
  slug?: string;
  petId?: string;
  error?: string;
}

export interface HatchPetStatus {
  status: 'missing' | 'installed' | 'broken';
  skillPath: string;
  officialUrl: string;
}

export interface PetdexCatalogPayload {
  pets: PetdexCatalogPet[];
  total: number;
  offset: number;
  limit: number;
  query: string;
  sort: CatalogSort;
  requestId?: number;
  error?: string;
}

export interface PetdexPreviewPayload {
  slug: string;
  dataUrl?: string;
  error?: string;
}

type Listener<T> = (payload: T) => void;

const configListeners = new Set<Listener<CodexPetConfig>>();
const localPetListeners = new Set<Listener<LocalCodexPet[]>>();
const localPreviewListeners = new Set<Listener<LocalPetPreviewPayload>>();
const assetChangeListeners = new Set<() => void>();
const catalogListeners = new Set<Listener<PetdexCatalogPayload>>();
const previewListeners = new Set<Listener<PetdexPreviewPayload>>();
const operationListeners = new Set<Listener<CodexPetOperation>>();
const hatchStatusListeners = new Set<Listener<HatchPetStatus>>();
const hatchReferenceListeners = new Set<Listener<string>>();
const hatchCommandListeners = new Set<Listener<string>>();
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const SAFE_PETDEX_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const BUBBLE_EVENTS: CodexPetBubbleEvent[] = [
  'task_started',
  'thinking',
  'running',
  'task_success',
  'task_error',
  'idle',
];
export const DEFAULT_BUBBLE_TEMPLATES: Record<CodexPetBubbleEvent, string[]> = {
  task_started: ['Task started: {tabTitle}'],
  thinking: ['Thinking...', 'Working through it'],
  running: ['Running...', 'Making progress'],
  task_success: ['Task complete', '{tabTitle} is done'],
  task_error: ['Task failed', '{tabTitle} needs attention'],
  idle: ['Ready'],
};
const previewCache = new Map<string, string>();
const pendingPreviews = new Set<string>();
const localPreviewCache = new Map<string, LocalPetPreviewPayload>();
const pendingLocalPreviews = new Set<string>();
const MAX_LOCAL_PREVIEW_CACHE_ENTRIES = 12;
const MAX_LOCAL_PREVIEW_CACHE_CHARS = 8 * 1024 * 1024;
let callbacksInstalled = false;

function cacheLocalPreview(preview: LocalPetPreviewPayload): void {
  if (!preview.dataUrl || preview.dataUrl.length > MAX_LOCAL_PREVIEW_CACHE_CHARS) return;
  localPreviewCache.delete(preview.petId);
  localPreviewCache.set(preview.petId, preview);
  let totalChars = 0;
  localPreviewCache.forEach((cached) => { totalChars += cached.dataUrl?.length ?? 0; });
  while (localPreviewCache.size > MAX_LOCAL_PREVIEW_CACHE_ENTRIES
    || totalChars > MAX_LOCAL_PREVIEW_CACHE_CHARS) {
    const oldestKey = localPreviewCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const removed = localPreviewCache.get(oldestKey);
    totalChars -= removed?.dataUrl?.length ?? 0;
    localPreviewCache.delete(oldestKey);
  }
}

function parseJsonObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseConfig(json: string): CodexPetConfig | null {
  const value = parseJsonObject(json);
  if (!value
    || typeof value.enabled !== 'boolean'
    || typeof value.selectedPetId !== 'string'
    || typeof value.size !== 'number'
    || typeof value.opacity !== 'number') {
    return null;
  }
  return {
    enabled: value.enabled,
    selectedPetId: value.selectedPetId,
    size: value.size,
    opacity: value.opacity,
    positionX: typeof value.positionX === 'number' ? value.positionX : 0.88,
    positionY: typeof value.positionY === 'number' ? value.positionY : 0.78,
    petdexConnectTimeoutSeconds: typeof value.petdexConnectTimeoutSeconds === 'number'
      ? value.petdexConnectTimeoutSeconds : 30,
    petdexRequestTimeoutSeconds: typeof value.petdexRequestTimeoutSeconds === 'number'
      ? value.petdexRequestTimeoutSeconds : 60,
    petdexRetryAttempts: typeof value.petdexRetryAttempts === 'number'
      ? value.petdexRetryAttempts : 3,
    catalogColumns: typeof value.catalogColumns === 'number'
      && Number.isInteger(value.catalogColumns)
      && value.catalogColumns >= 3
      && value.catalogColumns <= 6
      ? value.catalogColumns as CatalogColumnCount
      : 4,
    catalogPageSize: typeof value.catalogPageSize === 'number'
      && [12, 24, 36, 48].includes(value.catalogPageSize)
      ? value.catalogPageSize as CatalogPageSize
      : 12,
    catalogSort: parseCatalogSort(value.catalogSort),
    showStatusIndicator: typeof value.showStatusIndicator === 'boolean'
      ? value.showStatusIndicator
      : false,
    bubbleEnabled: typeof value.bubbleEnabled === 'boolean' ? value.bubbleEnabled : true,
    bubbleDurationSeconds: typeof value.bubbleDurationSeconds === 'number'
      ? value.bubbleDurationSeconds
      : 4,
    bubbleSize: parseBubbleSize(value.bubbleSize),
    bubbleShowForBackgroundTabs: typeof value.bubbleShowForBackgroundTabs === 'boolean'
      ? value.bubbleShowForBackgroundTabs
      : false,
    bubbleTemplates: parseBubbleTemplates(value.bubbleTemplates),
    scope: parseScope(value.scope),
  };
}

function parseScope(value: unknown): CodexPetScope {
  return value === 'global' ? 'global' : 'project';
}

function parseBubbleSize(value: unknown): CodexPetBubbleSize {
  return typeof value === 'string' && ['small', 'medium', 'large', 'xlarge'].includes(value)
    ? value as CodexPetBubbleSize
    : 'medium';
}

function parseBubbleTemplates(value: unknown): Record<CodexPetBubbleEvent, string[]> {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return BUBBLE_EVENTS.reduce((result, event) => {
    const templates = source[event];
    result[event] = Array.isArray(templates)
      ? templates
          .filter((template): template is string => typeof template === 'string' && template.trim().length > 0)
          .slice(0, 10)
      : DEFAULT_BUBBLE_TEMPLATES[event];
    return result;
  }, {} as Record<CodexPetBubbleEvent, string[]>);
}

function parseCatalogSort(value: unknown): CatalogSort {
  return typeof value === 'string'
    && ['default', 'name_asc', 'name_desc', 'author_asc', 'kind_asc', 'slug_asc'].includes(value)
    ? value as CatalogSort
    : 'default';
}

function parseLocalPets(json: string): LocalCodexPet[] {
  const value = parseJsonObject(json);
  if (!value || !Array.isArray(value.pets)) return [];
  return value.pets.filter((pet): pet is LocalCodexPet => {
    if (!pet || typeof pet !== 'object') return false;
    const candidate = pet as Partial<LocalCodexPet>;
    return typeof candidate.id === 'string'
      && typeof candidate.name === 'string'
      && (candidate.dataUrl === undefined
        || (typeof candidate.dataUrl === 'string' && SAFE_IMAGE_DATA_URL.test(candidate.dataUrl)));
  }).map((pet) => ({
    ...pet,
    originalName: typeof pet.originalName === 'string' ? pet.originalName : pet.name,
    alias: typeof pet.alias === 'string' ? pet.alias : '',
    source: typeof pet.source === 'string' ? pet.source : 'local',
    managed: pet.managed === true,
    slug: typeof pet.slug === 'string' && SAFE_PETDEX_SLUG.test(pet.slug) ? pet.slug : undefined,
    spriteSheet: pet.spriteSheet === true,
  }));
}

function parseLocalPreview(json: string): LocalPetPreviewPayload | null {
  const value = parseJsonObject(json);
  if (!value || typeof value.petId !== 'string' || value.petId.length === 0) return null;
  const dataUrl = typeof value.dataUrl === 'string' && SAFE_IMAGE_DATA_URL.test(value.dataUrl)
    ? value.dataUrl
    : undefined;
  const error = typeof value.error === 'string' ? value.error : undefined;
  if (!dataUrl && !error) return null;
  return {
    petId: value.petId,
    dataUrl,
    spriteSheet: value.spriteSheet === true,
    error,
  };
}

function parseCatalog(json: string): PetdexCatalogPayload {
  const value = parseJsonObject(json);
  if (!value) {
    return {
      pets: [],
      total: 0,
      offset: 0,
      limit: 12,
      query: '',
      sort: 'default',
      error: 'INVALID_PETDEX_RESPONSE',
    };
  }
  const pets = Array.isArray(value.pets)
    ? value.pets.filter((pet): pet is PetdexCatalogPet => {
        if (!pet || typeof pet !== 'object') return false;
        const candidate = pet as Partial<PetdexCatalogPet>;
        return typeof candidate.slug === 'string'
          && SAFE_PETDEX_SLUG.test(candidate.slug)
          && typeof candidate.displayName === 'string'
          && typeof candidate.installed === 'boolean'
          && typeof candidate.managed === 'boolean';
      }).map((pet) => ({
        ...pet,
        kind: typeof pet.kind === 'string' ? pet.kind : '',
        submittedBy: typeof pet.submittedBy === 'string' ? pet.submittedBy : '',
        alias: typeof pet.alias === 'string' ? pet.alias : undefined,
      }))
    : [];
  return {
    pets,
    total: typeof value.total === 'number' && Number.isFinite(value.total) ? Math.max(0, value.total) : pets.length,
    offset: typeof value.offset === 'number' && Number.isFinite(value.offset) ? Math.max(0, value.offset) : 0,
    limit: typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.max(1, value.limit) : 12,
    query: typeof value.query === 'string' ? value.query : '',
    sort: parseCatalogSort(value.sort),
    requestId: typeof value.requestId === 'number' && Number.isInteger(value.requestId)
      ? value.requestId
      : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

function parseOperation(json: string): CodexPetOperation | null {
  const value = parseJsonObject(json);
  if (!value || typeof value.operation !== 'string' || typeof value.success !== 'boolean') return null;
  if (!['configure', 'install', 'uninstall', 'alias', 'open-directory', 'skill-command']
    .includes(value.operation)) return null;
  return {
    operation: value.operation as CodexPetOperation['operation'],
    success: value.success,
    slug: typeof value.slug === 'string' ? value.slug : undefined,
    petId: typeof value.petId === 'string' ? value.petId : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

function parseHatchStatus(json: string): HatchPetStatus | null {
  const value = parseJsonObject(json);
  if (!value || !['missing', 'installed', 'broken'].includes(String(value.status))
    || typeof value.skillPath !== 'string' || typeof value.officialUrl !== 'string') return null;
  return {
    status: value.status as HatchPetStatus['status'],
    skillPath: value.skillPath,
    officialUrl: value.officialUrl,
  };
}

function parseHatchCommand(json: string): string | null {
  const value = parseJsonObject(json);
  const command = value?.command;
  if (typeof command !== 'string' || command.length === 0 || command.length > 2048) return null;
  return command === '$skill-installer hatch-pet' || command.startsWith('$hatch-pet ')
    ? command
    : null;
}

function parsePreview(json: string): PetdexPreviewPayload | null {
  const value = parseJsonObject(json);
  if (!value || typeof value.slug !== 'string' || !SAFE_PETDEX_SLUG.test(value.slug)) return null;
  const dataUrl = typeof value.dataUrl === 'string' && SAFE_IMAGE_DATA_URL.test(value.dataUrl)
    ? value.dataUrl
    : undefined;
  const error = typeof value.error === 'string' ? value.error : undefined;
  if (!dataUrl && !error) return null;
  return { slug: value.slug, dataUrl, error };
}

function installCallbacks(): void {
  if (callbacksInstalled) return;
  callbacksInstalled = true;
  window.updateCodexPetConfig = (json) => {
    const config = parseConfig(json);
    if (config) configListeners.forEach((listener) => listener(config));
  };
  window.updateCodexPets = (json) => {
    const pets = parseLocalPets(json);
    localPreviewCache.clear();
    pendingLocalPreviews.clear();
    localPetListeners.forEach((listener) => listener(pets));
  };
  window.updateCodexPetPreview = (json) => {
    const preview = parseLocalPreview(json);
    if (!preview) return;
    pendingLocalPreviews.delete(preview.petId);
    cacheLocalPreview(preview);
    localPreviewListeners.forEach((listener) => listener(preview));
  };
  window.onCodexPetAssetsChanged = () => {
    localPreviewCache.clear();
    pendingLocalPreviews.clear();
    assetChangeListeners.forEach((listener) => listener());
  };
  window.updatePetdexCatalog = (json) => {
    const catalog = parseCatalog(json);
    catalogListeners.forEach((listener) => listener(catalog));
  };
  window.updatePetdexPreview = (json) => {
    const preview = parsePreview(json);
    if (!preview) return;
    pendingPreviews.delete(preview.slug);
    if (preview.dataUrl) previewCache.set(preview.slug, preview.dataUrl);
    previewListeners.forEach((listener) => listener(preview));
  };
  window.onCodexPetOperation = (json) => {
    const operation = parseOperation(json);
    if (operation) operationListeners.forEach((listener) => listener(operation));
  };
  window.updateHatchPetStatus = (json) => {
    const status = parseHatchStatus(json);
    if (status) hatchStatusListeners.forEach((listener) => listener(status));
  };
  window.updateHatchPetReference = (json) => {
    const value = parseJsonObject(json);
    const path = value?.path;
    if (typeof path === 'string') {
      hatchReferenceListeners.forEach((listener) => listener(path));
    }
  };
  window.onHatchPetCommandPrepared = (json) => {
    const command = parseHatchCommand(json);
    if (command) hatchCommandListeners.forEach((listener) => listener(command));
  };
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  installCallbacks();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const petBridge = {
  subscribeConfig: (listener: Listener<CodexPetConfig>) => subscribe(configListeners, listener),
  subscribeLocalPets: (listener: Listener<LocalCodexPet[]>) => subscribe(localPetListeners, listener),
  subscribeLocalPreview: (listener: Listener<LocalPetPreviewPayload>) =>
    subscribe(localPreviewListeners, listener),
  subscribeAssetChanges: (listener: () => void) => subscribe(assetChangeListeners, listener),
  subscribeCatalog: (listener: Listener<PetdexCatalogPayload>) =>
    subscribe(catalogListeners, listener),
  subscribePreview: (listener: Listener<PetdexPreviewPayload>) => subscribe(previewListeners, listener),
  subscribeOperation: (listener: Listener<CodexPetOperation>) => subscribe(operationListeners, listener),
  subscribeHatchStatus: (listener: Listener<HatchPetStatus>) => subscribe(hatchStatusListeners, listener),
  subscribeHatchReference: (listener: Listener<string>) => subscribe(hatchReferenceListeners, listener),
  subscribeHatchCommand: (listener: Listener<string>) => subscribe(hatchCommandListeners, listener),
  getConfig: () => sendToJava('get_codex_pet_config'),
  setConfig: (config: Partial<CodexPetConfig>) =>
    sendToJava('set_codex_pet_config', config),
  getLocalPets: () => sendToJava('get_codex_pets'),
  refreshAssets: () => sendToJava('refresh_codex_pet_assets'),
  getLocalPreview: (petId: string) => {
    const cached = localPreviewCache.get(petId);
    if (cached) {
      localPreviewCache.delete(petId);
      localPreviewCache.set(petId, cached);
      localPreviewListeners.forEach((listener) => listener(cached));
      return;
    }
    if (!petId || petId.length > 512 || pendingLocalPreviews.has(petId)) return;
    pendingLocalPreviews.add(petId);
    sendToJava('get_codex_pet_preview', { petId });
  },
  getCatalog: (
    forceRefresh = false,
    query = '',
    offset = 0,
    limit: CatalogPageSize = 12,
    sort: CatalogSort = 'default',
    requestId?: number,
  ) => sendToJava('get_petdex_catalog', {
    forceRefresh,
    query,
    offset,
    limit,
    sort,
    ...(requestId === undefined ? {} : { requestId }),
  }),
  getPreview: (slug: string) => {
    const cached = previewCache.get(slug);
    if (cached) {
      previewListeners.forEach((listener) => listener({ slug, dataUrl: cached }));
      return;
    }
    if (!SAFE_PETDEX_SLUG.test(slug) || pendingPreviews.has(slug)) return;
    pendingPreviews.add(slug);
    sendToJava('get_petdex_preview', { slug });
  },
  install: (slug: string) => sendToJava('install_petdex_pet', { slug }),
  uninstall: (slug: string) => sendToJava('uninstall_petdex_pet', { slug }),
  setAlias: (slug: string, alias: string) => sendToJava('set_petdex_pet_alias', { slug, alias }),
  resetPosition: () => sendToJava('reset_codex_pet_position'),
  openWebsite: () => sendToJava('open_petdex_website'),
  openPetDirectory: () => sendToJava('open_codex_pet_directory'),
  getHatchStatus: () => sendToJava('get_hatch_pet_status'),
  openHatchWebsite: () => sendToJava('open_hatch_pet_website'),
  chooseHatchReference: () => sendToJava('choose_hatch_pet_reference'),
  prepareHatchCommand: (payload: {
    action: 'install' | 'create' | 'repair';
    name?: string;
    description?: string;
    style?: string;
    referencePath?: string;
  }) => sendToJava('prepare_hatch_pet_command', payload),
  updateState: (sourceId: string, state: string) =>
    sendToJava('set_codex_pet_state', { sourceId, state }),
  showBubble: (payload: CodexPetBubblePayload) =>
    sendToJava('show_codex_pet_bubble', payload),
};

export {
  parseBubbleTemplates,
  parseCatalog,
  parseConfig,
  parseLocalPets,
  parseLocalPreview,
  parseHatchCommand,
  parseHatchStatus,
  parsePreview,
};
