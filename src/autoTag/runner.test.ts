import { describe, expect, it, vi } from 'vitest';

// runner 会拉起 settings / api client 一整串模块,这里只需要那条纯策略函数,
// 把 ST 上下文置空即可安全导入(persist 等处都有 `ctx?.` 守卫)。
vi.mock('@/st/context', () => ({ getContext: () => null }));

import { missingProfileNlVerdict } from '@/autoTag/runner';

/**
 * 建档缺 nl 的处置策略。
 *
 * 这一条是爆炸半径的闸门:抛错只能用来换取**一次重试**,换不到重试时再抛就纯属破坏结果。
 * 曾经的写法是「缺 nl 一律抛错」,于是每一次尝试都被拒 → 重试耗尽 → 用户同时丢掉
 * 这一楼的全部图片与全部角色建档,而屏幕上只有一句「建档必须附带 nl 外貌描述」。
 */
describe('建档缺 nl 的处置策略', () => {
  it('还有重试机会 → 抛错,给模型一次补上 nl 的机会', () => {
    const error = missingProfileNlVerdict(1, false);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('NAI 4.5/V5 建档必须附带 nl 外貌描述');
  });

  it('多条建档都缺 → 同样只抛一次(重试单位是整次请求,不是单条建档)', () => {
    expect(missingProfileNlVerdict(5, false)).toBeInstanceOf(Error);
  });

  it('最后一次尝试 → 放行:不再为可选元数据作废整楼', () => {
    expect(missingProfileNlVerdict(1, true)).toBeNull();
    expect(missingProfileNlVerdict(5, true)).toBeNull();
  });

  it('没有缺 nl 的建档 → 放行', () => {
    expect(missingProfileNlVerdict(0, false)).toBeNull();
    expect(missingProfileNlVerdict(0, true)).toBeNull();
  });
});
