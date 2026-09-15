/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspaceManifest,
  expectedDshPackageFiles,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'
import { PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES } from './experimental-package-policy.ts'

const privateDirectory = 'packages/experimental/prototype'
const experimental: WorkspaceManifest = {
  dir: privateDirectory,
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}
/** 含 fixture 目录的私有清单，使私有支用例与仓库实际清单内容无关。 */
const privateList: readonly string[] = [...PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES, privateDirectory]

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    }, privateList)).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('reports a missing prefix regardless of the release policy', () => {
    const prefixError
      = '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"'
    const unprefixed = '@deepseek-ai/dsh-prototype'

    // 两种策略下都只报命名：前者走私密支，后者走公开支。
    expect(checkExperimentalManifest({ dir: privateDirectory, manifest: { name: unprefixed, private: true } }, privateList))
      .toEqual([prefixError])
    expect(checkExperimentalManifest({ dir: privateDirectory, manifest: { name: unprefixed, publishConfig: { access: 'public' } } }, []))
      .toEqual([prefixError])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental, privateList)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    }, privateList)).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it('requires publication metadata from an experimental package the policy publishes', () => {
    // 私有清单不含该包时它按公开策略发布：要求去掉 private，并声明公开访问。
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { name: '@deepseek-ai/dsh-experimental-prototype' },
    }, [])).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: public experimental package must set publishConfig.access to "public"',
    ])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, publishConfig: { access: 'public' } },
    }, [])).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: public experimental package must not set "private": true',
    ])
  })

  it('applies the private branch to every experimental package of this workspace', () => {
    for (const directory of PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES) {
      const name = `@deepseek-ai/dsh-experimental-${directory.split('/').pop()}`
      expect({ directory, errors: checkExperimentalManifest({ dir: directory, manifest: { name, private: true } }) })
        .toEqual({ directory, errors: [] })
    }
  })

  it('never treats a private experimental package as a release member', () => {
    // release member 要求 publishConfig.access === 'public'；私有实验包走了
    // 私密支，因此不出现该条报告，也不出现"release member must not set private"。
    const errors = checkWorkspaceManifest({
      dir: 'packages/experimental/agent-team',
      manifest: { name: '@deepseek-ai/dsh-experimental-agent-team', private: true },
    })

    expect(errors.filter(error => error.includes('release member'))).toEqual([])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('package payload constraints', () => {
  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })
})
