#!/usr/bin/env node
/**
 * Test driver: boot the response-language Loader composition and persist the
 * assembled model-visible system prompt to `./response-language-report.json`
 * for the package spec's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('response-language driver requires a config path')

const ctx = await boot('response-language-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const assembly = await ctx.systemPrompt.assemble()
  await writeFile('./response-language-report.json', JSON.stringify({
    rendered: renderPrompt(assembly),
    sectionNames: assembly.sections.map(section => section.name),
  }))
} finally {
  await ctx.fiber.dispose()
}
