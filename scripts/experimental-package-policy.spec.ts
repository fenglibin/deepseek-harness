/** 实验包发布策略：目录判定、清单内容、以及注入自定义清单。 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isPrivateExperimentalPackageDirectory,
  isPublicExperimentalPackageDirectory,
  PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
} from './experimental-package-policy.ts'

const root = resolve(import.meta.dirname, '..')

/** 本地全部实验包目录，按路径排序。 */
function experimentalDirectories(): string[] {
  return PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES.map(directory => directory).sort()
}

/** 磁盘上真实的实验包目录，用于确认清单没有遗漏或多余项。 */
function discoveredDirectories(): string[] {
  return globSync('packages/experimental/*/package.json', { cwd: root })
    .map(path => path.replaceAll('\\', '/').slice(0, -'/package.json'.length))
    .sort()
}

describe('experimental package release policy', () => {
  it('declares every experimental package in this workspace as private', () => {
    expect(discoveredDirectories()).toEqual([
      'packages/experimental/agent-team',
      'packages/experimental/agent-team-profile',
      'packages/experimental/agent-team-web-profile',
      'packages/experimental/client-ui-agent-team',
      'packages/experimental/inspector',
      'packages/experimental/tool-agent-team',
      'packages/experimental/webworker-packer',
      'packages/experimental/webworker-runtime',
    ])
    // 清单是磁盘现状的完整镜像：漏登记一个包即让它按默认公开策略发布。
    expect(experimentalDirectories()).toEqual(discoveredDirectories())
  })

  it('treats no experimental package directory as public', () => {
    for (const directory of experimentalDirectories()) {
      expect(isPublicExperimentalPackageDirectory(directory)).toBe(false)
      expect(isPrivateExperimentalPackageDirectory(directory)).toBe(true)
    }
  })

  it.each([
    'packages/mcp/mcp-manager',
    'packages/experimental',
    'packages/experimental/agent-team/src',
    'apps/web',
    'vendor/cordis',
    '.',
  ])('reports the non-experimental directory %s as neither public nor private experimental', (directory) => {
    expect(isPublicExperimentalPackageDirectory(directory)).toBe(false)
    expect(isPrivateExperimentalPackageDirectory(directory)).toBe(false)
  })

  it('publishes an experimental package the injected list omits', () => {
    const injected = ['packages/experimental/inspector']

    expect(isPublicExperimentalPackageDirectory('packages/experimental/agent-team', injected)).toBe(true)
    expect(isPublicExperimentalPackageDirectory('packages/experimental/inspector', injected)).toBe(false)
    expect(isPrivateExperimentalPackageDirectory('packages/experimental/agent-team', injected)).toBe(false)
  })

  it('reads only the injected list, never the default one', () => {
    expect(isPublicExperimentalPackageDirectory('packages/experimental/agent-team', [])).toBe(true)
    expect(PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES).toContain('packages/experimental/agent-team')
  })

  it('keeps every experimental manifest private and free of publication metadata', () => {
    for (const directory of experimentalDirectories()) {
      const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')) as {
        private?: boolean
        publishConfig?: unknown
      }
      expect({ directory, private: manifest.private }).toEqual({ directory, private: true })
      expect({ directory, publishConfig: manifest.publishConfig }).toEqual({ directory, publishConfig: undefined })
    }
  })
})
