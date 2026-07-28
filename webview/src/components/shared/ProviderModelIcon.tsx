/**
 * Shared icon component that renders the correct vendor icon based on
 * provider ID and/or model ID.
 *
 * Replaces the duplicated ProviderIcon switch statements across:
 * - ModelSelect.tsx
 * - ProviderSelect.tsx
 * - BlinkingLogo/index.tsx
 * - HistoryView.tsx
 */
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color';
import ClaudeMono from '@lobehub/icons/es/Claude/components/Mono';
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono';
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color';
import GeminiMono from '@lobehub/icons/es/Gemini/components/Mono';
import QwenColor from '@lobehub/icons/es/Qwen/components/Color';
import QwenMono from '@lobehub/icons/es/Qwen/components/Mono';
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color';
import DeepSeekMono from '@lobehub/icons/es/DeepSeek/components/Mono';
import KimiColor from '@lobehub/icons/es/Kimi/components/Color';
import KimiMono from '@lobehub/icons/es/Kimi/components/Mono';
import BailianColor from '@lobehub/icons/es/Bailian/components/Color';
import BailianMono from '@lobehub/icons/es/Bailian/components/Mono';
import LongCatColor from '@lobehub/icons/es/LongCat/components/Color';
import LongCatMono from '@lobehub/icons/es/LongCat/components/Mono';
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono';
import MoonshotMono from '@lobehub/icons/es/Moonshot/components/Mono';
import ZhipuColor from '@lobehub/icons/es/Zhipu/components/Color';
import ZhipuMono from '@lobehub/icons/es/Zhipu/components/Mono';
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color';
import MinimaxMono from '@lobehub/icons/es/Minimax/components/Mono';
import DoubaoColor from '@lobehub/icons/es/Doubao/components/Color';
import DoubaoMono from '@lobehub/icons/es/Doubao/components/Mono';
import SparkColor from '@lobehub/icons/es/Spark/components/Color';
import SparkMono from '@lobehub/icons/es/Spark/components/Mono';
import HunyuanColor from '@lobehub/icons/es/Hunyuan/components/Color';
import HunyuanMono from '@lobehub/icons/es/Hunyuan/components/Mono';
import BaichuanColor from '@lobehub/icons/es/Baichuan/components/Color';
import BaichuanMono from '@lobehub/icons/es/Baichuan/components/Mono';
import MistralColor from '@lobehub/icons/es/Mistral/components/Color';
import MistralMono from '@lobehub/icons/es/Mistral/components/Mono';
import MetaColor from '@lobehub/icons/es/Meta/components/Color';
import MetaMono from '@lobehub/icons/es/Meta/components/Mono';
import CohereColor from '@lobehub/icons/es/Cohere/components/Color';
import CohereMono from '@lobehub/icons/es/Cohere/components/Mono';
import GrokMono from '@lobehub/icons/es/Grok/components/Mono';
import OpenRouterMono from '@lobehub/icons/es/OpenRouter/components/Mono';
import YiColor from '@lobehub/icons/es/Yi/components/Color';
import YiMono from '@lobehub/icons/es/Yi/components/Mono';
import XiaomiMiMoMono from '@lobehub/icons/es/XiaomiMiMo/components/Mono';
import type { ReactElement } from 'react';
import { resolveIconVendor, type ModelVendor } from '../../utils/modelIconMapping';

export interface ProviderModelIconProps {
  /** Provider type: claude, codex, gemini, etc. */
  providerId?: string;
  /** Model ID for vendor-specific icon resolution (e.g. "qwen3.5-plus") */
  modelId?: string;
  /** Icon size in pixels */
  size?: number;
  /** Whether to use colored variant (true) or avatar/mono variant (false) */
  colored?: boolean;
}

function getXiaomiWrapperStyle(size: number): React.CSSProperties {
  return {
    alignItems: 'center',
    background: '#000',
    borderRadius: Math.max(3, Math.round(size * 0.22)),
    color: '#fff',
    display: 'inline-flex',
    flex: 'none',
    height: size,
    justifyContent: 'center',
    lineHeight: 1,
    width: size,
  };
}

const XiaomiMiMoIcon = (size: number, colored: boolean): ReactElement => {
  if (!colored) {
    return <XiaomiMiMoMono size={size} />;
  }

  return (
    <span
      aria-label="XiaomiMiMo"
      role="img"
      style={getXiaomiWrapperStyle(size)}
    >
      <XiaomiMiMoMono size={Math.max(1, Math.round(size * 0.72))} />
    </span>
  );
};

/**
 * Icon renderers for each vendor.
 * Returns [coloredVersion, avatarVersion] JSX elements.
 */
const VENDOR_ICON_MAP: Record<
  ModelVendor,
  (size: number, colored: boolean) => ReactElement
> = {
  claude: (size, colored) =>
    colored ? <ClaudeColor size={size} /> : <ClaudeMono size={size} />,
  openai: (size, _colored) =>
    <OpenAIMono size={size} />,
  gemini: (size, colored) =>
    colored ? <GeminiColor size={size} /> : <GeminiMono size={size} />,
  qwen: (size, colored) =>
    colored ? <QwenColor size={size} /> : <QwenMono size={size} />,
  deepseek: (size, colored) =>
    colored ? <DeepSeekColor size={size} /> : <DeepSeekMono size={size} />,
  kimi: (size, colored) =>
    colored ? <KimiColor size={size} /> : <KimiMono size={size} />,
  bailian: (size, colored) =>
    colored ? <BailianColor size={size} /> : <BailianMono size={size} />,
  longcat: (size, colored) =>
    colored ? <LongCatColor size={size} /> : <LongCatMono size={size} />,
  opencode: (size, _colored) =>
    <OpenCodeMono size={size} />,
  moonshot: (size, _colored) =>
    <MoonshotMono size={size} />,
  zhipu: (size, colored) =>
    colored ? <ZhipuColor size={size} /> : <ZhipuMono size={size} />,
  minimax: (size, colored) =>
    colored ? <MinimaxColor size={size} /> : <MinimaxMono size={size} />,
  xiaomi: (size, colored) =>
    XiaomiMiMoIcon(size, colored),
  doubao: (size, colored) =>
    colored ? <DoubaoColor size={size} /> : <DoubaoMono size={size} />,
  spark: (size, colored) =>
    colored ? <SparkColor size={size} /> : <SparkMono size={size} />,
  hunyuan: (size, colored) =>
    colored ? <HunyuanColor size={size} /> : <HunyuanMono size={size} />,
  baichuan: (size, colored) =>
    colored ? <BaichuanColor size={size} /> : <BaichuanMono size={size} />,
  mistral: (size, colored) =>
    colored ? <MistralColor size={size} /> : <MistralMono size={size} />,
  meta: (size, colored) =>
    colored ? <MetaColor size={size} /> : <MetaMono size={size} />,
  cohere: (size, colored) =>
    colored ? <CohereColor size={size} /> : <CohereMono size={size} />,
  grok: (size, _colored) =>
    <GrokMono size={size} />,
  openrouter: (size, _colored) =>
    <OpenRouterMono size={size} />,
  yi: (size, colored) =>
    colored ? <YiColor size={size} /> : <YiMono size={size} />,
};

/**
 * Renders the appropriate vendor icon based on provider and model context.
 *
 * Resolution priority:
 * 1. modelId pattern match (most specific)
 * 2. providerId lookup
 * 3. Claude default
 */
export const ProviderModelIcon = ({
  providerId,
  modelId,
  size = 16,
  colored = false,
}: ProviderModelIconProps) => {
  const vendor = resolveIconVendor(providerId, modelId);
  const renderer = VENDOR_ICON_MAP[vendor];
  return renderer(size, colored);
};
