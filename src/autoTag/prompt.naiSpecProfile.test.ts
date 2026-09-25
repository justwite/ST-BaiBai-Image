import { describe, expect, it } from 'vitest';

import { autoTagProfileState, buildAutoTagMessages, requiresNewCharProfileNl } from '@/autoTag/prompt';
import { activeComfyPreset, settings, type AutoTagPrompts, type AutoTagSettings } from '@/state/settings';
import type { STContext } from '@/st/context';

/**
 * NAI 渠道的「规范口径 + 生成自然语言」两个开关如何落到自动 tag 请求里。
 *
 * 本文件盯的是一条不变式:**口径必须同时决定三件事**——
 * ① 拼进请求的规范文本、② 配对的思维链、③ 输出结构(NAI 口径出 Base + characters[],
 * comfy 口径出单串 tag)。任何一处单独变化都会组装出自相矛盾的请求:
 * 规范教单串 tag 而协议仍要 characters[],或者规范说 nl 必须写而示例里根本没有 nl 键。
 *
 * 自然语言开关则相反,它与口径**解耦**:关掉 nl 不该顺手把口径也换掉,切口径也不该
 * 替用户改开关——两次动作各归各,所以下面两个维度是分开跑的。
 */

function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    prefill: '',
    ...overrides,
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标第一行\n\n目标第三行' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

/** 各份规范/思维链的独有句,用来判断「这次到底用了哪一份」。 */
const MARK = {
  naiSpec: 'Map every image to one Base Prompt plus zero or more native Character Prompts.',
  naiNl: '- Every item in characters carries its own nl',
  comfySpec: '【ComfyUI 提示词规范】',
  comfyNl: 'nl（JSON 的 nl 键）：自然语言',
  /** newCharacterNlRule 的独有句:请求里要求「建档必须带 nl」时就该出现。 */
  newCharNlRule: 'every field:"new" change must include a non-empty nl',
} as const;

/** 只用自定义思维链标记做「选了哪一份」的判据:内置两份的开头太像,不如自造标记干净。 */
const THINKING = { comfy: 'COMFY-CHECKLIST', nai: 'NAIV5-CHECKLIST' } as const;

const options: AutoTagSettings = {
  enabled: true,
  contextMessages: 2,
  minImages: 0,
  maxImages: 2,
  retryCount: 1,
  autoGenerate: true,
  prompts: prompts({
    comfyThinking: THINKING.comfy,
    naiV5Thinking: THINKING.nai,
  }),
};

async function requestText(): Promise<string> {
  const messages = await buildAutoTagMessages(context(), 1, options, null);
  return messages.map(m => m.content).join('\n');
}

/**
 * 从固定协议里抠出 outputShape(「格式固定为：」后紧跟的那一行 JSON)并解析。
 * 用解析而不是字符串匹配来断言输出结构:键在不在、nl 有没有,读起来一目了然。
 */
function outputShape(text: string): {
  image: Record<string, unknown>;
  character: Record<string, unknown>;
} {
  const match = /格式固定为：\n(\{[^\n]*\})/.exec(text);
  if (!match) throw new Error('固定协议里没有找到 outputShape');
  const parsed = JSON.parse(match[1]) as { images: Record<string, unknown>[] };
  const image = parsed.images[0];
  const characters = (image.characters as Record<string, unknown>[] | undefined) ?? [{}];
  return { image, character: characters[0] };
}

/**
 * 改渠道级开关跑一段用例,跑完原样还原——settings 是同进程共享的单例,
 * 不还原会污染同批次其它用例(与本仓库既有测试同一口径)。
 * backend 缺省为 'nai'(本文件绝大多数用例都在 NAI 渠道上)。
 */
async function withSettings(
  patch: {
    backend?: 'nai' | 'comfyui' | 'webui';
    specProfile?: 'nai' | 'comfy';
    naturalLanguage?: boolean;
  },
  run: () => Promise<void>,
): Promise<void> {
  const oldBackend = settings.defaultBackend;
  const oldProfile = settings.nai.specProfile;
  const oldNl = settings.nai.naturalLanguage;
  try {
    settings.defaultBackend = patch.backend ?? 'nai';
    if (patch.specProfile !== undefined) settings.nai.specProfile = patch.specProfile;
    if (patch.naturalLanguage !== undefined) settings.nai.naturalLanguage = patch.naturalLanguage;
    await run();
  } finally {
    settings.defaultBackend = oldBackend;
    settings.nai.specProfile = oldProfile;
    settings.nai.naturalLanguage = oldNl;
  }
}

describe('NAI 渠道的规范口径与自然语言开关', () => {
  it('默认口径 = NAI:用 NAI 规范 + NAI 思维链,输出 Base + characters[] + nl', async () => {
    await withSettings({ specProfile: 'nai', naturalLanguage: true }, async () => {
      const text = await requestText();

      expect(text).toContain(MARK.naiSpec);
      expect(text).toContain(MARK.naiNl);
      expect(text).not.toContain(MARK.comfySpec);
      expect(text).not.toContain(MARK.comfyNl);
      // 规范与思维链同口径取用,不交叉
      expect(text).toContain(THINKING.nai);
      expect(text).not.toContain(THINKING.comfy);

      const { image, character } = outputShape(text);
      expect(image.nl).toBeTypeOf('string');
      expect(image.characters).toEqual([
        {
          name: '小雪',
          tag: 'girl, short black hair, blue eyes, white dress, waving',
          nl: 'The girl waves on the left side of the frame.',
        },
      ]);
      expect(character.name).toBe('小雪');
    });
  });

  it('NAI 口径关掉自然语言:规范不再要求 nl,示例与协议里也不留 nl 键', async () => {
    await withSettings({ specProfile: 'nai', naturalLanguage: false }, async () => {
      const text = await requestText();

      expect(text).toContain(MARK.naiSpec);
      // nl 条款与示例里的 nl 键必须一起消失:只关一半等于开关失效
      expect(text).not.toContain(MARK.naiNl);
      expect(text).toContain('must contain no nl');

      const { image, character } = outputShape(text);
      expect(image.tag).toBeTypeOf('string');
      expect('nl' in image).toBe(false);
      expect('nl' in character).toBe(false);
      // 结构仍是 NAI 原生的 characters[],只是不写 nl
      expect(image.characters).toEqual([
        {
          name: '小雪',
          tag: 'girl, short black hair, blue eyes, white dress, waving',
        },
      ]);
    });
  });

  it('口径切到 ComfyUI:规范与思维链成对换掉,输出结构退化为单串 tag', async () => {
    await withSettings({ specProfile: 'comfy', naturalLanguage: true }, async () => {
      const text = await requestText();

      expect(text).toContain(MARK.comfySpec);
      expect(text).toContain(MARK.comfyNl);
      expect(text).not.toContain(MARK.naiSpec);
      expect(text).not.toContain(MARK.naiNl);
      expect(text).toContain(THINKING.comfy);
      expect(text).not.toContain(THINKING.nai);

      // 借了 ComfyUI 的规范就必须借它的输出结构:单串 tag,没有 characters[]
      const { image } = outputShape(text);
      expect(image.tag).toBe('1girl, short black hair, white dress');
      expect(image.nl).toBe('A girl with short black hair wearing a white dress');
      expect('characters' in image).toBe(false);
    });
  });

  it('ComfyUI 口径 + 自然语言关:{{nl}} 展开为空,示例只剩 tag', async () => {
    await withSettings({ specProfile: 'comfy', naturalLanguage: false }, async () => {
      const text = await requestText();

      expect(text).toContain(MARK.comfySpec);
      expect(text).not.toContain(MARK.comfyNl);

      const { image } = outputShape(text);
      expect(image.tag).toBe('1girl, short black hair, white dress');
      expect('nl' in image).toBe(false);
      expect('characters' in image).toBe(false);
    });
  });

  it('自然语言开关按渠道各管各的:ComfyUI 渠道看工作流预设,不看 NAI 面板', async () => {
    const oldBackend = settings.defaultBackend;
    const oldNl = settings.nai.naturalLanguage;
    const preset = activeComfyPreset();
    const oldPresetNl = preset.naturalLanguage;
    try {
      settings.defaultBackend = 'comfyui';
      // NAI 面板上关着,ComfyUI 这边的开关在预设里,不应被牵连
      settings.nai.naturalLanguage = false;

      preset.naturalLanguage = true;
      const on = await requestText();
      expect(on).toContain(MARK.comfyNl);

      preset.naturalLanguage = false;
      const off = await requestText();
      expect(off).not.toContain(MARK.comfyNl);
    } finally {
      preset.naturalLanguage = oldPresetNl;
      settings.defaultBackend = oldBackend;
      settings.nai.naturalLanguage = oldNl;
    }
  });

  it('webui 渠道不附加任何规范,思维链仍回落 ComfyUI 那份(与改动前一致)', async () => {
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'webui';
      const text = await requestText();
      expect(text).not.toContain(MARK.naiSpec);
      expect(text).not.toContain(MARK.comfySpec);
      expect(text).toContain(THINKING.comfy);
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });
});

/**
 * 回归:NAI 渠道切到 ComfyUI 口径后,建档校验不能再拿 nl 卡人。
 *
 * 起因是一个真实的死锁 bug——`runner.ts` 的建档校验当时按
 * `defaultBackend === 'nai' && naiSupportsCharacterPrompts(model)` 判断要不要 nl,
 * 而请求侧的要求已经改成跟着**规范口径**走。于是 NAI 渠道切口径后:
 * 请求里不再要求建档 nl → 模型不给 nl → 校验判不合格 → 重试 → 耗尽,
 * 用户看到的就是「NAI 4.5/V5 建档必须附带 nl 外貌描述」反复刷屏。
 *
 * 下面这条用例不硬编码期望值,而是直接断言**两侧判据一致**:
 * 请求里出现了「建档必须带 nl」这条要求 ⟺ 校验会拿 nl 卡建档。
 * 这样任何一侧再被改动而另一侧没跟上,用例立刻红。
 */
describe('建档 nl 校验与请求要求同源', () => {
  it('三个渠道 × 口径 × nl 开关全组合:校验判据恒等于请求里是否要求建档 nl', async () => {
    const backends = ['nai', 'comfyui', 'webui'] as const;
    const profiles = ['nai', 'comfy'] as const;
    const askedCombos: string[] = [];
    for (const backend of backends) {
      for (const specProfile of profiles) {
        for (const naturalLanguage of [true, false]) {
          await withSettings({ backend, specProfile, naturalLanguage }, async () => {
            const text = await requestText();
            const asked = text.includes(MARK.newCharNlRule);
            const enforced = requiresNewCharProfileNl();
            if (asked) askedCombos.push(`${backend}/${specProfile}/${naturalLanguage}`);
            expect([backend, specProfile, naturalLanguage, enforced]).toEqual([
              backend,
              specProfile,
              naturalLanguage,
              asked,
            ]);
          });
        }
      }
    }
    // 矩阵确实全跑到(12 格),且要求建档 nl 的只有「NAI 渠道 + NAI 口径 + nl 开」这一格
    expect(askedCombos).toEqual(['nai/nai/true']);
  });

  it('复现原始故障:NAI 渠道 + ComfyUI 口径 → 校验放行不带 nl 的建档', async () => {
    await withSettings({ backend: 'nai', specProfile: 'comfy', naturalLanguage: true }, async () => {
      const text = await requestText();
      expect(text).not.toContain(MARK.newCharNlRule);
      expect(requiresNewCharProfileNl()).toBe(false);
    });
  });

  it('NAI 口径 + nl 开仍照旧卡:这条保护不能被顺手删掉', async () => {
    await withSettings({ backend: 'nai', specProfile: 'nai', naturalLanguage: true }, async () => {
      const text = await requestText();
      expect(text).toContain(MARK.newCharNlRule);
      expect(requiresNewCharProfileNl()).toBe(true);
    });
  });

  it('autoTagProfileState 三键与请求实际所用的一致(口径/characters 协议/nl)', async () => {
    await withSettings({ backend: 'nai', specProfile: 'comfy', naturalLanguage: true }, async () => {
      expect(autoTagProfileState()).toEqual({
        profile: 'comfy',
        naiCharPromptsOn: false,
        nlOn: true,
      });
    });
    await withSettings({ backend: 'nai', specProfile: 'nai', naturalLanguage: false }, async () => {
      expect(autoTagProfileState()).toEqual({
        profile: 'nai',
        naiCharPromptsOn: true,
        nlOn: false,
      });
    });
    await withSettings({ backend: 'webui', naturalLanguage: true }, async () => {
      // webui 不附加规范,所以哪怕 NAI 面板的开关开着也不要求 nl
      expect(autoTagProfileState()).toEqual({
        profile: 'none',
        naiCharPromptsOn: false,
        nlOn: false,
      });
    });
  });
});
