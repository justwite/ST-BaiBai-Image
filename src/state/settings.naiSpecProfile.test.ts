import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_NAI_NL_SPEC,
  DEFAULT_NAI_V5_EXAMPLE,
  DEFAULT_NAI_V5_EXAMPLE_TAGS_ONLY,
  DEFAULT_NAI_V5_SPEC,
  expandNaiSpec,
  expandNlMacro,
} from '@/state/settings';

/**
 * NAI 渠道新增「规范口径」与「生成自然语言」两个设置项的存量兼容。
 *
 * 这一批的核心诉求只有一条:**升级后行为必须逐字节不变**。
 * 两个默认值都是照着「本字段引入前的行为」定的——口径 'nai'(NAI 原生 Base + Character
 * Prompts)、自然语言 true(NAI 4.5 起一直带 nl)。存量配置里没有这两个键,必须在归一
 * 时补上默认而不是留 undefined:留空会让自动 tag 组装时读到 undefined,
 * 口径判断落进兜底分支,用户的规范就被静默换掉了。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: nai === undefined ? {} : { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('NAI 规范口径与自然语言的设置迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量 nai 段没有这两个键 → 回落 NAI 口径 + 自然语言开,升级后出图提示词零变化', async () => {
    const settings = await hydrateWithNai({ model: 'nai-diffusion-4-5-full', key: 'k' });
    expect(settings.nai.specProfile).toBe('nai');
    expect(settings.nai.naturalLanguage).toBe(true);
  });

  it('nai 段整个缺失 → 同样是 NAI 口径 + 自然语言开', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.specProfile).toBe('nai');
    expect(settings.nai.naturalLanguage).toBe(true);
  });

  it('用户已选过 → 原样保留,不被默认值顶掉', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-5-full',
      specProfile: 'comfy',
      naturalLanguage: false,
    });
    expect(settings.nai.specProfile).toBe('comfy');
    expect(settings.nai.naturalLanguage).toBe(false);
  });

  it('脏值归一到合法域:口径只认 comfy,自然语言只认布尔', async () => {
    const settings = await hydrateWithNai({
      specProfile: 'ComfyUI',
      naturalLanguage: 'false',
    });
    expect(settings.nai.specProfile).toBe('nai');
    expect(settings.nai.naturalLanguage).toBe(true);
  });

  it('自然语言显式为 false 时不会被当假值吞掉', async () => {
    const settings = await hydrateWithNai({ naturalLanguage: false });
    expect(settings.nai.naturalLanguage).toBe(false);
  });

  it('纯加法迁移,不动同批次的其余 NAI 字段', async () => {
    const settings = await hydrateWithNai({
      model: 'nai-diffusion-5-curated',
      sampler: 'k_dpmpp_2m',
      steps: 33,
      specProfile: 'comfy',
    });
    expect(settings.nai.model).toBe('nai-diffusion-5-curated');
    expect(settings.nai.sampler).toBe('k_dpmpp_2m');
    expect(settings.nai.steps).toBe(33);
    // 悬空画师串仍清空(与本次改动无关,顺带钉住归一顺序没被打乱)
    expect(settings.nai.activeArtistId).toBe('');
  });
});

/**
 * {{nl}} / {{nl_example}} 两处宏的展开口径。
 *
 * 两处必须**同时**受同一个开关控制,这是本组用例的存在理由:
 * 只置空 {{nl}} 而把带 nl 键的示例留在文末,模型会照抄示例照样输出 nl——
 * 开关看起来生效了(规范里确实没有 nl 条款),实际完全无效,而且极难排查。
 */
describe('NAI 规范的 nl 宏展开', () => {
  const pickExample = (spec: string) =>
    /^\{"position".*$/m.exec(spec)?.[0] ?? '';

  it('宏都已展开:渲染结果里不残留任何 {{...}} 占位符', () => {
    for (const on of [true, false]) {
      const spec = expandNaiSpec(DEFAULT_NAI_V5_SPEC, on);
      expect([on, spec.includes('{{')]).toEqual([on, false]);
    }
  });

  it('开启:补上 nl 条款,示例含 Base nl 与每角色 nl', () => {
    const spec = expandNaiSpec(DEFAULT_NAI_V5_SPEC, true);
    expect(spec).toContain(DEFAULT_NAI_NL_SPEC);
    expect(spec).toContain('"nl":"Two girls on a rooftop at sunset');
    expect(pickExample(spec)).toBe(DEFAULT_NAI_V5_EXAMPLE);
  });

  it('关闭:nl 条款整体消失,示例同步换成纯 tag 版', () => {
    const spec = expandNaiSpec(DEFAULT_NAI_V5_SPEC, false);
    expect(spec).not.toContain('- nl:');
    expect(spec).not.toContain('Write every nl in English');
    expect(spec).not.toContain('"nl"');
    expect(pickExample(spec)).toBe(DEFAULT_NAI_V5_EXAMPLE_TAGS_ONLY);
  });

  it('关闭时不留连续空行(宏独占一行,置空后会留下三个换行)', () => {
    const spec = expandNaiSpec(DEFAULT_NAI_V5_SPEC, false);
    expect(spec).not.toMatch(/\n{3,}/);
  });

  it('内置默认两版示例除 nl 键外逐字相同,避免开关顺带改掉别的东西', () => {
    const strip = (json: string) =>
      JSON.stringify(JSON.parse(json), (key, value) => (key === 'nl' ? undefined : value));
    expect(strip(DEFAULT_NAI_V5_EXAMPLE)).toBe(
      JSON.stringify(JSON.parse(DEFAULT_NAI_V5_EXAMPLE_TAGS_ONLY)),
    );
  });

  it('自定义规范漏写 {{nl}} → 开启时追加到末尾(防止开关静默失效),关闭时原样', () => {
    const custom = '我的规范正文';
    expect(expandNlMacro(custom, DEFAULT_NAI_NL_SPEC, true)).toBe(
      `${custom}\n\n${DEFAULT_NAI_NL_SPEC}`,
    );
    expect(expandNlMacro(custom, DEFAULT_NAI_NL_SPEC, false)).toBe(custom);
  });

  it('自定义规范写了 {{nl}} → 就地展开,不再追加', () => {
    expect(expandNlMacro('前{{nl}}后', 'NL-SPEC', true)).toBe('前NL-SPEC后');
    expect(expandNlMacro('前{{nl}}后', 'NL-SPEC', false)).toBe('前后');
  });

  it('自定义规范漏写 {{nl_example}} → 不做替换(示例缺失只是少个示范,不该凭空塞一份)', () => {
    expect(expandNaiSpec('我的规范正文', false)).toBe('我的规范正文');
  });
});
