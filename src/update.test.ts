import { describe, expect, it } from 'vitest';

import manifestRaw from '../manifest.json?raw';
import { isNewer, REMOTE_MANIFEST_URL } from './update';

describe('isNewer', () => {
  it('compares numeric version segments', () => {
    expect(isNewer('0.1.3', '0.1.2')).toBe(true);
    expect(isNewer('0.1', '0.1.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });
});

/**
 * 更新检查的远端地址必须和 manifest 的 homePage 指向**同一个仓库**。
 *
 * 本项目是 fork,更新只该跟自己的仓库比。这两个值分散在代码与 manifest 两处,
 * 漂了不会报错,只会静默地把更新功能废掉:fork 版本高于上游时「更新」按钮永不出现
 * (用户推了新版本却没法更新,已踩过一次),低于上游时点更新会覆盖掉本 fork 的改动。
 * 故用回归锁把两者钉在一起:改仓库地址时两处必须一起改。
 */
describe('更新地址与 manifest.homePage 同源', () => {
  const manifest = JSON.parse(manifestRaw) as { homePage?: string };

  it('homePage 是 GitHub 仓库页', () => {
    expect(manifest.homePage).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });

  it('远端 manifest 地址由 homePage 推导而来(raw.githubusercontent 同 owner/repo)', () => {
    const [, owner, repo] = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(
      manifest.homePage ?? '',
    ) ?? [];
    expect([owner, repo]).toBeTruthy();
    expect(REMOTE_MANIFEST_URL).toBe(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/manifest.json`,
    );
  });
});
